import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  inet,
  pgTable,
  text,
  timestamp,
  unique,
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

/**
 * Rotating refresh tokens (Section 6.2: 30 days, rotating).
 *
 * Only a SHA-256 hash is stored. A database leak must not hand over usable
 * refresh tokens, and there is never a reason to read the original back.
 *
 * `family_id` groups every token descended from one login. Rotation marks the
 * old token used and issues a successor in the same family. If a token that has
 * already been used is presented again, that is either a replay or a stolen
 * token being redeemed after the legitimate client already rotated — and there
 * is no way to tell which. The whole family is revoked and the session killed.
 * Section 6.3 already forces one live session per user, so the cost of being
 * wrong is one extra login.
 */
export const refreshTokens = pgTable(
  'refresh_tokens',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => activeSessions.id, { onDelete: 'cascade' }),
    familyId: uuid('family_id').notNull(),
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokedReason: text('revoked_reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('refresh_tokens_hash_key').on(t.tokenHash),
    index('refresh_tokens_family_idx').on(t.familyId),
    index('refresh_tokens_user_live_idx').on(t.userId).where(sql`revoked_at IS NULL`),
  ],
);

/**
 * FCM registration tokens, so a new-device login can push a logout to the
 * device it just kicked (Section 15) rather than leaving it to discover the
 * revocation on its next request.
 *
 * Keyed by (user, token): the same physical device re-registers with a fresh
 * FCM token periodically, and the same token can move between accounts on a
 * shared phone.
 */
export const deviceTokens = pgTable(
  'device_tokens',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    /** Nullable: a token registers against the session that was live when the
     *  app started, but must survive that session being revoked — otherwise the
     *  logout push has nowhere to go. */
    sessionId: uuid('session_id').references(() => activeSessions.id, { onDelete: 'set null' }),
    fcmToken: text('fcm_token').notNull(),
    platform: text('platform').notNull(),
    deviceFingerprint: text('device_fingerprint'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    disabledAt: timestamp('disabled_at', { withTimezone: true }),
  },
  (t) => [
    unique('device_tokens_user_token_key').on(t.userId, t.fcmToken),
    index('device_tokens_user_idx').on(t.userId).where(sql`disabled_at IS NULL`),
  ],
);

export type RefreshToken = typeof refreshTokens.$inferSelect;
export type DeviceToken = typeof deviceTokens.$inferSelect;
export type Profile = typeof profiles.$inferSelect;
export type NewProfile = typeof profiles.$inferInsert;
export type ActiveSession = typeof activeSessions.$inferSelect;
export type DeviceSwitch = typeof deviceSwitchLog.$inferSelect;
