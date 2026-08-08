import { sql } from 'drizzle-orm';
import {
  bigserial,
  index,
  inet,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { profiles } from './identity.js';

export const notifications = pgTable(
  'notifications',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    type: text('type').notNull(),
    title: text('title').notNull(),
    body: text('body'),
    link: text('link'),
    readAt: timestamp('read_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('notifications_unread_idx').on(t.userId, t.createdAt.desc()).where(sql`read_at IS NULL`),
  ],
);

/**
 * Job queue. Vercel functions have execution ceilings (10s Hobby, 60s Pro), so
 * certificate PDF generation, note-to-image rendering, and bulk exports all
 * run here. Nothing in the request path is allowed to be slow.
 *
 * Drained by POST /cron/process-jobs every minute. Swap for Upstash QStash if
 * throughput demands it — the handler signature does not change.
 */
export const jobs = pgTable(
  'jobs',
  {
    id: uuid('id').primaryKey(),
    type: text('type').notNull(),
    payload: jsonb('payload').notNull(),
    status: text('status').notNull().default('queued'),
    attempts: integer('attempts').notNull().default(0),
    runAfter: timestamp('run_after', { withTimezone: true }).notNull().defaultNow(),
    lastError: text('last_error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (t) => [
    index('jobs_runnable_idx')
      .on(t.status, t.runAfter)
      .where(sql`status IN ('queued','failed')`),
  ],
);

/** Every privileged action, immutable. Never UPDATE or DELETE a row here. */
export const auditLog = pgTable(
  'audit_log',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    actorId: uuid('actor_id').references(() => profiles.id),
    action: text('action').notNull(),
    entityType: text('entity_type').notNull(),
    entityId: uuid('entity_id'),
    before: jsonb('before'),
    after: jsonb('after'),
    ipAddress: inet('ip_address'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('audit_log_entity_idx').on(t.entityType, t.entityId, t.createdAt.desc())],
);

export type Notification = typeof notifications.$inferSelect;
export type Job = typeof jobs.$inferSelect;
export type AuditEntry = typeof auditLog.$inferSelect;
