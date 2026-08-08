import { createQuiz, listQuizzesForCourse } from '@edtech/core';
import { createQuizSchema, uuidSchema } from '@edtech/shared';
import { ok, parseBody, route } from '@/lib/api';
import { teacherActor } from '@/lib/teacher';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET /api/v1/teacher/courses/:id/quizzes */
export const GET = route(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const actor = await teacherActor(req);
  const courseId = uuidSchema.parse((await params).id);
  return ok(await listQuizzesForCourse(actor, courseId));
});

/** POST /api/v1/teacher/courses/:id/quizzes */
export const POST = route(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const actor = await teacherActor(req);
  const courseId = uuidSchema.parse((await params).id);
  const input = await parseBody(req, createQuizSchema);
  return ok(await createQuiz(actor, courseId, input), undefined, 201);
});
