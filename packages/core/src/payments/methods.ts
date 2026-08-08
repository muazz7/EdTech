import { and, asc, eq, sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { getDb, paymentMethods } from '@edtech/db';
import { ApiError, ERROR_CODES } from '@edtech/shared';
import { recordAudit } from '../audit/log.js';
import type { Actor } from '../content/ownership.js';

/**
 * A teacher's own bKash / Nagad / Rocket numbers.
 *
 * Money moves student -> teacher directly and never transits the platform, so
 * these numbers are the whole payment rail. An Owner-owned set is used for
 * platform-wide plans, which span every teacher's catalog and therefore cannot
 * belong to any single teacher.
 */

export type PaymentMethodInput = {
  channel: 'bkash' | 'nagad' | 'rocket' | 'bank' | 'cash' | 'other';
  accountNumber: string;
  accountType?: string | null;
  accountLabel?: string | null;
  instructions?: string | null;
};

/** Digits only for mobile wallets. A number with spaces or dashes is copied
 *  wrong by a student in a hurry, and a wrong send is unrecoverable. */
function normaliseAccountNumber(channel: string, raw: string): string {
  const trimmed = raw.trim();
  if (channel === 'bank' || channel === 'other') return trimmed;

  const digits = trimmed.replace(/[\s-]/g, '');
  if (!/^(?:\+?880|0)1[3-9]\d{8}$/.test(digits)) {
    throw new ApiError(
      422,
      ERROR_CODES.VALIDATION_FAILED,
      'Enter a valid Bangladeshi mobile number, e.g. 01712345678.',
    );
  }
  // Local form: this is displayed for a student to type into a wallet app,
  // which expects 01XXXXXXXXX rather than +880.
  return `0${digits.replace(/^\+?880/, '').replace(/^0/, '')}`;
}

export async function listMyPaymentMethods(actor: Actor) {
  const db = getDb();
  return db
    .select()
    .from(paymentMethods)
    .where(eq(paymentMethods.ownerId, actor.userId))
    .orderBy(asc(paymentMethods.displayOrder), asc(paymentMethods.createdAt));
}

/** Methods a student should be shown for a given reviewer. Active only — a
 *  deactivated number must never be paid into. */
export async function listPayableMethods(ownerId: string) {
  const db = getDb();
  return db
    .select({
      id: paymentMethods.id,
      channel: paymentMethods.channel,
      accountNumber: paymentMethods.accountNumber,
      accountType: paymentMethods.accountType,
      accountLabel: paymentMethods.accountLabel,
      instructions: paymentMethods.instructions,
    })
    .from(paymentMethods)
    .where(and(eq(paymentMethods.ownerId, ownerId), eq(paymentMethods.isActive, true)))
    .orderBy(asc(paymentMethods.displayOrder));
}

export async function createPaymentMethod(actor: Actor, input: PaymentMethodInput) {
  const db = getDb();
  const accountNumber = normaliseAccountNumber(input.channel, input.accountNumber);

  const existing = await db.query.paymentMethods.findFirst({
    where: and(
      eq(paymentMethods.ownerId, actor.userId),
      eq(paymentMethods.channel, input.channel),
      eq(paymentMethods.accountNumber, accountNumber),
      eq(paymentMethods.isActive, true),
    ),
  });
  if (existing) {
    throw new ApiError(
      409,
      ERROR_CODES.CONFLICT,
      'You have already added that number for this channel.',
    );
  }

  const rows = await db
    .select({ order: paymentMethods.displayOrder })
    .from(paymentMethods)
    .where(eq(paymentMethods.ownerId, actor.userId));

  const [created] = await db
    .insert(paymentMethods)
    .values({
      id: uuidv7(),
      ownerId: actor.userId,
      channel: input.channel,
      accountNumber,
      accountType: input.accountType ?? null,
      accountLabel: input.accountLabel ?? null,
      instructions: input.instructions ?? null,
      displayOrder: rows.reduce((max, r) => Math.max(max, r.order), 0) + 1,
    })
    .returning();

  if (!created) throw new ApiError(500, ERROR_CODES.INTERNAL);

  // Auditing this matters: a changed receiving number is the single most
  // valuable thing an attacker could alter, and the trail is how it is caught.
  await recordAudit({
    actorId: actor.userId,
    action: 'payment_method.create',
    entityType: 'payment_method',
    entityId: created.id,
    after: { channel: created.channel, accountNumber: created.accountNumber },
  });

  return created;
}

export async function updatePaymentMethod(
  actor: Actor,
  methodId: string,
  input: Partial<PaymentMethodInput> & { isActive?: boolean },
) {
  const db = getDb();
  const before = await db.query.paymentMethods.findFirst({
    where: eq(paymentMethods.id, methodId),
  });

  // 404 rather than 403 for someone else's row, so the id space cannot be
  // probed.
  if (!before || (actor.role !== 'admin' && before.ownerId !== actor.userId)) {
    throw new ApiError(404, ERROR_CODES.NOT_FOUND, 'Payment method not found.');
  }

  const patch: Record<string, unknown> = { updatedAt: sql`now()` };
  if (input.accountNumber !== undefined) {
    patch.accountNumber = normaliseAccountNumber(input.channel ?? before.channel, input.accountNumber);
  }
  for (const key of ['accountType', 'accountLabel', 'instructions', 'isActive'] as const) {
    if (input[key] !== undefined) patch[key] = input[key];
  }

  const [updated] = await db
    .update(paymentMethods)
    .set(patch)
    .where(eq(paymentMethods.id, methodId))
    .returning();

  if (!updated) throw new ApiError(500, ERROR_CODES.INTERNAL);

  await recordAudit({
    actorId: actor.userId,
    action: 'payment_method.update',
    entityType: 'payment_method',
    entityId: methodId,
    before: { accountNumber: before.accountNumber, isActive: before.isActive },
    after: { accountNumber: updated.accountNumber, isActive: updated.isActive },
  });

  return updated;
}

/**
 * Deactivates rather than deletes.
 *
 * A payment row references the method it was shown against, and a student
 * disputing "you told me to send to this number" needs that record to still
 * exist. Hard deletion would erase the evidence.
 */
export async function deactivatePaymentMethod(actor: Actor, methodId: string) {
  return updatePaymentMethod(actor, methodId, { isActive: false });
}
