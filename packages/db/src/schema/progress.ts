import {
  bigserial,
  boolean,
  index,
  inet,
  integer,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { courses, lessons } from './content.js';
import { profiles } from './identity.js';

export const lessonProgress = pgTable(
  'lesson_progress',
  {
    studentId: uuid('student_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    lessonId: uuid('lesson_id')
      .notNull()
      .references(() => lessons.id, { onDelete: 'cascade' }),
    courseId: uuid('course_id')
      .notNull()
      .references(() => courses.id, { onDelete: 'cascade' }),
    secondsWatched: integer('seconds_watched').notNull().default(0),
    lastPosition: integer('last_position').notNull().default(0),
    isComplete: boolean('is_complete').notNull().default(false),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    firstOpenedAt: timestamp('first_opened_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.studentId, t.lessonId] }),
    index('lesson_progress_student_course_idx').on(t.studentId, t.courseId),
  ],
);

/**
 * Append-only. Feeds analytics AND the piracy signals dashboard (Section 17.5).
 *
 * Partition by month before this table gets large. Never query it live from a
 * dashboard — the admin views read the nightly `daily_metrics` rollup.
 */
export const watchEvents = pgTable(
  'watch_events',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    studentId: uuid('student_id').notNull(),
    lessonId: uuid('lesson_id').notNull(),
    sessionId: uuid('session_id'),
    event: text('event').notNull(), // 'play'|'pause'|'seek'|'heartbeat'|'ended'
    position: integer('position'),
    playbackRate: numeric('playback_rate', { precision: 3, scale: 1 }),
    ipAddress: inet('ip_address'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('watch_events_student_created_idx').on(t.studentId, t.createdAt.desc())],
);

export type LessonProgress = typeof lessonProgress.$inferSelect;
export type WatchEvent = typeof watchEvents.$inferSelect;
