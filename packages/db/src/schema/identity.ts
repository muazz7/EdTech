import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  inet,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { userRole } from './enums.js';

/**
 * Supabase `auth.users` holds credentials. This is the application profile.
 * The FK to auth.users is added by migration 0002 — Drizzle does not model
 * tables in the `auth` schema, which Supabase owns.
 */
export const profiles = pgTable(
  'profiles',
  {
    id: uuid('id').primaryKey(),
    fullName: text('full_name').notNull(),
    phone: text('phone').unique(),
    email: text('email').unique(),
    role: userRole('role').notNull().default('student'),
    avatarUrl: text('avatar_url'),
    institution: text('institution'),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('profiles_role_idx').on(t.role).where(sql`is_active`)],
);

/**
 * Single-device enforcement (Section 6.3).
 *
 * `one_live_session_per_user` is the rule expressed in the schema itself: the
 * database will not permit two live sessions for one user regardless of
 * application bugs. Do not remove this index to "fix" a login error — a login
 * that trips it means the revoke step was skipped, which is the actual bug.
 */
export const activeSessions = pgTable(
  'active_sessions',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    deviceFingerprint: text('device_fingerprint').notNull(),
    deviceLabel: text('device_label'), // "Redmi Note 12", "Chrome on Windows"
    platform: text('platform').notNull(), // 'web' | 'android' | 'ios'
    ipAddress: inet('ip_address'),
    userAgent: text('user_agent'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastActiveAt: timestamp('last_active_at', { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokedReason: text('revoked_reason'),
  },
  (t) => [
    uniqueIndex('one_live_session_per_user')
      .on(t.userId)
      .where(sql`revoked_at IS NULL`),
    index('active_sessions_user_created_idx').on(t.userId, t.createdAt.desc()),
  ],
);

/**
 * Rolling 30-day device-switch budget (Section 6.3).
 *
 * Last-login-wins alone does not stop credential sharing — two students simply
 * take turns. This log is what makes sharing expensive: 4 distinct
 * fingerprints per 30 days, switching between already-seen devices free.
 */
export const deviceSwitchLog = pgTable(
  'device_switch_log',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    fromFingerprint: text('from_fingerprint'),
    toFingerprint: text('to_fingerprint').notNull(),
    ipAddress: inet('ip_address'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('device_switch_log_user_created_idx').on(t.userId, t.createdAt.desc())],
);

export type Profile = typeof profiles.$inferSelect;
export type NewProfile = typeof profiles.$inferInsert;
export type ActiveSession = typeof activeSessions.$inferSelect;
export type DeviceSwitch = typeof deviceSwitchLog.$inferSelect;
