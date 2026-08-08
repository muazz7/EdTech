import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import {
  courses,
  entitlements,
  getDb,
  payments,
  paymentMethods,
  plans,
  profiles,
} from '@edtech/db';
import { ApiError, ERROR_CODES, RATE_LIMITS } from '@edtech/shared';
import { recordAudit } from '../audit/log.js';
import { enforceRate } from '../rate-limit/limiter.js';
import type { Actor } from '../content/ownership.js';

/**
 * Manual payment submission and verification (Section 8).
 *
 * Teachers review payments for their own courses; the Owner reviews
 * platform-wide plans, which span every teacher's catalog. Admin sees
 * everything.
 */

// ── Student: submit proof ───────────────────────────────────────────────────

export type SubmitProofInput = {
  referenceCode: string;
  channel: 'bkash' | 'nagad' | 'rocket' | 'bank' | 'cash' | 'other';
  senderNumber: string;
  transactionId: string;
  proofKey?: string | null;
  paymentMethodId?: string | null;
  studentNote?: string | null;
};

export async function submitPaymentProof(studentId: string, input: SubmitProofInput) {
  await enforceRate('payment-submit', studentId, RATE_LIMITS.paymentSubmissionPerUser);

  const db = getDb();
  const payment = await db.query.payments.findFirst({
    where: eq(payments.referenceCode, input.referenceCode.trim().toUpperCase()),
  });

  if (!payment || payment.studentId !== studentId) {
    throw new ApiError(
      404,
      ERROR_CODES.PAYMENT_REFERENCE_UNKNOWN,
      'That reference code does not match any of your payments.',
    );
  }
  if (payment.status !== 'pending') {
    throw new ApiError(
      409,
      ERROR_CODES.PAYMENT_NOT_PENDING,
      payment.status === 'verified'
        ? 'This payment was already approved.'
        : 'This payment is no longer open. Start a new purchase.',
    );
  }

  try {
    const [updated] = await db
      .update(payments)
      .set({
        channel: input.channel,
        senderNumber: input.senderNumber.trim(),
        transactionId: input.transactionId.trim().toUpperCase(),
        // Absent fields keep their current value rather than being nulled.
        // A student correcting a typo in their transaction ID resubmits the
        // form, and `?? null` here would silently erase the screenshot they
        // uploaded on the first attempt — destroying the teacher's evidence
        // and the student's own proof in a dispute.
        ...(input.proofKey !== undefined ? { proofR2Key: input.proofKey } : {}),
        ...(input.paymentMethodId !== undefined
          ? { paymentMethodId: input.paymentMethodId }
          : {}),
        ...(input.studentNote !== undefined ? { studentNote: input.studentNote } : {}),
        submittedAt: sql`now()`,
      })
      .where(eq(payments.id, payment.id))
      .returning();

    if (!updated) throw new ApiError(500, ERROR_CODES.INTERNAL);
    return updated;
  } catch (err) {
    // uniq_channel_txid: the same transaction ID cannot be claimed twice on a
    // channel. This is a database guarantee, not an application check, and it
    // must surface as a clear error rather than a 500 (Section 8.1).
    const message = err instanceof Error ? err.message : '';
    if (message.includes('uniq_channel_txid')) {
      throw new ApiError(409, ERROR_CODES.DUPLICATE_TRANSACTION_ID);
    }
    throw err;
  }
}

// ── Reviewer: queue ─────────────────────────────────────────────────────────

/**
 * A teacher sees payments for their own courses. An admin sees everything,
 * including plan payments, which carry no reviewer.
 */
export async function listPaymentQueue(
  actor: Actor,
  status: 'pending' | 'verified' | 'rejected' | 'expired' = 'pending',
) {
  const db = getDb();

  const scope =
    actor.role === 'admin'
      ? eq(payments.status, status)
      : and(eq(payments.status, status), eq(payments.reviewerId, actor.userId));

  return db
    .select({
      id: payments.id,
      referenceCode: payments.referenceCode,
      amountPoisha: payments.amountPoisha,
      channel: payments.channel,
      senderNumber: payments.senderNumber,
      transactionId: payments.transactionId,
      proofR2Key: payments.proofR2Key,
      studentNote: payments.studentNote,
      submittedAt: payments.submittedAt,
      status: payments.status,
      rejectionReason: payments.rejectionReason,
      studentId: profiles.id,
      studentName: profiles.fullName,
      studentPhone: profiles.phone,
      courseId: payments.courseId,
      courseTitle: courses.title,
      planId: payments.planId,
      planName: plans.name,
      methodNumber: paymentMethods.accountNumber,
    })
    .from(payments)
    .innerJoin(profiles, eq(profiles.id, payments.studentId))
    .leftJoin(courses, eq(courses.id, payments.courseId))
    .leftJoin(plans, eq(plans.id, payments.planId))
    .leftJoin(paymentMethods, eq(paymentMethods.id, payments.paymentMethodId))
    .where(scope)
    // Oldest first: the student who has waited longest is served first, and
    // the SLA in Section 8.1 is measured from submission.
    .orderBy(status === 'pending' ? asc(payments.submittedAt) : desc(payments.submittedAt))
    .limit(200);
}

/** Throws unless this actor may act on this payment. */
async function requireReviewable(actor: Actor, paymentId: string) {
  const db = getDb();
  const payment = await db.query.payments.findFirst({ where: eq(payments.id, paymentId) });

  if (!payment) throw new ApiError(404, ERROR_CODES.NOT_FOUND, 'Payment not found.');

  if (actor.role !== 'admin') {
    // A teacher may only touch payments routed to them. 404, not 403, so the
    // payment id space cannot be probed for other teachers' revenue.
    if (payment.reviewerId !== actor.userId) {
      throw new ApiError(404, ERROR_CODES.NOT_FOUND, 'Payment not found.');
    }
  }

  if (payment.status !== 'pending') {
    throw new ApiError(
      409,
      ERROR_CODES.PAYMENT_NOT_PENDING,
      `This payment is already ${payment.status}.`,
    );
  }

  return payment;
}

// ── Reviewer: approve ───────────────────────────────────────────────────────

/**
 * Approve (Section 8.2). One transaction: verify the payment, issue the
 * entitlement, write the audit row.
 *
 * If any step fails the whole thing rolls back. A payment marked verified
 * without its entitlement means a student who paid and cannot watch, which is
 * the single worst outcome in this product.
 */
export async function approvePayment(actor: Actor, paymentId: string, ipAddress?: string | null) {
  const payment = await requireReviewable(actor, paymentId);
  const db = getDb();

  if (!payment.transactionId) {
    throw new ApiError(
      409,
      ERROR_CODES.CONFLICT,
      'This student has not submitted their transaction details yet.',
    );
  }

  const plan = payment.planId
    ? await db.query.plans.findFirst({ where: eq(plans.id, payment.planId) })
    : null;

  if (payment.planId && !plan) {
    throw new ApiError(404, ERROR_CODES.NOT_FOUND, 'The plan for this payment no longer exists.');
  }

  const kind = plan ? plan.kind : ('single_course' as const);

  /**
   * Renewal stacking (Section 8.2): a student renewing on day 25 of a 30-day
   * subscription must end up with 35 days remaining, not 30. Starting the new
   * period at the old expiry rather than now is what does that. Getting it
   * wrong generates support messages nobody has time for.
   */
  let startsAt = new Date();
  if (kind === 'subscription') {
    const active = await db
      .select({ expiresAt: entitlements.expiresAt })
      .from(entitlements)
      .where(
        and(
          eq(entitlements.studentId, payment.studentId),
          eq(entitlements.kind, 'subscription'),
          isNull(entitlements.revokedAt),
        ),
      )
      .orderBy(desc(entitlements.expiresAt))
      .limit(1);

    const latest = active[0]?.expiresAt;
    if (latest && latest.getTime() > startsAt.getTime()) startsAt = latest;
  }

  const expiresAt =
    kind === 'subscription' && plan?.durationDays
      ? new Date(startsAt.getTime() + plan.durationDays * 24 * 60 * 60 * 1000)
      : null;

  const entitlementId = uuidv7();

  await db.transaction(async (tx) => {
    const updated = await tx
      .update(payments)
      .set({
        status: 'verified',
        reviewedBy: actor.userId,
        reviewedAt: sql`now()`,
      })
      // Re-check status inside the transaction: two reviewers hitting approve
      // at once would otherwise issue two entitlements for one payment.
      .where(and(eq(payments.id, paymentId), eq(payments.status, 'pending')))
      .returning({ id: payments.id });

    if (updated.length === 0) {
      throw new ApiError(409, ERROR_CODES.PAYMENT_NOT_PENDING, 'This payment was already reviewed.');
    }

    await tx.insert(entitlements).values({
      id: entitlementId,
      studentId: payment.studentId,
      kind,
      // The CHECK constraint requires course_id set iff kind is single_course.
      courseId: kind === 'single_course' ? payment.courseId : null,
      planId: payment.planId,
      paymentId: payment.id,
      source: 'purchase',
      grantedBy: actor.userId,
      startsAt,
      expiresAt,
    });

    await recordAudit(
      {
        actorId: actor.userId,
        action: 'payment.approve',
        entityType: 'payment',
        entityId: paymentId,
        before: { status: 'pending' },
        after: {
          status: 'verified',
          entitlementId,
          kind,
          amountPoisha: payment.amountPoisha,
          expiresAt,
        },
        ipAddress,
      },
      tx,
    );
  });

  return { paymentId, entitlementId, kind, startsAt, expiresAt };
}

// ── Reviewer: reject ────────────────────────────────────────────────────────

export const REJECTION_REASONS = [
  'wrong_amount',
  'unreadable_proof',
  'duplicate',
  'not_received',
  'other',
] as const;

export type RejectionReason = (typeof REJECTION_REASONS)[number];

export async function rejectPayment(
  actor: Actor,
  paymentId: string,
  reason: RejectionReason,
  note?: string | null,
  ipAddress?: string | null,
) {
  await requireReviewable(actor, paymentId);
  const db = getDb();

  if (reason === 'other' && !note?.trim()) {
    // "Rejected: other" tells the student nothing and guarantees a support
    // message, so a note is required for it.
    throw new ApiError(
      422,
      ERROR_CODES.VALIDATION_FAILED,
      'Add a note explaining the rejection.',
    );
  }

  const [updated] = await db
    .update(payments)
    .set({
      status: 'rejected',
      reviewedBy: actor.userId,
      reviewedAt: sql`now()`,
      rejectionReason: note?.trim() ? `${reason}: ${note.trim()}` : reason,
    })
    .where(and(eq(payments.id, paymentId), eq(payments.status, 'pending')))
    .returning();

  if (!updated) {
    throw new ApiError(409, ERROR_CODES.PAYMENT_NOT_PENDING, 'This payment was already reviewed.');
  }

  await recordAudit({
    actorId: actor.userId,
    action: 'payment.reject',
    entityType: 'payment',
    entityId: paymentId,
    after: { status: 'rejected', reason: updated.rejectionReason },
    ipAddress,
  });

  return updated;
}

/** A student's own payment history (Section 18: GET /me/payments). */
export async function listMyPayments(studentId: string) {
  const db = getDb();
  return db
    .select({
      id: payments.id,
      referenceCode: payments.referenceCode,
      amountPoisha: payments.amountPoisha,
      status: payments.status,
      channel: payments.channel,
      transactionId: payments.transactionId,
      rejectionReason: payments.rejectionReason,
      submittedAt: payments.submittedAt,
      reviewedAt: payments.reviewedAt,
      courseTitle: courses.title,
      planName: plans.name,
    })
    .from(payments)
    .leftJoin(courses, eq(courses.id, payments.courseId))
    .leftJoin(plans, eq(plans.id, payments.planId))
    .where(eq(payments.studentId, studentId))
    .orderBy(desc(payments.createdAt))
    .limit(100);
}
