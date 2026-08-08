import { and, asc, desc, eq, inArray, isNull, lt, sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import {
  getDb,
  quizAnswers,
  quizAttempts,
  quizOptions,
  quizQuestions,
  quizzes,
} from '@edtech/db';
import {
  ApiError,
  ATTEMPT_ABANDON_HOURS,
  ATTEMPT_GRACE_SECONDS,
  ERROR_CODES,
  entitlementError,
  formatMarks,
  isAutoGraded,
  parseMarks,
  percentOf,
  type SaveAnswerInput,
} from '@edtech/shared';
import { checkCourseAccess } from '../entitlements/check-lesson-access.js';

/**
 * The student-facing quiz engine (Section 10).
 *
 * THE RULE THIS MODULE EXISTS TO ENFORCE: `is_correct` never leaves the server
 * before submission. It is the mistake most quiz implementations make — the
 * answer key sits in the network response for the entire attempt, and any
 * student who opens devtools has a perfect score.
 *
 * Nothing here selects `quizOptions.isCorrect` into a value that is returned.
 * The two places that read it (`gradeAnswer`, `buildAnswerKey`) consume it
 * locally and return only marks. If you add a function to this file, that is
 * the invariant to preserve.
 *
 * Time is also server-owned. `started_at` is written by the database, the limit
 * is checked against it on submit, and the countdown the student sees is
 * decoration.
 */

export type AttemptQuestion = {
  id: string;
  type: string;
  prompt: string;
  imageR2Key: string | null;
  marks: string;
  /** Options WITHOUT `isCorrect`. Absent entirely for written answers. */
  options?: Array<{ id: string; label: string }>;
};

// ── Starting ────────────────────────────────────────────────────────────────

/**
 * Starts or resumes an attempt.
 *
 * Resuming rather than always creating is what makes a dropped connection
 * survivable: the student reloads and gets the same attempt, the same question
 * order and their autosaved answers, with the clock still running from the
 * original `started_at`.
 */
export async function startAttempt(userId: string, quizId: string) {
  const db = getDb();
  const quiz = await requirePublishedQuiz(userId, quizId);

  const open = await db.query.quizAttempts.findFirst({
    where: and(
      eq(quizAttempts.quizId, quizId),
      eq(quizAttempts.studentId, userId),
      isNull(quizAttempts.submittedAt),
    ),
  });

  if (open) {
    return buildAttemptView(open, quiz);
  }

  const submitted = await db
    .select({ attemptNumber: quizAttempts.attemptNumber })
    .from(quizAttempts)
    .where(and(eq(quizAttempts.quizId, quizId), eq(quizAttempts.studentId, userId)))
    .orderBy(desc(quizAttempts.attemptNumber))
    .limit(1);

  const used = submitted[0]?.attemptNumber ?? 0;
  if (used >= quiz.maxAttempts) {
    throw new ApiError(
      403,
      ERROR_CODES.ATTEMPT_LIMIT_REACHED,
      `You have used all ${quiz.maxAttempts} attempt(s) for this quiz.`,
    );
  }

  const [created] = await db
    .insert(quizAttempts)
    .values({
      id: uuidv7(),
      quizId,
      studentId: userId,
      attemptNumber: used + 1,
      // startedAt defaults to now() IN THE DATABASE. Taking it from the client,
      // or even from this process's clock, makes the time limit negotiable.
      gradingStatus: 'pending',
    })
    .returning();

  if (!created) throw new ApiError(500, ERROR_CODES.INTERNAL);
  return buildAttemptView(created, quiz);
}

/** The attempt as the student may see it: questions, saved answers, deadline.
 *  No `isCorrect`, no explanations, no scores. */
async function buildAttemptView(
  attempt: typeof quizAttempts.$inferSelect,
  quiz: typeof quizzes.$inferSelect,
) {
  const db = getDb();

  const questions = await db
    .select({
      id: quizQuestions.id,
      type: quizQuestions.type,
      prompt: quizQuestions.prompt,
      imageR2Key: quizQuestions.imageR2Key,
      marks: quizQuestions.marks,
      displayOrder: quizQuestions.displayOrder,
    })
    .from(quizQuestions)
    .where(eq(quizQuestions.quizId, quiz.id))
    .orderBy(asc(quizQuestions.displayOrder));

  const options = questions.length
    ? await db
        .select({
          id: quizOptions.id,
          questionId: quizOptions.questionId,
          label: quizOptions.label,
          displayOrder: quizOptions.displayOrder,
        })
        .from(quizOptions)
        .where(inArray(quizOptions.questionId, questions.map((q) => q.id)))
        .orderBy(asc(quizOptions.displayOrder))
    : [];

  const byQuestion = new Map<string, Array<{ id: string; label: string }>>();
  for (const option of options) {
    const list = byQuestion.get(option.questionId) ?? [];
    list.push({ id: option.id, label: option.label });
    byQuestion.set(option.questionId, list);
  }

  const saved = await db
    .select({
      questionId: quizAnswers.questionId,
      selectedOptions: quizAnswers.selectedOptions,
      textAnswer: quizAnswers.textAnswer,
    })
    .from(quizAnswers)
    .where(eq(quizAnswers.attemptId, attempt.id));

  // Shuffled per attempt, seeded by the attempt id, so a reload gives the SAME
  // order. A fresh shuffle on every load would move answers under the student.
  const ordered = quiz.shuffleQuestions ? shuffleSeeded(questions, attempt.id) : questions;

  const deadline = deadlineFor(attempt.startedAt, quiz.timeLimitMinutes);

  return {
    attemptId: attempt.id,
    attemptNumber: attempt.attemptNumber,
    quizId: quiz.id,
    title: quiz.title,
    instructions: quiz.instructions,
    startedAt: attempt.startedAt,
    /** Absolute, server-computed. A client that only knows "20 minutes" starts
     *  its clock when the response renders, which quietly gives back the
     *  round-trip on every reload. */
    expiresAt: deadline,
    timeLimitMinutes: quiz.timeLimitMinutes,
    passPercentage: quiz.passPercentage,
    maxAttempts: quiz.maxAttempts,
    questions: ordered.map<AttemptQuestion>((question) => ({
      id: question.id,
      type: question.type,
      prompt: question.prompt,
      imageR2Key: question.imageR2Key,
      marks: question.marks,
      ...(isAutoGraded(question.type) ? { options: byQuestion.get(question.id) ?? [] } : {}),
    })),
    answers: saved.map((row) => ({
      questionId: row.questionId,
      selectedOptionIds: row.selectedOptions ?? [],
      textAnswer: row.textAnswer,
    })),
  };
}

// ── Autosave ────────────────────────────────────────────────────────────────

/**
 * Saves one answer mid-attempt (Section 10: "autosave each answer as the
 * student moves through, so a dropped connection does not lose the attempt").
 *
 * Returns nothing about correctness. A save endpoint that answered "right" or
 * "wrong" would be a free answer key — submit every option in turn and read the
 * replies.
 */
export async function saveAnswer(userId: string, attemptId: string, input: SaveAnswerInput) {
  const db = getDb();
  const { attempt, quiz } = await requireOpenAttempt(userId, attemptId);

  // Past the deadline the attempt is over; autosave stops accepting rather than
  // letting a student keep typing into an attempt that will discard the work.
  if (isPastGrace(attempt.startedAt, quiz.timeLimitMinutes)) {
    throw new ApiError(
      409,
      ERROR_CODES.ATTEMPT_TIME_EXPIRED,
      'Time is up for this attempt. Submit to see your result.',
    );
  }

  const question = await db.query.quizQuestions.findFirst({
    where: and(eq(quizQuestions.id, input.questionId), eq(quizQuestions.quizId, quiz.id)),
    columns: { id: true, type: true },
  });
  if (!question) throw new ApiError(404, ERROR_CODES.NOT_FOUND, 'Question not found.');

  const selected = await sanitiseSelection(question.id, question.type, input.selectedOptionIds);

  await db
    .insert(quizAnswers)
    .values({
      id: uuidv7(),
      attemptId,
      questionId: question.id,
      selectedOptions: selected,
      textAnswer: input.textAnswer ?? null,
    })
    .onConflictDoUpdate({
      target: [quizAnswers.attemptId, quizAnswers.questionId],
      set: {
        selectedOptions: selected,
        textAnswer: input.textAnswer ?? null,
      },
    });

  return { saved: true };
}

/**
 * Drops option ids that do not belong to this question, and extra selections on
 * a single-answer question.
 *
 * Without this a client could post another question's option ids, or five
 * options on a single-answer question hoping one matches. Grading would then be
 * scoring against a set the teacher never wrote.
 */
async function sanitiseSelection(
  questionId: string,
  type: string,
  selected: string[] | undefined,
): Promise<string[] | null> {
  if (!selected || selected.length === 0) return null;
  if (!isAutoGraded(type)) return null;

  const db = getDb();
  const valid = await db
    .select({ id: quizOptions.id })
    .from(quizOptions)
    .where(and(eq(quizOptions.questionId, questionId), inArray(quizOptions.id, selected)));

  const ids = valid.map((row) => row.id);
  if (ids.length === 0) return null;
  // Single-answer: keep one, deterministically, rather than rejecting — a
  // double-tap on a radio should not error.
  return type === 'mcq_multi' ? ids : [ids[0] as string];
}

// ── Submitting and grading ──────────────────────────────────────────────────

/**
 * Submits and auto-grades.
 *
 * The time limit is enforced HERE, against the database's `started_at` plus a
 * 30-second grace. Answers saved after the grace window are treated as
 * unanswered (Section 10) — the attempt still submits and still scores, because
 * discarding the whole thing would be indistinguishable from losing it to a bad
 * connection.
 */
export async function submitAttempt(
  userId: string,
  attemptId: string,
  input: { answers?: SaveAnswerInput[] } = {},
) {
  const { attempt, quiz } = await requireOpenAttempt(userId, attemptId);

  const expired = isPastGrace(attempt.startedAt, quiz.timeLimitMinutes);

  // A final batch may arrive with the submit so the last answer is not lost to
  // a race with autosave. Refused once the clock is up — otherwise the grace
  // window becomes a way to answer everything at leisure.
  if (input.answers?.length && !expired) {
    for (const answer of input.answers) {
      await saveAnswer(userId, attemptId, answer);
    }
  }

  return gradeAttempt(attemptId, { lateSubmission: expired });
}

/**
 * Auto-grades every choice question and totals the attempt.
 *
 * Written answers get no marks here and leave the attempt at
 * `grading_status = 'partial'` until a teacher grades them (Section 10).
 */
async function gradeAttempt(attemptId: string, options: { lateSubmission: boolean }) {
  const db = getDb();

  const attempt = await db.query.quizAttempts.findFirst({
    where: eq(quizAttempts.id, attemptId),
  });
  if (!attempt) throw new ApiError(404, ERROR_CODES.NOT_FOUND);

  const quiz = await db.query.quizzes.findFirst({ where: eq(quizzes.id, attempt.quizId) });
  if (!quiz) throw new ApiError(404, ERROR_CODES.NOT_FOUND);

  const questions = await db
    .select({ id: quizQuestions.id, type: quizQuestions.type, marks: quizQuestions.marks })
    .from(quizQuestions)
    .where(eq(quizQuestions.quizId, quiz.id));

  const answers = await db
    .select({
      questionId: quizAnswers.questionId,
      selectedOptions: quizAnswers.selectedOptions,
      textAnswer: quizAnswers.textAnswer,
    })
    .from(quizAnswers)
    .where(eq(quizAnswers.attemptId, attemptId));

  const answerByQuestion = new Map(answers.map((row) => [row.questionId, row]));
  const key = await buildAnswerKey(questions.filter((q) => isAutoGraded(q.type)).map((q) => q.id));

  let autoHundredths = 0;
  let maxHundredths = 0;
  let awaitingHuman = 0;

  for (const question of questions) {
    maxHundredths += parseMarks(question.marks);

    if (!isAutoGraded(question.type)) {
      // Written answers are only "awaiting" if the student actually wrote
      // something. A blank long answer is a zero, not a grading task.
      const written = answerByQuestion.get(question.id)?.textAnswer;
      if (written && written.trim().length > 0) awaitingHuman++;
      else await setAwardedMarks(attemptId, question.id, '0');
      continue;
    }

    const correctIds = key.get(question.id) ?? new Set<string>();
    const chosen = new Set(answerByQuestion.get(question.id)?.selectedOptions ?? []);

    // All-or-nothing on multi-answer: partial credit for a student who ticked
    // every box would reward guessing.
    const exact =
      correctIds.size > 0 &&
      chosen.size === correctIds.size &&
      [...chosen].every((id) => correctIds.has(id));

    const awarded = exact ? parseMarks(question.marks) : 0;
    autoHundredths += awarded;
    await setAwardedMarks(attemptId, question.id, formatMarks(awarded));
  }

  const gradingStatus = awaitingHuman > 0 ? 'partial' : 'complete';
  const totalHundredths = autoHundredths;
  const passed =
    gradingStatus === 'complete'
      ? percentOf(totalHundredths, maxHundredths) >= quiz.passPercentage
      : null;

  const [updated] = await db
    .update(quizAttempts)
    .set({
      submittedAt: sql`now()`,
      autoScore: formatMarks(autoHundredths),
      totalScore: formatMarks(totalHundredths),
      maxScore: formatMarks(maxHundredths),
      // Null while written answers are outstanding: a pass/fail computed from
      // a partial score would be shown to the student and then change.
      passed,
      gradingStatus,
    })
    .where(eq(quizAttempts.id, attemptId))
    .returning();

  if (!updated) throw new ApiError(500, ERROR_CODES.INTERNAL);

  return {
    attemptId,
    autoScore: formatMarks(autoHundredths),
    totalScore: formatMarks(totalHundredths),
    maxScore: formatMarks(maxHundredths),
    percent: percentOf(totalHundredths, maxHundredths),
    passed,
    gradingStatus,
    awaitingGrading: awaitingHuman,
    lateSubmission: options.lateSubmission,
    /** Explanations and the key are only released if the teacher allowed it. */
    showAnswers: quiz.showAnswersAfter,
  };
}

async function setAwardedMarks(attemptId: string, questionId: string, marks: string) {
  const db = getDb();
  await db
    .insert(quizAnswers)
    .values({ id: uuidv7(), attemptId, questionId, awardedMarks: marks })
    .onConflictDoUpdate({
      target: [quizAnswers.attemptId, quizAnswers.questionId],
      set: { awardedMarks: marks },
    });
}

/** Reads `is_correct` and returns only the correct option ids, consumed inside
 *  this module. Never returned to a caller. */
async function buildAnswerKey(questionIds: string[]): Promise<Map<string, Set<string>>> {
  const key = new Map<string, Set<string>>();
  if (questionIds.length === 0) return key;

  const rows = await getDb()
    .select({ questionId: quizOptions.questionId, id: quizOptions.id })
    .from(quizOptions)
    .where(and(inArray(quizOptions.questionId, questionIds), eq(quizOptions.isCorrect, true)));

  for (const row of rows) {
    const set = key.get(row.questionId) ?? new Set<string>();
    set.add(row.id);
    key.set(row.questionId, set);
  }
  return key;
}

// ── Results ─────────────────────────────────────────────────────────────────

/**
 * The result screen.
 *
 * Per-question correctness and explanations appear only when the teacher set
 * `show_answers_after`. Otherwise the student sees their score and nothing that
 * would let them reconstruct the key for a reattempt.
 */
export async function getAttemptResult(userId: string, attemptId: string) {
  const db = getDb();

  const attempt = await db.query.quizAttempts.findFirst({
    where: and(eq(quizAttempts.id, attemptId), eq(quizAttempts.studentId, userId)),
  });
  if (!attempt) throw new ApiError(404, ERROR_CODES.NOT_FOUND, 'Attempt not found.');
  if (!attempt.submittedAt) {
    throw new ApiError(409, ERROR_CODES.CONFLICT, 'This attempt has not been submitted yet.');
  }

  const quiz = await db.query.quizzes.findFirst({ where: eq(quizzes.id, attempt.quizId) });
  if (!quiz) throw new ApiError(404, ERROR_CODES.NOT_FOUND);

  const questions = await db
    .select({
      id: quizQuestions.id,
      type: quizQuestions.type,
      prompt: quizQuestions.prompt,
      marks: quizQuestions.marks,
      explanation: quizQuestions.explanation,
      displayOrder: quizQuestions.displayOrder,
    })
    .from(quizQuestions)
    .where(eq(quizQuestions.quizId, quiz.id))
    .orderBy(asc(quizQuestions.displayOrder));

  const answers = await db
    .select({
      questionId: quizAnswers.questionId,
      selectedOptions: quizAnswers.selectedOptions,
      textAnswer: quizAnswers.textAnswer,
      awardedMarks: quizAnswers.awardedMarks,
      teacherFeedback: quizAnswers.teacherFeedback,
    })
    .from(quizAnswers)
    .where(eq(quizAnswers.attemptId, attemptId));

  const answerByQuestion = new Map(answers.map((row) => [row.questionId, row]));

  const total = parseMarks(attempt.totalScore);
  const max = parseMarks(attempt.maxScore);

  return {
    attemptId,
    attemptNumber: attempt.attemptNumber,
    quizId: quiz.id,
    title: quiz.title,
    submittedAt: attempt.submittedAt,
    totalScore: attempt.totalScore,
    maxScore: attempt.maxScore,
    percent: percentOf(total, max),
    passPercentage: quiz.passPercentage,
    passed: attempt.passed,
    gradingStatus: attempt.gradingStatus,
    showAnswers: quiz.showAnswersAfter,
    questions: questions.map((question) => {
      const answer = answerByQuestion.get(question.id);
      const base = {
        id: question.id,
        type: question.type,
        prompt: question.prompt,
        marks: question.marks,
        awardedMarks: answer?.awardedMarks ?? null,
        teacherFeedback: answer?.teacherFeedback ?? null,
        textAnswer: answer?.textAnswer ?? null,
        selectedOptionIds: answer?.selectedOptions ?? [],
      };

      // The explanation is the teacher's reasoning and often restates the
      // answer, so it is gated on the same flag as the key itself.
      return quiz.showAnswersAfter ? { ...base, explanation: question.explanation } : base;
    }),
  };
}

/** Correct option ids for a submitted attempt, released only when the teacher
 *  allowed it. Separate call so a result screen without answers never even
 *  touches the key. */
export async function getAttemptAnswerKey(userId: string, attemptId: string) {
  const db = getDb();

  const attempt = await db.query.quizAttempts.findFirst({
    where: and(eq(quizAttempts.id, attemptId), eq(quizAttempts.studentId, userId)),
    columns: { id: true, quizId: true, submittedAt: true },
  });
  if (!attempt?.submittedAt) throw new ApiError(404, ERROR_CODES.NOT_FOUND, 'Attempt not found.');

  const quiz = await db.query.quizzes.findFirst({
    where: eq(quizzes.id, attempt.quizId),
    columns: { showAnswersAfter: true },
  });

  // Not a 403: whether answers are shown is a teacher setting, and telling a
  // student "there is a key you may not see" invites them to look for it.
  if (!quiz?.showAnswersAfter) {
    throw new ApiError(404, ERROR_CODES.NOT_FOUND, 'Answers are not shown for this quiz.');
  }

  const questions = await db
    .select({ id: quizQuestions.id })
    .from(quizQuestions)
    .where(eq(quizQuestions.quizId, attempt.quizId));

  const key = await buildAnswerKey(questions.map((q) => q.id));
  return [...key.entries()].map(([questionId, ids]) => ({
    questionId,
    correctOptionIds: [...ids],
  }));
}

export async function listMyAttempts(userId: string, quizId: string) {
  const db = getDb();
  return db
    .select({
      id: quizAttempts.id,
      attemptNumber: quizAttempts.attemptNumber,
      startedAt: quizAttempts.startedAt,
      submittedAt: quizAttempts.submittedAt,
      totalScore: quizAttempts.totalScore,
      maxScore: quizAttempts.maxScore,
      passed: quizAttempts.passed,
      gradingStatus: quizAttempts.gradingStatus,
    })
    .from(quizAttempts)
    .where(and(eq(quizAttempts.quizId, quizId), eq(quizAttempts.studentId, userId)))
    .orderBy(asc(quizAttempts.attemptNumber));
}

// ── Sweeps ──────────────────────────────────────────────────────────────────

/**
 * Auto-submits attempts left open.
 *
 * An abandoned attempt otherwise holds one of the student's limited tries
 * forever — they close the tab, come back next week, and the quiz says they
 * have an attempt in progress that they cannot finish because the clock ran out.
 */
export async function sweepAbandonedAttempts(limit = 100) {
  const db = getDb();

  const stale = await db
    .select({ id: quizAttempts.id })
    .from(quizAttempts)
    .where(
      and(
        isNull(quizAttempts.submittedAt),
        lt(
          quizAttempts.startedAt,
          new Date(Date.now() - ATTEMPT_ABANDON_HOURS * 60 * 60 * 1000),
        ),
      ),
    )
    .limit(limit);

  let submitted = 0;
  for (const row of stale) {
    try {
      await gradeAttempt(row.id, { lateSubmission: true });
      submitted++;
    } catch (err) {
      console.error(`[quiz] could not auto-submit attempt ${row.id}:`, err);
    }
  }

  return { swept: submitted, found: stale.length };
}

// ── Internals ───────────────────────────────────────────────────────────────

async function requirePublishedQuiz(userId: string, quizId: string) {
  const db = getDb();
  const quiz = await db.query.quizzes.findFirst({ where: eq(quizzes.id, quizId) });

  // Unpublished is a 404, identical to a quiz that does not exist — a 403 tells
  // a student a quiz is being prepared.
  if (!quiz || !quiz.isPublished) {
    throw new ApiError(404, ERROR_CODES.NOT_FOUND, 'Quiz not found.');
  }

  // The same entitlement gate as every other piece of content. A quiz is course
  // material, and quizzes are exactly what someone with a lapsed subscription
  // would try to keep using.
  const access = await checkCourseAccess(userId, quiz.courseId);
  if (!access.allowed) throw entitlementError(access.reason);

  return quiz;
}

async function requireOpenAttempt(userId: string, attemptId: string) {
  const db = getDb();

  const attempt = await db.query.quizAttempts.findFirst({
    where: and(eq(quizAttempts.id, attemptId), eq(quizAttempts.studentId, userId)),
  });
  if (!attempt) throw new ApiError(404, ERROR_CODES.NOT_FOUND, 'Attempt not found.');
  if (attempt.submittedAt) {
    throw new ApiError(409, ERROR_CODES.ATTEMPT_ALREADY_SUBMITTED);
  }

  const quiz = await requirePublishedQuiz(userId, attempt.quizId);
  return { attempt, quiz };
}

function deadlineFor(startedAt: Date, timeLimitMinutes: number | null): Date | null {
  if (!timeLimitMinutes) return null;
  return new Date(startedAt.getTime() + timeLimitMinutes * 60 * 1000);
}

function isPastGrace(startedAt: Date, timeLimitMinutes: number | null): boolean {
  const deadline = deadlineFor(startedAt, timeLimitMinutes);
  if (!deadline) return false;
  return Date.now() > deadline.getTime() + ATTEMPT_GRACE_SECONDS * 1000;
}

/**
 * Deterministic shuffle seeded by the attempt id.
 *
 * Deterministic matters more than uniform here: the order has to survive a
 * reload, or the student's place in the quiz moves under them. Not used for
 * anything security-sensitive.
 */
function shuffleSeeded<T>(items: T[], seed: string): T[] {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash * 31 + seed.charCodeAt(i)) | 0;
  }

  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    hash = (hash * 1103515245 + 12345) & 0x7fffffff;
    const j = hash % (i + 1);
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}
