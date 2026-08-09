import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { getDb, quizAttempts, quizOptions, quizQuestions, quizzes } from '@edtech/db';
import {
  ApiError,
  ERROR_CODES,
  isAutoGraded,
  type CreateQuestionInput,
  type CreateQuizInput,
  type UpdateQuestionInput,
  type UpdateQuizInput,
} from '@edtech/shared';
import { recordAudit } from '../audit/log.js';
import { requireCourse, requireLesson, type Actor } from '../content/ownership.js';

/**
 * Quiz authoring (Section 10).
 *
 * Everything here is teacher-side and returns the answer key freely — that is
 * the whole point of a builder. The student-facing read path lives in
 * quiz-attempt.ts and must never reuse these functions. Keeping the two in
 * separate modules is deliberate: the classic quiz bug is one shared "get quiz"
 * helper that grows a `includeAnswers` flag and eventually gets called with the
 * default from a student route.
 */

/** Nested shape a builder screen needs: quiz, questions, options with the key. */
export async function getQuizForTeacher(actor: Actor, quizId: string) {
  const { quiz } = await requireQuiz(actor, quizId);
  const db = getDb();

  const questions = await db
    .select()
    .from(quizQuestions)
    .where(eq(quizQuestions.quizId, quizId))
    .orderBy(asc(quizQuestions.displayOrder));

  // Scoped to this quiz's questions. An unfiltered select here would return
  // every option row in the database.
  const options = questions.length
    ? await db
        .select()
        .from(quizOptions)
        .where(inArray(quizOptions.questionId, questions.map((q) => q.id)))
        .orderBy(asc(quizOptions.displayOrder))
    : [];

  const byQuestion = new Map<string, typeof options>();
  for (const option of options) {
    const list = byQuestion.get(option.questionId) ?? [];
    list.push(option);
    byQuestion.set(option.questionId, list);
  }

  return {
    ...quiz,
    questions: questions.map((question) => ({
      ...question,
      options: byQuestion.get(question.id) ?? [],
    })),
  };
}

export async function listQuizzesForCourse(actor: Actor, courseId: string) {
  await requireCourse(actor, courseId);
  const db = getDb();

  return db
    .select({
      id: quizzes.id,
      lessonId: quizzes.lessonId,
      title: quizzes.title,
      timeLimitMinutes: quizzes.timeLimitMinutes,
      passPercentage: quizzes.passPercentage,
      maxAttempts: quizzes.maxAttempts,
      isPublished: quizzes.isPublished,
      questionCount: sql<number>`(
        SELECT count(*)::int FROM quiz_questions q WHERE q.quiz_id = ${quizzes.id}
      )`,
      attemptCount: sql<number>`(
        SELECT count(*)::int FROM quiz_attempts a WHERE a.quiz_id = ${quizzes.id}
      )`,
    })
    .from(quizzes)
    .where(eq(quizzes.courseId, courseId))
    .orderBy(asc(quizzes.createdAt));
}

export async function createQuiz(actor: Actor, courseId: string, input: CreateQuizInput) {
  const course = await requireCourse(actor, courseId);
  const db = getDb();

  // A quiz attached to a lesson must belong to the same course, or a teacher
  // could hang their quiz off someone else's lesson id.
  if (input.lessonId) {
    const owned = await requireLesson(actor, input.lessonId);
    if (owned.course.courseId !== course.courseId) {
      throw new ApiError(404, ERROR_CODES.NOT_FOUND, 'Lesson not found.');
    }
    if (owned.type !== 'quiz') {
      throw new ApiError(
        422,
        ERROR_CODES.VALIDATION_FAILED,
        'That lesson is not a quiz lesson. Change its type first.',
      );
    }
  }

  const [created] = await db
    .insert(quizzes)
    .values({
      id: uuidv7(),
      courseId: course.courseId,
      lessonId: input.lessonId ?? null,
      title: input.title,
      instructions: input.instructions ?? null,
      timeLimitMinutes: input.timeLimitMinutes ?? null,
      passPercentage: input.passPercentage,
      maxAttempts: input.maxAttempts,
      shuffleQuestions: input.shuffleQuestions,
      showAnswersAfter: input.showAnswersAfter,
      isPublished: false,
    })
    .returning();

  if (!created) throw new ApiError(500, ERROR_CODES.INTERNAL);
  return created;
}

export async function updateQuiz(actor: Actor, quizId: string, input: UpdateQuizInput) {
  const { quiz } = await requireQuiz(actor, quizId);
  const db = getDb();

  const patch: Record<string, unknown> = {};
  for (const key of [
    'title',
    'instructions',
    'timeLimitMinutes',
    'passPercentage',
    'maxAttempts',
    'shuffleQuestions',
    'showAnswersAfter',
    'isPublished',
  ] as const) {
    if (input[key] !== undefined) patch[key] = input[key];
  }

  if (Object.keys(patch).length === 0) {
    throw new ApiError(422, ERROR_CODES.VALIDATION_FAILED, 'Nothing to update.');
  }

  // Publishing an empty quiz gives students a submit button and no questions.
  if (input.isPublished === true) {
    const [{ count } = { count: 0 }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(quizQuestions)
      .where(eq(quizQuestions.quizId, quizId));

    if (count === 0) {
      throw new ApiError(409, ERROR_CODES.CONFLICT, 'Add at least one question before publishing.');
    }

    const unanswerable = await findUnanswerableQuestions(quizId);
    if (unanswerable.length > 0) {
      throw new ApiError(
        409,
        ERROR_CODES.CONFLICT,
        `${unanswerable.length} multiple-choice question(s) have no correct answer marked.`,
        { questionIds: unanswerable },
      );
    }
  }

  const [updated] = await db.update(quizzes).set(patch).where(eq(quizzes.id, quizId)).returning();
  if (!updated) throw new ApiError(500, ERROR_CODES.INTERNAL);

  // Changing the pass mark or attempt limit after students have attempted it
  // changes results that were already reported, so it is audited.
  if (
    input.isPublished !== undefined ||
    input.passPercentage !== undefined ||
    input.maxAttempts !== undefined
  ) {
    await recordAudit({
      actorId: actor.userId,
      action: 'quiz.settings_change',
      entityType: 'quiz',
      entityId: quizId,
      before: {
        isPublished: quiz.isPublished,
        passPercentage: quiz.passPercentage,
        maxAttempts: quiz.maxAttempts,
      },
      after: {
        isPublished: updated.isPublished,
        passPercentage: updated.passPercentage,
        maxAttempts: updated.maxAttempts,
      },
    });
  }

  return updated;
}

export async function deleteQuiz(actor: Actor, quizId: string) {
  await requireQuiz(actor, quizId);
  const db = getDb();

  // Attempts cascade. A quiz with attempts holds results students have already
  // been shown and that may have counted toward a certificate, so deleting it
  // is audited rather than silent.
  const [{ attempts } = { attempts: 0 }] = await db
    .select({ attempts: sql<number>`count(*)::int` })
    .from(quizAttempts)
    .where(eq(quizAttempts.quizId, quizId));

  await db.delete(quizzes).where(eq(quizzes.id, quizId));

  await recordAudit({
    actorId: actor.userId,
    action: 'quiz.delete',
    entityType: 'quiz',
    entityId: quizId,
    before: { attemptsDestroyed: attempts },
  });

  return { deleted: true, attemptsDestroyed: attempts };
}

// ── Questions ───────────────────────────────────────────────────────────────

export async function addQuestion(actor: Actor, quizId: string, input: CreateQuestionInput) {
  await requireQuiz(actor, quizId);
  assertOptionsMatchType(input.type, input.options);

  const db = getDb();
  const questionId = uuidv7();

  const [{ next } = { next: 1 }] = await db
    .select({ next: sql<number>`coalesce(max(display_order), 0) + 1` })
    .from(quizQuestions)
    .where(eq(quizQuestions.quizId, quizId));

  await db.insert(quizQuestions).values({
    id: questionId,
    quizId,
    type: input.type,
    prompt: input.prompt,
    marks: input.marks,
    explanation: input.explanation ?? null,
    displayOrder: next,
  });

  if (input.options?.length) {
    await db.insert(quizOptions).values(
      input.options.map((option, index) => ({
        id: uuidv7(),
        questionId,
        label: option.label,
        isCorrect: option.isCorrect,
        displayOrder: index + 1,
      })),
    );
  }

  return getQuestion(questionId);
}

export async function updateQuestion(
  actor: Actor,
  questionId: string,
  input: UpdateQuestionInput,
) {
  const { question } = await requireQuestion(actor, questionId);
  const db = getDb();

  const type = input.type ?? (question.type as CreateQuestionInput['type']);
  if (input.options !== undefined || input.type !== undefined) {
    assertOptionsMatchType(type, input.options ?? (await currentOptions(questionId)));
  }

  const patch: Record<string, unknown> = {};
  for (const key of ['type', 'prompt', 'marks', 'explanation'] as const) {
    if (input[key] !== undefined) patch[key] = input[key];
  }
  if (Object.keys(patch).length > 0) {
    await db.update(quizQuestions).set(patch).where(eq(quizQuestions.id, questionId));
  }

  // Options are replaced wholesale rather than patched. A half-updated answer
  // key is worse than a rewritten one, and the builder always holds the full
  // set anyway.
  if (input.options !== undefined) {
    await db.delete(quizOptions).where(eq(quizOptions.questionId, questionId));
    if (input.options.length > 0) {
      await db.insert(quizOptions).values(
        input.options.map((option, index) => ({
          id: uuidv7(),
          questionId,
          label: option.label,
          isCorrect: option.isCorrect,
          displayOrder: index + 1,
        })),
      );
    }
  }

  return getQuestion(questionId);
}

export async function deleteQuestion(actor: Actor, questionId: string) {
  await requireQuestion(actor, questionId);
  await getDb().delete(quizQuestions).where(eq(quizQuestions.id, questionId));
  return { deleted: true };
}

/**
 * Reorders questions. Same rule as module and lesson reordering: the caller
 * sends the complete set, and a list that is not exactly the current children
 * is rejected. See content/reorder.ts — that check is a security boundary, not
 * a convenience.
 */
export async function reorderQuestions(actor: Actor, quizId: string, orderedIds: string[]) {
  await requireQuiz(actor, quizId);
  const db = getDb();

  const current = await db
    .select({ id: quizQuestions.id })
    .from(quizQuestions)
    .where(eq(quizQuestions.quizId, quizId));

  const currentIds = new Set(current.map((row) => row.id));
  const sent = new Set(orderedIds);

  if (
    orderedIds.length !== current.length ||
    sent.size !== orderedIds.length ||
    ![...sent].every((id) => currentIds.has(id))
  ) {
    throw new ApiError(
      422,
      ERROR_CODES.VALIDATION_FAILED,
      'Send exactly the current questions of this quiz, once each.',
    );
  }

  await db.transaction(async (tx) => {
    for (const [index, id] of orderedIds.entries()) {
      await tx
        .update(quizQuestions)
        .set({ displayOrder: index + 1 })
        .where(and(eq(quizQuestions.id, id), eq(quizQuestions.quizId, quizId)));
    }
  });

  return { reordered: orderedIds.length };
}

// ── Internals ───────────────────────────────────────────────────────────────

/** Resolves a quiz through the course ownership boundary. 404 for someone
 *  else's quiz, never 403 — a 403 confirms the id exists. */
export async function requireQuiz(actor: Actor, quizId: string) {
  const db = getDb();
  const quiz = await db.query.quizzes.findFirst({ where: eq(quizzes.id, quizId) });
  if (!quiz) throw new ApiError(404, ERROR_CODES.NOT_FOUND, 'Quiz not found.');

  const course = await requireCourse(actor, quiz.courseId);
  return { quiz, course };
}

async function requireQuestion(actor: Actor, questionId: string) {
  const db = getDb();
  const question = await db.query.quizQuestions.findFirst({
    where: eq(quizQuestions.id, questionId),
  });
  if (!question) throw new ApiError(404, ERROR_CODES.NOT_FOUND, 'Question not found.');

  const { quiz, course } = await requireQuiz(actor, question.quizId);
  return { question, quiz, course };
}

async function currentOptions(questionId: string) {
  const rows = await getDb()
    .select({ label: quizOptions.label, isCorrect: quizOptions.isCorrect })
    .from(quizOptions)
    .where(eq(quizOptions.questionId, questionId));
  return rows;
}

async function getQuestion(questionId: string) {
  const db = getDb();
  const question = await db.query.quizQuestions.findFirst({
    where: eq(quizQuestions.id, questionId),
  });
  if (!question) throw new ApiError(500, ERROR_CODES.INTERNAL);

  const options = await db
    .select()
    .from(quizOptions)
    .where(eq(quizOptions.questionId, questionId))
    .orderBy(asc(quizOptions.displayOrder));

  return { ...question, options };
}

/**
 * A choice question with no correct option can never be answered correctly, and
 * the failure surfaces as a student scoring zero on a question they got right.
 * Caught at authoring time, and again at publish time for questions added
 * before this check existed.
 */
function assertOptionsMatchType(
  type: CreateQuestionInput['type'],
  options: Array<{ isCorrect: boolean }> | undefined,
): void {
  const isChoice = isAutoGraded(type);

  if (!isChoice) {
    if (options && options.length > 0) {
      throw new ApiError(
        422,
        ERROR_CODES.VALIDATION_FAILED,
        'Written-answer questions do not take options.',
      );
    }
    return;
  }

  if (!options || options.length < 2) {
    throw new ApiError(
      422,
      ERROR_CODES.VALIDATION_FAILED,
      'A choice question needs at least two options.',
    );
  }

  const correct = options.filter((option) => option.isCorrect).length;
  if (correct === 0) {
    throw new ApiError(422, ERROR_CODES.VALIDATION_FAILED, 'Mark at least one option correct.');
  }
  if (type !== 'mcq_multi' && correct > 1) {
    throw new ApiError(
      422,
      ERROR_CODES.VALIDATION_FAILED,
      'This question type allows only one correct option. Use multiple-answer instead.',
    );
  }
}

async function findUnanswerableQuestions(quizId: string): Promise<string[]> {
  const db = getDb();
  const rows = await db
    .select({ id: quizQuestions.id, type: quizQuestions.type })
    .from(quizQuestions)
    .where(eq(quizQuestions.quizId, quizId));

  const broken: string[] = [];
  for (const row of rows) {
    if (!isAutoGraded(row.type)) continue;
    const [{ correct } = { correct: 0 }] = await db
      .select({ correct: sql<number>`count(*) FILTER (WHERE is_correct)::int` })
      .from(quizOptions)
      .where(eq(quizOptions.questionId, row.id));
    if (correct === 0) broken.push(row.id);
  }
  return broken;
}

/** Links a quiz lesson to its quiz, so the lesson page can find it. */
export async function getQuizIdForLesson(lessonId: string): Promise<string | null> {
  const db = getDb();
  const row = await db.query.quizzes.findFirst({
    where: eq(quizzes.lessonId, lessonId),
    columns: { id: true },
  });
  return row?.id ?? null;
}

/**
 * The quiz attached to a lesson, with its answer key, for the builder.
 *
 * Returns null rather than throwing when a quiz lesson has no quiz yet — that
 * is the normal state right after the lesson is created, and the builder offers
 * to create one.
 */
export async function getLessonQuizForTeacher(actor: Actor, lessonId: string) {
  const owned = await requireLesson(actor, lessonId);
  const quizId = await getQuizIdForLesson(owned.lessonId);
  if (!quizId) return null;
  return getQuizForTeacher(actor, quizId);
}

/** Creates the quiz for a quiz lesson, inheriting its course. One per lesson —
 *  the schema enforces it with a unique index on `lesson_id`. */
export async function createQuizForLesson(
  actor: Actor,
  lessonId: string,
  input: Omit<CreateQuizInput, 'lessonId'>,
) {
  const owned = await requireLesson(actor, lessonId);

  if (await getQuizIdForLesson(lessonId)) {
    throw new ApiError(409, ERROR_CODES.CONFLICT, 'This lesson already has a quiz.');
  }

  return createQuiz(actor, owned.course.courseId, { ...input, lessonId: owned.lessonId });
}

/** Detaches a quiz from a lesson without destroying its attempts. The FK
 *  cascades on lesson delete, which would take the results with it. */
export async function detachQuizFromLesson(lessonId: string): Promise<void> {
  const db = getDb();
  await db.update(quizzes).set({ lessonId: null }).where(eq(quizzes.lessonId, lessonId));
}
