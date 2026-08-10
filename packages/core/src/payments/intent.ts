import { randomBytes } from 'node:crypto';
import { and, eq, gt, isNull, or, sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { courses, entitlements, getDb, payments, plans, profiles } from '@edtech/db';
import {
  ApiError,
  ERROR_CODES,
  PAYMENT_REFERENCE_PREFIX,
  PAYMENT_VERIFICATION_SLA_HOURS,
} from '@edtech/shared';
import { listPayableMethods } from './methods.js';
import { reservePromoCode } from '../commerce/promo.js';

/**
 * Payment intent (Section 8.1).
 *
 * The reference code is generated BEFORE the student pays and they are told to
 * put it in the wallet's reference field. That is what turns reconciliation
 * from guesswork into a lookup — without it a teacher is matching amounts and
 * timestamps by eye at 11pm.
 */

/**
 * Ambiguous characters are excluded on purpose. This code is read off a screen
 * and typed into a phone keypad under time pressure; O/0 and I/1 confusion
 * costs a rejected payment and a support message.
 */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function generateCode(): string {
  const bytes = randomBytes(6);
  let code = '';
  for (const byte of bytes) code += CODE_ALPHABET[byte % CODE_ALPHABET.length];
  return `${PAYMENT_REFERENCE_PREFIX}${code}`;
}

export type PaymentIntent = {
  paymentId: string;
  referenceCode: string;
  amountPoisha: number;
  /** What the price was before a promo code, and what the code took off. */
  originalPoisha: number;
  discountPoisha: number;
  promoCode: string | null;
  currency: string;
  target: { kind: 'single_course'; courseId: string; title: string } | { kind: 'plan'; planId: string; title: string };
  methods: Awaited<ReturnType<typeof listPayableMethods>>;
  verificationSlaHours: number;
  expiresInDays: number;
  /**
   * True when a promo code covered the whole price. There is nothing to pay and
   * nothing to prove, so the entitlement is already granted and the payment
   * recorded as verified — the client should go straight to the course rather
   * than showing instructions for a 0 BDT transfer.
   */
  settled: boolean;
};

/** Who reviews this payment: the owning teacher for a course, the Owner for a
 *  platform-wide plan (it spans every teacher's catalog, so no one teacher can
 *  collect for it). */
async function resolveReviewer(target:
  | { kind: 'course'; courseId: string }
  | { kind: 'plan'; planId: string },
): Promise<{ reviewerId: string | null; payTo: string }> {
  const db = getDb();

  if (target.kind === 'course') {
    const course = await db.query.courses.findFirst({
      where: eq(courses.id, target.courseId),
      columns: { teacherId: true },
    });
    if (!course) throw new ApiError(404, ERROR_CODES.NOT_FOUND, 'Course not found.');
    return { reviewerId: course.teacherId, payTo: course.teacherId };
  }

  const admin = await db.query.profiles.findFirst({
    where: and(eq(profiles.role, 'admin'), eq(profiles.isActive, true)),
    columns: { id: true },
  });
  if (!admin) {
    throw new ApiError(
      503,
      ERROR_CODES.INTERNAL,
      'Plan purchases are not available yet. Contact support.',
    );
  }
  return { reviewerId: null, payTo: admin.id };
}

async function hasActiveEntitlementFor(studentId: string, courseId: string): Promise<boolean> {
  const db = getDb();
  const now = new Date();
  const rows = await db
    .select({ kind: entitlements.kind, courseId: entitlements.courseId })
    .from(entitlements)
    .where(
      and(
        eq(entitlements.studentId, studentId),
        isNull(entitlements.revokedAt),
        or(isNull(entitlements.expiresAt), gt(entitlements.expiresAt, now)),
      ),
    );
  return rows.some((r) => r.kind === 'single_course' && r.courseId === courseId);
}

export async function createPaymentIntent(
  studentId: string,
  input: { courseId?: string; planId?: string; promoCode?: string },
): Promise<PaymentIntent> {
  if (Boolean(input.courseId) === Boolean(input.planId)) {
    throw new ApiError(
      422,
      ERROR_CODES.VALIDATION_FAILED,
      'Choose either a course or a plan, not both.',
    );
  }

  // A promo code is one teacher discounting their own course. Platform-wide
  // plans span every teacher's catalog, so no teacher's code may touch them.
  if (input.promoCode && !input.courseId) {
    throw new ApiError(
      422,
      ERROR_CODES.VALIDATION_FAILED,
      'Promo codes apply to individual courses, not to plans.',
    );
  }

  const db = getDb();

  let amountPoisha: number;
  let target: PaymentIntent['target'];
  let reviewer: { reviewerId: string | null; payTo: string };
  let promo: { promoCodeId: string; discountPoisha: number } | null = null;

  if (input.courseId) {
    const course = await db.query.courses.findFirst({
      where: eq(courses.id, input.courseId),
      columns: { id: true, title: true, pricePoisha: true, state: true },
    });
    if (!course || course.state !== 'published') {
      throw new ApiError(404, ERROR_CODES.NOT_FOUND, 'Course not found.');
    }
    if (course.pricePoisha <= 0) {
      throw new ApiError(
        422,
        ERROR_CODES.VALIDATION_FAILED,
        'This course is free — no payment is needed.',
      );
    }
    if (await hasActiveEntitlementFor(studentId, course.id)) {
      throw new ApiError(409, ERROR_CODES.CONFLICT, 'You already have access to this course.');
    }

    amountPoisha = course.pricePoisha;

    if (input.promoCode) {
      // Reserved under a row lock, so two students racing for the last slot of
      // a limited code cannot both take it.
      const reserved = await reservePromoCode(studentId, {
        code: input.promoCode,
        courseId: course.id,
      });
      promo = { promoCodeId: reserved.promoCodeId, discountPoisha: reserved.discountPoisha };
      amountPoisha = reserved.finalPoisha;
    }

    target = { kind: 'single_course', courseId: course.id, title: course.title };
    reviewer = await resolveReviewer({ kind: 'course', courseId: course.id });
  } else {
    const plan = await db.query.plans.findFirst({
      where: eq(plans.id, input.planId!),
    });
    if (!plan || !plan.isActive) {
      throw new ApiError(404, ERROR_CODES.NOT_FOUND, 'Plan not found.');
    }

    amountPoisha = plan.pricePoisha;
    target = { kind: 'plan', planId: plan.id, title: plan.name };
    reviewer = await resolveReviewer({ kind: 'plan', planId: plan.id });
  }

  const methods = await listPayableMethods(reviewer.payTo);
  if (methods.length === 0) {
    // Better a clear message than a payment instruction screen with no number
    // on it, which reads as a broken product.
    throw new ApiError(
      503,
      ERROR_CODES.UPSTREAM_FAILED,
      'This teacher has not set up a payment number yet. Contact support.',
    );
  }

  // Reuse an existing pending intent for the same target rather than minting a
  // second reference code. A student who reloads the instructions page must not
  // end up with two codes and no idea which one they wrote down.
  const existing = await db.query.payments.findFirst({
    where: and(
      eq(payments.studentId, studentId),
      eq(payments.status, 'pending'),
      input.courseId ? eq(payments.courseId, input.courseId) : eq(payments.planId, input.planId!),
      isNull(payments.transactionId),
    ),
  });

  if (existing) {
    return {
      paymentId: existing.id,
      referenceCode: existing.referenceCode,
      amountPoisha: existing.amountPoisha,
      originalPoisha: existing.amountPoisha + existing.discountPoisha,
      discountPoisha: existing.discountPoisha,
      promoCode: null,
      currency: existing.currency,
      target,
      methods,
      verificationSlaHours: Number(
        process.env.PAYMENT_VERIFICATION_SLA_HOURS ?? PAYMENT_VERIFICATION_SLA_HOURS,
      ),
      expiresInDays: 7,
      settled: false,
    };
  }

  const paymentId = uuidv7();
  const referenceCode = await insertWithUniqueCode(async (code) => {
    const [row] = await db
      .insert(payments)
      .values({
        id: paymentId,
        referenceCode: code,
        studentId,
        planId: input.planId ?? null,
        courseId: input.courseId ?? null,
        reviewerId: reviewer.reviewerId,
        // Locked here. A price change afterwards must not alter what this
        // student owes (ADR 0002).
        amountPoisha,
        // The discount is already inside amountPoisha. Both are kept so a
        // dispute can be settled against the original price and the code that
        // changed it.
        promoCodeId: promo?.promoCodeId ?? null,
        discountPoisha: promo?.discountPoisha ?? 0,
        // Channel is chosen at submission; 'other' is a placeholder that the
        // student's actual choice overwrites.
        channel: 'other',
        status: 'pending',
      })
      .returning({ referenceCode: payments.referenceCode });
    return row?.referenceCode;
  });

  // A code that covers the whole price leaves nothing to transfer and nothing
  // to prove, so the manual verification step is meaningless. Settle it here:
  // mark the payment verified and grant access immediately.
  let settled = false;
  if (amountPoisha === 0 && promo && input.courseId) {
    await db.transaction(async (tx) => {
      await tx
        .update(payments)
        .set({ status: 'verified', reviewedAt: sql`now()` })
        .where(eq(payments.id, paymentId));

      await tx.insert(entitlements).values({
        id: uuidv7(),
        studentId,
        kind: 'single_course',
        courseId: input.courseId!,
        paymentId,
        source: 'promo',
        startsAt: new Date(),
      });
    });
    settled = true;
  }

  return {
    paymentId,
    referenceCode,
    amountPoisha,
    originalPoisha: amountPoisha + (promo?.discountPoisha ?? 0),
    discountPoisha: promo?.discountPoisha ?? 0,
    promoCode: input.promoCode?.trim().toUpperCase() ?? null,
    currency: 'BDT',
    target,
    methods,
    verificationSlaHours: Number(
      process.env.PAYMENT_VERIFICATION_SLA_HOURS ?? PAYMENT_VERIFICATION_SLA_HOURS,
    ),
    expiresInDays: 7,
    settled,
  };
}

/** Retries on the reference_code unique index. Six characters from a 32-symbol
 *  alphabet is ~10^9 combinations, so a collision is rare but not impossible,
 *  and a 500 on the purchase path is the worst place to discover that. */
async function insertWithUniqueCode(
  attempt: (code: string) => Promise<string | undefined>,
): Promise<string> {
  for (let tries = 0; tries < 5; tries++) {
    const code = generateCode();
    try {
      const result = await attempt(code);
      if (result) return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : '';
      if (!message.includes('reference_code')) throw err;
    }
  }
  throw new ApiError(500, ERROR_CODES.INTERNAL, 'Could not create a payment reference.');
}

/** Marks stale pending payments expired (Section 8.1: 7 days). Driven by cron. */
export async function expireStalePayments(): Promise<{ expired: number }> {
  const db = getDb();
  const rows = await db
    .update(payments)
    .set({ status: 'expired' })
    .where(
      and(
        eq(payments.status, 'pending'),
        sql`${payments.submittedAt} < now() - interval '7 days'`,
      ),
    )
    .returning({ id: payments.id });
  return { expired: rows.length };
}
