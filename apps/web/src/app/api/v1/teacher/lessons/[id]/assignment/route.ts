import { createAssignmentForLesson, getLessonAssignmentForTeacher } from '@edtech/core';
import { createAssignmentSchema, uuidSchema } from '@edtech/shared';
import { ok, parseBody, route } from '@/lib/api';
import { teacherActor } from '@/lib/teacher';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET /api/v1/teacher/lessons/:id/assignment — `null` when there is none yet. */
export const GET = route(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const actor = await teacherActor(req);
  const lessonId = uuidSchema.parse((await params).id);
  const res = ok(await getLessonAssignmentForTeacher(actor, lessonId));
  res.headers.set('Cache-Control', 'private, no-store');
  return res;
});

export const POST = route(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const actor = await teacherActor(req);
  const lessonId = uuidSchema.parse((await params).id);
  const { lessonId: _ignored, ...input } = await parseBody(req, createAssignmentSchema);
  return ok(await createAssignmentForLesson(actor, lessonId, input), undefined, 201);
});
