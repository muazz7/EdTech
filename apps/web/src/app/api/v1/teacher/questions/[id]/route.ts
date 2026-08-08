import { deleteQuestion, updateQuestion } from '@edtech/core';
import { updateQuestionSchema, uuidSchema } from '@edtech/shared';
import { ok, parseBody, route } from '@/lib/api';
import { teacherActor } from '@/lib/teacher';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const PATCH = route(
  async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
    const actor = await teacherActor(req);
    const questionId = uuidSchema.parse((await params).id);
    const input = await parseBody(req, updateQuestionSchema);
    return ok(await updateQuestion(actor, questionId, input));
  },
);

export const DELETE = route(
  async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
    const actor = await teacherActor(req);
    const questionId = uuidSchema.parse((await params).id);
    return ok(await deleteQuestion(actor, questionId));
  },
);
