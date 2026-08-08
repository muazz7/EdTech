import { createCourse, listCourses } from '@edtech/core';
import { createCourseSchema } from '@edtech/shared';
import { ok, parseBody, route } from '@/lib/api';
import { teacherActor } from '@/lib/teacher';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET /api/v1/teacher/courses — own courses; admins see all. */
export const GET = route(async (req: Request) => {
  const actor = await teacherActor(req);
  return ok(await listCourses(actor));
});

/** POST /api/v1/teacher/courses */
export const POST = route(async (req: Request) => {
  const actor = await teacherActor(req);
  const input = await parseBody(req, createCourseSchema);
  return ok(await createCourse(actor, input), undefined, 201);
});
