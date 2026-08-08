import { and, asc, eq, sql } from 'drizzle-orm';
import {
  courses,
  getDb,
  profiles,
  quizAnswers,
  quizAttempts,
  quizQuestions,
  quizzes,
} from '@edtech/db';
import {
  ApiError,
  ERROR_CODES,
  formatMarks,
  isAutoGraded,
  parseMarks,
  percentOf,
  type GradeAnswerInput,
} from '@edtech/shared';
import { recordAudit } from '../audit/log.js';
import { notify } from '../notifications/notify.js';
import { requireCourse, type Actor } from '../content/ownership.js';

/**
 * The teacher's grading queue (Section 10).
 *
 * Written answers land here after auto-grading finishes. An attempt sits at
 * `grading_status = 'partial'` with `passed = null` until every written answer
 * has marks — showing a student a pass/fail computed from half a score and then
 * changing it is worse than showing "being graded".
 */

/** Attempts with at least one ungraded written answer, oldest first. Oldest
 *  first because a student waiting three days is the one to serve next. */
export async function listGradingQueue(actor: Actor, params: { courseId?: string } = {}) {
  const db = getDb();

  if (params.courseId) await requireCourse(actor, params.courseId);

  const rows = await db
    .select({
      attemptId: quizAttempts.id,
      quizId: quizzes.id,
      quizTitle: quizzes.title,
      courseId: courses.id,
      courseTitle: courses.title,
      studentId: profiles.id,
      studentName: profiles.fullName,
      submittedAt: quizAttempts.submittedAt,
      attemptNumber: quizAttempts.attemptNumber,
      pending: sql<number>`(
        SELECT count(*)::int FROM quiz_answers a
        JOIN quiz_questions q ON q.id = a.question_id
        WHERE a.attempt_id = ${quizAttempts.id}
          AND q.type IN ('short_answer','long_answer')
          AND a.graded_at IS NULL
          AND a.text_answer IS NOT NULL
      )`,
    })
    .from(quizAttempts)
    .innerJoin(quizzes, eq(quizzes.id, quizAttempts.quizId))
    .innerJoin(courses, eq(courses.id, quizzes.courseId))
    .innerJoin(profiles, eq(profiles.id, quizAttempts.studentId))
    .where(
      and(
        eq(quizAttempts.gradingStatus, 'partial'),
        // Only the caller's own courses, unless they are an admin. Without this
        // a teacher reads every other teacher's submissions.
        actor.role === 'admin' ? undefined : eq(courses.teacherId, actor.userId),
        params.courseId ? eq(courses.id, params.courseId) : undefined,
      ),
    )
    .orderBy(asc(quizAttempts.submittedAt))
    .limit(100);

  return rows.filter((row) => row.pending > 0);
}

/** One attempt, with the written answers to grade and their marks so far. */
export async function getAttemptForGrading(actor: Actor, attemptId: string) {
  const db = getDb();
  const { attempt, quiz } = await requireAttempt(actor, attemptId);

  const student = await db.query.profiles.findFirst({
    where: eq(profiles.id, attempt.studentId),
    columns: { id: true, fullName: true },
  });

  const rows = await db
    .select({
      questionId: quizQuestions.id,
      type: quizQuestions.type,
      prompt: quizQuestions.prompt,
      marks: quizQuestions.marks,
      displayOrder: quizQuestions.displayOrder,
      textAnswer: quizAnswers.textAnswer,
      awardedMarks: quizAnswers.awardedMarks,
      teacherFeedback: quizAnswers.teacherFeedback,
      gradedAt: quizAnswers.gradedAt,
    })
    .from(quizQuestions)
    .leftJoin(
      quizAnswers,
      and(eq(quizAnswers.questionId, quizQuestions.id), eq(quizAnswers.attemptId, attemptId)),
    )
    .where(eq(quizQuestions.quizId, quiz.id))
    .orderBy(asc(quizQuestions.displayOrder));

  return {
    attemptId,
    quizId: quiz.id,
    quizTitle: quiz.title,
    student: student ?? null,
    submittedAt: attempt.submittedAt,
    totalScore: attempt.totalScore,
    maxScore: attempt.maxScore,
    gradingStatus: attempt.gradingStatus,
    questions: rows,
  };
}

/**
 * Awards marks for one written answer and re-totals the attempt.
 *
 * Re-totalling on every save rather than at the end means a teacher who grades
 * three of five answers and goes home leaves a consistent partial state, not a
 * total that is silently wrong until they come back.
 */
export async function gradeAnswer(
  actor: Actor,
  attemptId: string,
  questionId: string,
  input: GradeAnswerInput,
) {
  const db = getDb();
  const { quiz } = await requireAttempt(actor, attemptId);

  const question = await db.query.quizQuestions.findFirst({
    where: and(eq(quizQuestions.id, questionId), eq(quizQuestions.quizId, quiz.id)),
    columns: { id: true, type: true, marks: true },
  });
  if (!question) throw new ApiError(404, ERROR_CODES.NOT_FOUND, 'Question not found.');

  // Auto-graded questions are the machine's to score. Letting a teacher
  // overwrite them by hand makes "why is my MCQ wrong" unanswerable.
  if (isAutoGraded(question.type)) {
    throw new ApiError(
      422,
      ERROR_CODES.VALIDATION_FAILED,
      'Multiple-choice questions are graded automatically.',
    );
  }

  const awarded = parseMarks(input.awardedMarks);
  const maximum = parseMarks(question.marks);
  if (awarded < 0 || awarded > maximum) {
    throw new ApiError(
      422,
      ERROR_CODES.VALIDATION_FAILED,
      `Marks must be between 0 and ${question.marks}.`,
    );
  }

  await db
    .update(quizAnswers)
    .set({
      awardedMarks: formatMarks(awarded),
      teacherFeedback: input.teacherFeedback ?? null,
      gradedBy: actor.userId,
      gradedAt: sql`now()`,
    })
    .where(and(eq(quizAnswers.attemptId, attemptId), eq(quizAnswers.questionId, questionId)));

  return retotalAttempt(attemptId);
}

/**
 * Recomputes an attempt's total from its per-answer marks and closes it out
 * when nothing is left to grade.
 *
 * The total is summed in integer hundredths. Accumulating `numeric` values as
 * JavaScript floats is how a quiz totalling 12.3 reports 12.299999 and fails a
 * pass mark it should clear.
 */
export async function retotalAttempt(attemptId: string) {
  const db = getDb();

  const attempt = await db.query.quizAttempts.findFirst({
    where: eq(quizAttempts.id, attemptId),
  });
  if (!attempt) throw new ApiError(404, ERROR_CODES.NOT_FOUND);

  const quiz = await db.query.quizzes.findFirst({ where: eq(quizzes.id, attempt.quizId) });
  if (!quiz) throw new ApiError(404, ERROR_CODES.NOT_FOUND);

  const rows = await db
    .select({
      type: quizQuestions.type,
      questionMarks: quizQuestions.marks,
      awardedMarks: quizAnswers.awardedMarks,
      textAnswer: quizAnswers.textAnswer,
      gradedAt: quizAnswers.gradedAt,
    })
    .from(quizQuestions)
    .leftJoin(
      quizAnswers,
      and(eq(quizAnswers.questionId, quizQuestions.id), eq(quizAnswers.attemptId, attemptId)),
    )
    .where(eq(quizQuestions.quizId, quiz.id));

  let auto = 0;
  let manual = 0;
  let max = 0;
  let outstanding = 0;

  for (const row of rows) {
    max += parseMarks(row.questionMarks);
    const awarded = parseMarks(row.awardedMarks);

    if (isAutoGraded(row.type)) {
      auto += awarded;
      continue;
    }

    const written = row.textAnswer?.trim();
    if (written && !row.gradedAt) outstanding++;
    else manual += awarded;
  }

  const total = auto + manual;
  const complete = outstanding === 0;

  const [updated] = await db
    .update(quizAttempts)
    .set({
      autoScore: formatMarks(auto),
      manualScore: formatMarks(manual),
      totalScore: formatMarks(total),
      maxScore: formatMarks(max),
      passed: complete ? percentOf(total, max) >= quiz.passPercentage : null,
      gradingStatus: complete ? 'complete' : 'partial',
    })
    .where(eq(quizAttempts.id, attemptId))
    .returning();

  if (!updated) throw new ApiError(500, ERROR_CODES.INTERNAL);

  if (complete) {
    await recordAudit({
      actorId: attempt.studentId,
      action: 'quiz.graded',
      entityType: 'quiz_attempt',
      entityId: attemptId,
      after: { totalScore: updated.totalScore, passed: updated.passed },
    });

    // Section 15: a graded result is one of the events worth telling the
    // student about. Best-effort — a failed notification must not roll back a
    // grade the teacher just entered.
    await notify({
      userId: attempt.studentId,
      type: 'quiz_graded',
      title: `Your ${quiz.title} result is ready`,
      body: `You scored ${updated.totalScore} out of ${updated.maxScore}.`,
      link: `/learn/quizzes/attempts/${attemptId}`,
    }).catch((err) => console.error('[quiz] grade notification failed:', err));
  }

  return {
    attemptId,
    autoScore: updated.autoScore,
    manualScore: updated.manualScore,
    totalScore: updated.totalScore,
    maxScore: updated.maxScore,
    percent: percentOf(total, max),
    passed: updated.passed,
    gradingStatus: updated.gradingStatus,
    outstanding,
  };
}

/** Best score per student for a quiz — what counts toward completion
 *  (Section 10: "the best attempt counts"). */
export async function bestAttemptFor(studentId: string, quizId: string) {
  const db = getDb();
  const [row] = await db
    .select({
      id: quizAttempts.id,
      totalScore: quizAttempts.totalScore,
      maxScore: quizAttempts.maxScore,
      passed: quizAttempts.passed,
      gradingStatus: quizAttempts.gradingStatus,
    })
    .from(quizAttempts)
    .where(
      and(
        eq(quizAttempts.quizId, quizId),
        eq(quizAttempts.studentId, studentId),
        sql`${quizAttempts.submittedAt} IS NOT NULL`,
      ),
    )
    // Ordered in SQL by the ratio, so a 9/10 beats a 40/100.
    .orderBy(sql`(coalesce(total_score,0) / greatest(coalesce(max_score,1), 1)) DESC`)
    .limit(1);

  return row ?? null;
}

async function requireAttempt(actor: Actor, attemptId: string) {
  const db = getDb();

  const found = await db.query.quizAttempts.findFirst({ where: eq(quizAttempts.id, attemptId) });
  if (!found) throw new ApiError(404, ERROR_CODES.NOT_FOUND, 'Attempt not found.');

  const quiz = await db.query.quizzes.findFirst({ where: eq(quizzes.id, found.quizId) });
  if (!quiz) throw new ApiError(404, ERROR_CODES.NOT_FOUND);

  // Ownership runs through the course, so a teacher can only ever grade their
  // own quizzes.
  await requireCourse(actor, quiz.courseId);
  return { attempt: found, quiz };
}
