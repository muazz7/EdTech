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
 * Teacher-issued discount codes (ADR 0002).
 *
 * The teacher sets the validity window and the quantity — those were the two
 * things asked for by name. Quantity is enforced against non-rejected payments
 * rather than a counter column, so a code cannot drift out of step with what
 * was actually redeemed.
 *
 * A code is scoped to its issuing teacher and optionally to one of their
 * courses. It can never apply to a platform-wide plan: those span every
 * teacher's catalog, and one teacher must not be able to discount another
 * teacher's revenue.
 */
export const promoCodes = pgTable(
  'promo_codes',
  {
    id: uuid('id').primaryKey(),
    /** Uppercase, unique across the platform: students type it, and two
     *  teachers owning "EID50" would be unresolvable. */
    code: text('code').notNull().unique(),
    teacherId: uuid('teacher_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    /** NULL means every course this teacher owns. */
    courseId: uuid('course_id').references(() => courses.id, { onDelete: 'cascade' }),
    /** 100 means free access — the payment is settled at zero and the
     *  entitlement is granted without a proof step, since there is nothing to
     *  prove. */
    discountPercent: integer('discount_percent').notNull(),
    /** How many students may use it. The teacher's "quantity". */
    maxRedemptions: integer('max_redemptions').notNull(),
    startsAt: timestamp('starts_at', { withTimezone: true }).notNull().defaultNow(),
    /** The teacher's "duration". NULL never expires. */
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    isActive: boolean('is_active').notNull().default(true),
    note: text('note'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('promo_discount_range', sql`${t.discountPercent} BETWEEN 1 AND 100`),
    check('promo_quantity_positive', sql`${t.maxRedemptions} > 0`),
    index('promo_codes_teacher_idx').on(t.teacherId).where(sql`is_active`),
  ],
);

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
    /**
     * Which expiry reminder has been sent (Section 8.3): 7, 3, 1, 0 for the
     * lapse notice, or -30 for the winback.
     *
     * A column rather than a search of the notifications table: the sweep runs
     * daily and must be idempotent, and "have I already told this student"
     * should be one indexed read, not a scan.
     */
    reminderStage: integer('reminder_stage'),
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

    /** The code used, and what it took off. `amount_poisha` above is already
     *  the discounted figure — this is kept so a dispute can be settled against
     *  the original price and the code that changed it. */
    promoCodeId: uuid('promo_code_id').references(() => promoCodes.id),
    discountPoisha: integer('discount_poisha').notNull().default(0),

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
    /** One redemption per student per code, enforced by the database rather
     *  than by a check that a retry could race past. Rejected payments are
     *  excluded so a student whose proof was refused can try again. */
    uniqueIndex('uniq_promo_per_student')
      .on(t.promoCodeId, t.studentId)
      .where(sql`promo_code_id IS NOT NULL AND status <> 'rejected'`),
    index('payments_promo_idx').on(t.promoCodeId).where(sql`promo_code_id IS NOT NULL`),
  ],
);

export type Plan = typeof plans.$inferSelect;
export type PromoCode = typeof promoCodes.$inferSelect;
export type Entitlement = typeof entitlements.$inferSelect;
export type NewEntitlement = typeof entitlements.$inferInsert;
export type Payment = typeof payments.$inferSelect;
