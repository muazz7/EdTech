import { reorderQuestions } from '@edtech/core';
import { reorderSchema, uuidSchema } from '@edtech/shared';
import { ok, parseBody, route } from '@/lib/api';
import { teacherActor } from '@/lib/teacher';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/v1/teacher/quizzes/:id/reorder
 *
 * The full ordered set is sent, and a list that is not exactly the current
 * questions is rejected. Same rule as module and lesson reordering — see
 * content/reorder.ts for why that check is a security boundary.
 */
export const POST = route(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const actor = await teacherActor(req);
  const quizId = uuidSchema.parse((await params).id);
  const { orderedIds } = await parseBody(req, reorderSchema);
  return ok(await reorderQuestions(actor, quizId, orderedIds));
});
