import { deleteModule, updateModule } from '@edtech/core';
import { updateModuleSchema, uuidSchema } from '@edtech/shared';
import { ok, parseBody, route } from '@/lib/api';
import { teacherActor } from '@/lib/teacher';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

/** PATCH /api/v1/teacher/modules/:id */
export const PATCH = route(async (req: Request, { params }: Ctx) => {
  const actor = await teacherActor(req);
  const moduleId = uuidSchema.parse((await params).id);
  const input = await parseBody(req, updateModuleSchema);
  return ok(await updateModule(actor, moduleId, input));
});

/**
 * DELETE /api/v1/teacher/modules/:id
 *
 * Cascades to the module's lessons, releasing their vendor video and R2 objects
 * first so nothing is left billing storage for a year (Section 20.5).
 */
export const DELETE = route(async (req: Request, { params }: Ctx) => {
  const actor = await teacherActor(req);
  const moduleId = uuidSchema.parse((await params).id);
  return ok(await deleteModule(actor, moduleId));
});
