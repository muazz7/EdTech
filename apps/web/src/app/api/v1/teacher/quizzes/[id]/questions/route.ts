import { addQuestion } from '@edtech/core';
import { createQuestionSchema, uuidSchema } from '@edtech/shared';
import { ok, parseBody, route } from '@/lib/api';
import { teacherActor } from '@/lib/teacher';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** POST /api/v1/teacher/quizzes/:id/questions */
export const POST = route(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const actor = await teacherActor(req);
  const quizId = uuidSchema.parse((await params).id);
  const input = await parseBody(req, createQuestionSchema);
  return ok(await addQuestion(actor, quizId, input), undefined, 201);
});
