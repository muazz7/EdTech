import { createModule } from '@edtech/core';
import { createModuleSchema, uuidSchema } from '@edtech/shared';
import { ok, parseBody, route } from '@/lib/api';
import { teacherActor } from '@/lib/teacher';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** POST /api/v1/teacher/courses/:id/modules */
export const POST = route(
  async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
    const actor = await teacherActor(req);
    const courseId = uuidSchema.parse((await params).id);
    const input = await parseBody(req, createModuleSchema);
    return ok(await createModule(actor, courseId, input), undefined, 201);
  },
);
