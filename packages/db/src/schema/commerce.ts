import { sql } from 'drizzle-orm';
import {
  boolean,
  char,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { entitlementSource, paymentChannel, paymentStatus, planKind } from './enums.js';
import { courses } from './content.js';
import { profiles } from './identity.js';

export const plans = pgTable('plans', {
  id: uuid('id').primaryKey(),
  kind: planKind('kind').notNull(),
  name: text('name').notNull(), // "Monthly All-Access"
  description: text('description'),
  pricePoisha: integer('price_poisha').notNull(),
  /** 30 for monthly; NULL = forever. */
  durationDays: integer('duration_days'),
  isActive: boolean('is_active').notNull().default(true),
  displayOrder: integer('display_order').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * ONE table for all three access models. This is deliberate: the entitlement
 * check becomes a single query with no branching, and a student can hold
 * several simultaneously (an expired subscription plus a lifetime
 * single-course purchase) without any special-case code.
 */
export const entitlements = pgTable(
  'entitlements',
  {
    id: uuid('id').primaryKey(),
    studentId: uuid('student_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    kind: planKind('kind').notNull(),
    /** Only for single_course. */
    courseId: uuid('course_id').references(() => courses.id, { onDelete: 'cascade' }),
    planId: uuid('plan_id').references(() => plans.id),
    /** FK to payments added in migration 0003 — circular reference. */
    paymentId: uuid('payment_id'),
    source: entitlementSource('source').notNull().default('purchase'),
    grantedBy: uuid('granted_by').references(() => profiles.id),
    startsAt: timestamp('starts_at', { withTimezone: true }).notNull().defaultNow(),
    /** NULL = lifetime. */
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokedReason: text('revoked_reason'),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      'single_course_needs_course',
      sql`(${t.kind} = 'single_course') = (${t.courseId} IS NOT NULL)`,
    ),
    check(
      'lifetime_has_no_expiry',
      sql`${t.kind} = 'subscription' OR ${t.expiresAt} IS NULL`,
    ),
    index('entitlements_student_live_idx').on(t.studentId).where(sql`revoked_at IS NULL`),
    index('entitlements_expiry_idx')
      .on(t.expiresAt)
      .where(sql`revoked_at IS NULL AND expires_at IS NOT NULL`),
    index('entitlements_course_idx').on(t.courseId).where(sql`kind = 'single_course'`),
  ],
);

export const payments = pgTable(
  'payments',
  {
    id: uuid('id').primaryKey(),
    /** Shown to the student and put in the mobile-money reference field, so
     *  reconciliation is a lookup rather than guesswork. Generated *before*
     *  the student pays. */
    referenceCode: text('reference_code').notNull().unique(), // "PAY-8FK2QX"
    studentId: uuid('student_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    planId: uuid('plan_id').references(() => plans.id),
    courseId: uuid('course_id').references(() => courses.id),

    /**
     * Who must review this payment.
     *
     * Denormalized from courses.teacher_id so the verification queue is a
     * single indexed read rather than a join, and so a later course transfer
     * cannot silently move an already-submitted payment into another
     * teacher's queue.
     *
     * NULL means a platform-wide plan (subscription / lifetime_all), which
     * spans every teacher's catalog and is therefore the Owner's to verify.
     */
    reviewerId: uuid('reviewer_id').references(() => profiles.id),

    /** Which number the student was told to send to. Kept so a dispute can be
     *  settled against what was actually shown at the time. */
    paymentMethodId: uuid('payment_method_id'),

    /**
     * Locked when the intent is created, NOT read at approval time.
     *
     * Teachers set their own prices and may change them at any moment
     * (ADR 0002). A student quoted 500 BDT who transfers 500 BDT must be
     * approved for 500 BDT even if the price moved to 900 while they were at
     * the shop.
     */
    amountPoisha: integer('amount_poisha').notNull(),
    currency: char('currency', { length: 3 }).notNull().default('BDT'),

    // manual submission
    channel: paymentChannel('channel').notNull(),
    senderNumber: text('sender_number'),
    transactionId: text('transaction_id'),
    proofR2Key: text('proof_r2_key'),
    studentNote: text('student_note'),
    submittedAt: timestamp('submitted_at', { withTimezone: true }).notNull().defaultNow(),

    // verification
    status: paymentStatus('status').notNull().default('pending'),
    reviewedBy: uuid('reviewed_by').references(() => profiles.id),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
    rejectionReason: text('rejection_reason'),

    /** Reserved for a future gateway (SSLCommerz, bKash Merchant at v1.5).
     *  Nullable today so no migration is needed later — the webhook handler
     *  inserts a row with status 'verified' and skips the review step. */
    gateway: text('gateway'),
    gatewayTxId: text('gateway_tx_id'),
    gatewayPayload: jsonb('gateway_payload'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    /** Same transaction ID cannot be claimed twice on the same channel.
     *  Enforced here, not in application code — surface it as a clear
     *  DUPLICATE_TRANSACTION_ID error, never a 500. */
    uniqueIndex('uniq_channel_txid')
      .on(t.channel, t.transactionId)
      .where(sql`transaction_id IS NOT NULL AND status <> 'rejected'`),
    index('payments_pending_idx').on(t.status, t.submittedAt).where(sql`status = 'pending'`),
    index('payments_student_idx').on(t.studentId, t.createdAt.desc()),
    /** The teacher's queue: "my pending payments, oldest first". */
    index('payments_reviewer_pending_idx')
      .on(t.reviewerId, t.submittedAt)
      .where(sql`status = 'pending'`),
  ],
);

export type Plan = typeof plans.$inferSelect;
export type Entitlement = typeof entitlements.$inferSelect;
export type NewEntitlement = typeof entitlements.$inferInsert;
export type Payment = typeof payments.$inferSelect;
