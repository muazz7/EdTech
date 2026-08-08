import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { paymentChannel } from './enums.js';
import { profiles } from './identity.js';

/**
 * Where a teacher receives money.
 *
 * This is a deliberate departure from Section 1.3, which reserved payment
 * handling for the Owner. Teachers now publish their own bKash / Nagad /
 * Rocket numbers and verify their own course payments, so funds move directly
 * from student to teacher and never transit the platform.
 *
 * Consequence worth carrying forward: the platform therefore has no automatic
 * revenue against the VdoCipher and hosting bill in Section 20. That is a
 * commercial decision, not a schema one, but it is the reason this table exists
 * at all.
 */
export const paymentMethods = pgTable(
  'payment_methods',
  {
    id: uuid('id').primaryKey(),
    /** Owner of the number. An Owner-owned row is used for platform-wide plans
     *  (subscription, lifetime_all), which span every teacher's catalog and so
     *  cannot belong to any one teacher. */
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    channel: paymentChannel('channel').notNull(),
    /** Stored as entered, shown to the student as copyable text (Section 8.1). */
    accountNumber: text('account_number').notNull(),
    /** "Personal" / "Merchant" — bKash charges differ and students need to know
     *  which send-money option to use. */
    accountType: text('account_type'),
    /** Name the transfer should show, so a student can sanity-check the target. */
    accountLabel: text('account_label'),
    instructions: text('instructions'),
    isActive: boolean('is_active').notNull().default(true),
    displayOrder: integer('display_order').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    /** One live row per owner+channel+number. A teacher re-adding the same
     *  bKash number would otherwise show a student two identical options. */
    uniqueIndex('payment_methods_owner_channel_number_key')
      .on(t.ownerId, t.channel, t.accountNumber)
      .where(sql`is_active`),
    index('payment_methods_owner_idx').on(t.ownerId).where(sql`is_active`),
  ],
);

export type PaymentMethod = typeof paymentMethods.$inferSelect;
