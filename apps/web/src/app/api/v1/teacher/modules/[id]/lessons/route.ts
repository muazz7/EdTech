import { createLesson } from '@edtech/core';
import { createLessonSchema, uuidSchema } from '@edtech/shared';
import { ok, parseBody, route } from '@/lib/api';
import { teacherActor } from '@/lib/teacher';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** POST /api/v1/teacher/modules/:id/lessons */
export const POST = route(
  async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
    const actor = await teacherActor(req);
    const moduleId = uuidSchema.parse((await params).id);
    const input = await parseBody(req, createLessonSchema);
    return ok(await createLesson(actor, moduleId, input), undefined, 201);
  },
);
