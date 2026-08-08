import { reorderModules } from '@edtech/core';
import { reorderSchema, uuidSchema } from '@edtech/shared';
import { ok, parseBody, route } from '@/lib/api';
import { teacherActor } from '@/lib/teacher';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/v1/teacher/courses/:id/reorder-modules  { orderedIds }
 *
 * Section 18 lists only `POST /teacher/modules/:id/reorder`, which is ambiguous
 * about which level it reorders. Section 2.2 requires drag-and-drop at BOTH
 * levels, so the two are split explicitly:
 *
 *   this route                      -> modules within a course
 *   /teacher/modules/:id/reorder    -> lessons within a module
 */
export const POST = route(
  async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
    const actor = await teacherActor(req);
    const courseId = uuidSchema.parse((await params).id);
    const { orderedIds } = await parseBody(req, reorderSchema);
    return ok(await reorderModules(actor, courseId, orderedIds));
  },
);
