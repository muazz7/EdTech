import { deleteLesson, updateLesson } from '@edtech/core';
import { updateLessonSchema, uuidSchema } from '@edtech/shared';
import { ok, parseBody, route } from '@/lib/api';
import { teacherActor } from '@/lib/teacher';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

/**
 * PATCH /api/v1/teacher/lessons/:id
 *
 * Refuses to publish a video whose transcode is not 'ready' — otherwise a
 * student opens a player that cannot start. Changes to is_free and is_published
 * are audited, since both change who can watch without paying.
 */
export const PATCH = route(async (req: Request, { params }: Ctx) => {
  const actor = await teacherActor(req);
  const lessonId = uuidSchema.parse((await params).id);
  const input = await parseBody(req, updateLessonSchema);
  return ok(await updateLesson(actor, lessonId, input));
});

/** DELETE /api/v1/teacher/lessons/:id — releases vendor video and R2 objects. */
export const DELETE = route(async (req: Request, { params }: Ctx) => {
  const actor = await teacherActor(req);
  const lessonId = uuidSchema.parse((await params).id);
  return ok(await deleteLesson(actor, lessonId));
});
