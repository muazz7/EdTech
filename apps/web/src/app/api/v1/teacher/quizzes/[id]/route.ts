import { deleteQuiz, getQuizForTeacher, updateQuiz } from '@edtech/core';
import { updateQuizSchema, uuidSchema } from '@edtech/shared';
import { ok, parseBody, route } from '@/lib/api';
import { teacherActor } from '@/lib/teacher';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/v1/teacher/quizzes/:id
 *
 * Returns the answer key. That is correct here and only here — a builder cannot
 * author without it. The student-facing shape is built by a different module
 * (quiz-attempt.ts) precisely so the two can never be confused.
 */
export const GET = route(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const actor = await teacherActor(req);
  const quizId = uuidSchema.parse((await params).id);
  const res = ok(await getQuizForTeacher(actor, quizId));
  res.headers.set('Cache-Control', 'private, no-store');
  return res;
});

export const PATCH = route(
  async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
    const actor = await teacherActor(req);
    const quizId = uuidSchema.parse((await params).id);
    const input = await parseBody(req, updateQuizSchema);
    return ok(await updateQuiz(actor, quizId, input));
  },
);

export const DELETE = route(
  async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
    const actor = await teacherActor(req);
    const quizId = uuidSchema.parse((await params).id);
    return ok(await deleteQuiz(actor, quizId));
  },
);
