import { reorderLessons } from '@edtech/core';
import { reorderSchema, uuidSchema } from '@edtech/shared';
import { ok, parseBody, route } from '@/lib/api';
import { teacherActor } from '@/lib/teacher';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/v1/teacher/modules/:id/reorder  { orderedIds }
 *
 * Reorders the LESSONS inside this module. The full ordered set is required and
 * must match the module's current children exactly — see reorder.ts for why
 * that check is a security boundary rather than input hygiene.
 */
export const POST = route(
  async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
    const actor = await teacherActor(req);
    const moduleId = uuidSchema.parse((await params).id);
    const { orderedIds } = await parseBody(req, reorderSchema);
    return ok(await reorderLessons(actor, moduleId, orderedIds));
  },
);
