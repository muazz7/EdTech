import { createQuizForLesson, getLessonQuizForTeacher } from '@edtech/core';
import { createQuizSchema, uuidSchema } from '@edtech/shared';
import { ok, parseBody, route } from '@/lib/api';
import { teacherActor } from '@/lib/teacher';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/v1/teacher/lessons/:id/quiz
 *
 * `null` when the lesson has no quiz yet, which is the normal state right after
 * a quiz lesson is created. The builder offers to create one rather than
 * showing an error for something that is not wrong.
 */
export const GET = route(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const actor = await teacherActor(req);
  const lessonId = uuidSchema.parse((await params).id);
  const res = ok(await getLessonQuizForTeacher(actor, lessonId));
  res.headers.set('Cache-Control', 'private, no-store');
  return res;
});

/** POST — creates the quiz for this lesson. One per lesson; the schema enforces
 *  it with a unique index on `lesson_id`. */
export const POST = route(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const actor = await teacherActor(req);
  const lessonId = uuidSchema.parse((await params).id);
  const { lessonId: _ignored, ...input } = await parseBody(req, createQuizSchema);
  return ok(await createQuizForLesson(actor, lessonId, input), undefined, 201);
});
