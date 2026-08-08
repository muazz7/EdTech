import { z } from 'zod';
import { uuidSchema } from './common.js';

/**
 * Quizzes and assignments (Section 10, Section 11).
 *
 * Marks are `numeric` in the database, not float, because a total that is 0.1
 * off decides pass/fail on a certificate. They cross the wire as strings for the
 * same reason and are parsed with a decimal-safe helper, never `parseFloat` on
 * an accumulated sum.
 */

export const QUESTION_TYPES = [
  'mcq_single',
  'mcq_multi',
  'true_false',
  'short_answer',
  'long_answer',
] as const;

export const questionTypeSchema = z.enum(QUESTION_TYPES);
export type QuestionType = (typeof QUESTION_TYPES)[number];

/** MCQ and true/false grade themselves. Everything else waits for a human, which
 *  is what puts an attempt into `grading_status = 'partial'`. */
export const AUTO_GRADED_TYPES = ['mcq_single', 'mcq_multi', 'true_false'] as const;

/** Takes a plain string: callers read the type straight off a database row, and
 *  forcing a cast at every call site is how a wrong one eventually slips in. */
export function isAutoGraded(type: string): boolean {
  return (AUTO_GRADED_TYPES as readonly string[]).includes(type);
}

// ── Quizzes ─────────────────────────────────────────────────────────────────

export const createQuizSchema = z.object({
  lessonId: uuidSchema.optional(),
  title: z.string().trim().min(1).max(200),
  instructions: z.string().trim().max(5000).optional(),
  /** Null means untimed. Enforced against the server's `started_at`; the client
   *  countdown is decoration (Section 10). */
  timeLimitMinutes: z.number().int().min(1).max(600).nullable().optional(),
  passPercentage: z.number().int().min(0).max(100).default(40),
  maxAttempts: z.number().int().min(1).max(20).default(1),
  shuffleQuestions: z.boolean().default(true),
  showAnswersAfter: z.boolean().default(true),
});
export type CreateQuizInput = z.infer<typeof createQuizSchema>;

export const updateQuizSchema = createQuizSchema
  .omit({ lessonId: true })
  .partial()
  .extend({ isPublished: z.boolean().optional() });
export type UpdateQuizInput = z.infer<typeof updateQuizSchema>;

/** Marks as a string: a JSON float cannot represent 0.1 exactly, and a quiz
 *  totalling 12.3 that reports 12.299999 fails a pass mark it should clear. */
export const marksSchema = z
  .string()
  .trim()
  .regex(/^\d{1,3}(\.\d{1,2})?$/, 'Marks must be a number with at most 2 decimal places.');

export const questionOptionSchema = z.object({
  label: z.string().trim().min(1).max(500),
  isCorrect: z.boolean().default(false),
});

export const createQuestionSchema = z.object({
  type: questionTypeSchema,
  prompt: z.string().trim().min(1).max(5000),
  marks: marksSchema.default('1'),
  explanation: z.string().trim().max(5000).optional(),
  options: z.array(questionOptionSchema).max(10).optional(),
});
export type CreateQuestionInput = z.infer<typeof createQuestionSchema>;

export const updateQuestionSchema = createQuestionSchema.partial();
export type UpdateQuestionInput = z.infer<typeof updateQuestionSchema>;

// ── Attempts ────────────────────────────────────────────────────────────────

/** One answer, autosaved as the student moves through (Section 10). */
export const saveAnswerSchema = z
  .object({
    questionId: uuidSchema,
    selectedOptionIds: z.array(uuidSchema).max(10).optional(),
    textAnswer: z.string().max(20_000).optional(),
  })
  .refine(
    (value) => value.selectedOptionIds !== undefined || value.textAnswer !== undefined,
    'Send either selected options or a text answer.',
  );
export type SaveAnswerInput = z.infer<typeof saveAnswerSchema>;

/** Submitting may carry a final batch, so a student who answers the last
 *  question and hits Submit does not lose it to a race with autosave. */
export const submitAttemptSchema = z.object({
  answers: z.array(saveAnswerSchema).max(200).optional(),
});
export type SubmitAttemptInput = z.infer<typeof submitAttemptSchema>;

export const gradeAnswerSchema = z.object({
  awardedMarks: marksSchema,
  teacherFeedback: z.string().trim().max(5000).optional(),
});
export type GradeAnswerInput = z.infer<typeof gradeAnswerSchema>;

// ── Assignments ─────────────────────────────────────────────────────────────

export const ASSIGNMENT_MIME_TYPES = [
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
] as const;

export const createAssignmentSchema = z.object({
  lessonId: uuidSchema.optional(),
  title: z.string().trim().min(1).max(200),
  instructions: z.string().trim().min(1).max(10_000),
  dueAt: z.string().datetime().nullable().optional(),
  maxMarks: marksSchema.default('100'),
  allowedMime: z.array(z.enum(ASSIGNMENT_MIME_TYPES)).min(1).max(10).optional(),
  maxFileMb: z.number().int().min(1).max(50).default(10),
  allowLate: z.boolean().default(true),
});
export type CreateAssignmentInput = z.infer<typeof createAssignmentSchema>;

export const updateAssignmentSchema = createAssignmentSchema
  .omit({ lessonId: true })
  .partial()
  .extend({ isPublished: z.boolean().optional() });
export type UpdateAssignmentInput = z.infer<typeof updateAssignmentSchema>;

export const assignmentUploadUrlSchema = z.object({
  filename: z.string().trim().min(1).max(200),
  /** Checked against the assignment's own `allowed_mime` server-side. A file
   *  picker's accept attribute is a hint, not a control (Section 11). */
  mime: z.string().trim().min(1).max(150),
  size: z.number().int().positive(),
});
export type AssignmentUploadUrlInput = z.infer<typeof assignmentUploadUrlSchema>;

export const submitAssignmentSchema = z.object({
  files: z
    .array(
      z.object({
        key: z.string().min(1).max(500),
        name: z.string().trim().min(1).max(200),
        size: z.number().int().positive(),
        mime: z.string().trim().min(1).max(150),
      }),
    )
    .min(1)
    .max(10),
  studentNote: z.string().trim().max(2000).optional(),
});
export type SubmitAssignmentInput = z.infer<typeof submitAssignmentSchema>;

export const gradeSubmissionSchema = z.object({
  marks: marksSchema,
  teacherFeedback: z.string().trim().max(5000).optional(),
});
export type GradeSubmissionInput = z.infer<typeof gradeSubmissionSchema>;

// ── Completion rules and certificates ───────────────────────────────────────

export const completionRulesSchema = z.object({
  minLessonsPercent: z.number().int().min(0).max(100).default(80),
  requireAllQuizzes: z.boolean().default(true),
  minQuizAverage: z.number().int().min(0).max(100).default(40),
  requireAssignments: z.boolean().default(false),
  issuesCertificate: z.boolean().default(true),
});
export type CompletionRulesInput = z.infer<typeof completionRulesSchema>;

/**
 * `CERT-2026-4F8A2C91`. The suffix is random, not sequential: the verification
 * page is public and unauthenticated, and a sequential number can be walked
 * (Section 13).
 */
export const certificateNoSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^CERT-\d{4}-[0-9A-F]{8}$/, 'That does not look like a certificate number.');
