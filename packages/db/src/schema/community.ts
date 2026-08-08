import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  numeric,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { courses, lessons } from './content.js';
import { profiles } from './identity.js';

// ── Doubts / discussion (Phase 9) ───────────────────────────────────────────

/** Public-by-default is deliberate: the same question gets asked forty times,
 *  and a searchable answered thread cuts teacher workload dramatically. */
export const doubtThreads = pgTable(
  'doubt_threads',
  {
    id: uuid('id').primaryKey(),
    lessonId: uuid('lesson_id')
      .notNull()
      .references(() => lessons.id, { onDelete: 'cascade' }),
    courseId: uuid('course_id')
      .notNull()
      .references(() => courses.id, { onDelete: 'cascade' }),
    studentId: uuid('student_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    body: text('body').notNull(),
    isResolved: boolean('is_resolved').notNull().default(false),
    isPinned: boolean('is_pinned').notNull().default(false),
    /** Visible to other students entitled to the course. */
    isPublic: boolean('is_public').notNull().default(true),
    replyCount: integer('reply_count').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('doubt_threads_lesson_idx').on(t.lessonId, t.createdAt.desc()).where(sql`is_public`),
    index('doubt_threads_unresolved_idx').on(t.courseId).where(sql`NOT is_resolved`),
  ],
);

export const doubtReplies = pgTable('doubt_replies', {
  id: uuid('id').primaryKey(),
  threadId: uuid('thread_id')
    .notNull()
    .references(() => doubtThreads.id, { onDelete: 'cascade' }),
  authorId: uuid('author_id')
    .notNull()
    .references(() => profiles.id, { onDelete: 'cascade' }),
  body: text('body').notNull(),
  imageR2Key: text('image_r2_key'),
  isTeacherAnswer: boolean('is_teacher_answer').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// ── Certificates (Phase 9) ──────────────────────────────────────────────────

/**
 * Name/title/teacher are snapshots at issue time. A teacher leaving or a
 * course being retitled must not retroactively rewrite issued certificates.
 *
 * `certificate_no` includes a random component so CERT-2026-000418 cannot be
 * walked to 000419 — the verification page is public and unauthenticated.
 */
export const certificates = pgTable(
  'certificates',
  {
    id: uuid('id').primaryKey(),
    certificateNo: text('certificate_no').notNull().unique(), // "CERT-2026-000418"
    studentId: uuid('student_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    courseId: uuid('course_id')
      .notNull()
      .references(() => courses.id, { onDelete: 'cascade' }),
    studentName: text('student_name').notNull(),
    courseTitle: text('course_title').notNull(),
    teacherName: text('teacher_name').notNull(),
    finalScore: numeric('final_score', { precision: 5, scale: 2 }),
    issuedAt: timestamp('issued_at', { withTimezone: true }).notNull().defaultNow(),
    pdfR2Key: text('pdf_r2_key'),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => [unique('certificates_student_course_unique').on(t.studentId, t.courseId)],
);

export const courseCompletionRules = pgTable('course_completion_rules', {
  courseId: uuid('course_id')
    .primaryKey()
    .references(() => courses.id, { onDelete: 'cascade' }),
  minLessonsPercent: integer('min_lessons_percent').notNull().default(90),
  requireAllQuizzes: boolean('require_all_quizzes').notNull().default(true),
  minQuizAverage: integer('min_quiz_average').notNull().default(40),
  requireAssignments: boolean('require_assignments').notNull().default(false),
  issuesCertificate: boolean('issues_certificate').notNull().default(true),
});

export type DoubtThread = typeof doubtThreads.$inferSelect;
export type Certificate = typeof certificates.$inferSelect;
