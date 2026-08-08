import { sql } from 'drizzle-orm';
import {
  boolean,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { questionType } from './enums.js';
import { courses, lessons } from './content.js';
import { profiles } from './identity.js';

// ── Quizzes ─────────────────────────────────────────────────────────────────

export const quizzes = pgTable('quizzes', {
  id: uuid('id').primaryKey(),
  lessonId: uuid('lesson_id')
    .unique()
    .references(() => lessons.id, { onDelete: 'cascade' }),
  courseId: uuid('course_id')
    .notNull()
    .references(() => courses.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  instructions: text('instructions'),
  timeLimitMinutes: integer('time_limit_minutes'),
  passPercentage: integer('pass_percentage').notNull().default(40),
  maxAttempts: integer('max_attempts').notNull().default(1),
  shuffleQuestions: boolean('shuffle_questions').notNull().default(true),
  showAnswersAfter: boolean('show_answers_after').notNull().default(true),
  isPublished: boolean('is_published').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const quizQuestions = pgTable('quiz_questions', {
  id: uuid('id').primaryKey(),
  quizId: uuid('quiz_id')
    .notNull()
    .references(() => quizzes.id, { onDelete: 'cascade' }),
  type: questionType('type').notNull(),
  prompt: text('prompt').notNull(),
  imageR2Key: text('image_r2_key'),
  marks: numeric('marks', { precision: 5, scale: 2 }).notNull().default('1'),
  explanation: text('explanation'),
  displayOrder: integer('display_order').notNull(),
});

/**
 * `is_correct` must never reach the client before submission. Select this
 * column only in server-side grading code — the common quiz bug is shipping
 * the answer key in the network response for the whole attempt.
 */
export const quizOptions = pgTable('quiz_options', {
  id: uuid('id').primaryKey(),
  questionId: uuid('question_id')
    .notNull()
    .references(() => quizQuestions.id, { onDelete: 'cascade' }),
  label: text('label').notNull(),
  isCorrect: boolean('is_correct').notNull().default(false),
  displayOrder: integer('display_order').notNull(),
});

export const quizAttempts = pgTable(
  'quiz_attempts',
  {
    id: uuid('id').primaryKey(),
    quizId: uuid('quiz_id')
      .notNull()
      .references(() => quizzes.id, { onDelete: 'cascade' }),
    studentId: uuid('student_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    attemptNumber: integer('attempt_number').notNull(),
    /** Server-recorded. The client countdown is decoration; the time limit is
     *  enforced against this value on submit. */
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    submittedAt: timestamp('submitted_at', { withTimezone: true }),
    autoScore: numeric('auto_score', { precision: 6, scale: 2 }),
    manualScore: numeric('manual_score', { precision: 6, scale: 2 }),
    totalScore: numeric('total_score', { precision: 6, scale: 2 }),
    maxScore: numeric('max_score', { precision: 6, scale: 2 }),
    passed: boolean('passed'),
    gradingStatus: text('grading_status').notNull().default('pending'), // 'pending'|'partial'|'complete'
  },
  (t) => [unique('quiz_attempts_unique').on(t.quizId, t.studentId, t.attemptNumber)],
);

export const quizAnswers = pgTable(
  'quiz_answers',
  {
    id: uuid('id').primaryKey(),
    attemptId: uuid('attempt_id')
      .notNull()
      .references(() => quizAttempts.id, { onDelete: 'cascade' }),
    questionId: uuid('question_id')
      .notNull()
      .references(() => quizQuestions.id, { onDelete: 'cascade' }),
    selectedOptions: uuid('selected_options').array(),
    textAnswer: text('text_answer'),
    awardedMarks: numeric('awarded_marks', { precision: 5, scale: 2 }),
    teacherFeedback: text('teacher_feedback'),
    gradedBy: uuid('graded_by').references(() => profiles.id),
    gradedAt: timestamp('graded_at', { withTimezone: true }),
  },
  (t) => [unique('quiz_answers_unique').on(t.attemptId, t.questionId)],
);

// ── Assignments ─────────────────────────────────────────────────────────────

export const assignments = pgTable('assignments', {
  id: uuid('id').primaryKey(),
  lessonId: uuid('lesson_id')
    .unique()
    .references(() => lessons.id, { onDelete: 'cascade' }),
  courseId: uuid('course_id')
    .notNull()
    .references(() => courses.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  instructions: text('instructions').notNull(),
  attachmentR2Key: text('attachment_r2_key'),
  dueAt: timestamp('due_at', { withTimezone: true }),
  maxMarks: numeric('max_marks', { precision: 5, scale: 2 }).notNull().default('100'),
  /** Validated server-side on the presign request, not just in the file
   *  picker — a client-side accept attribute is a hint, not a control. */
  allowedMime: text('allowed_mime')
    .array()
    .notNull()
    .default(sql`ARRAY['application/pdf','image/jpeg','image/png']`),
  maxFileMb: integer('max_file_mb').notNull().default(10),
  allowLate: boolean('allow_late').notNull().default(true),
  isPublished: boolean('is_published').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const assignmentSubmissions = pgTable(
  'assignment_submissions',
  {
    id: uuid('id').primaryKey(),
    assignmentId: uuid('assignment_id')
      .notNull()
      .references(() => assignments.id, { onDelete: 'cascade' }),
    studentId: uuid('student_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    files: jsonb('files').notNull(), // [{r2_key, name, size, mime}]
    studentNote: text('student_note'),
    submittedAt: timestamp('submitted_at', { withTimezone: true }).notNull().defaultNow(),
    isLate: boolean('is_late').notNull().default(false),
    marks: numeric('marks', { precision: 5, scale: 2 }),
    teacherFeedback: text('teacher_feedback'),
    gradedBy: uuid('graded_by').references(() => profiles.id),
    gradedAt: timestamp('graded_at', { withTimezone: true }),
  },
  (t) => [unique('assignment_submissions_unique').on(t.assignmentId, t.studentId)],
);

export type Quiz = typeof quizzes.$inferSelect;
export type QuizQuestion = typeof quizQuestions.$inferSelect;
export type QuizAttempt = typeof quizAttempts.$inferSelect;
export type Assignment = typeof assignments.$inferSelect;
export type AssignmentSubmission = typeof assignmentSubmissions.$inferSelect;
