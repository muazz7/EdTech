import { getCurriculum, updateCourse } from '@edtech/core';
import { updateCourseSchema, uuidSchema } from '@edtech/shared';
import { clientIp, ok, parseBody, route } from '@/lib/api';
import { teacherActor } from '@/lib/teacher';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

/** GET /api/v1/teacher/courses/:id — curriculum tree for the builder. */
export const GET = route(async (req: Request, { params }: Ctx) => {
  const actor = await teacherActor(req);
  const courseId = uuidSchema.parse((await params).id);
  return ok(await getCurriculum(actor, courseId));
});

/**
 * PATCH /api/v1/teacher/courses/:id
 *
 * The IP is passed through so a price change lands in the audit log with its
 * origin (ADR 0002).
 */
export const PATCH = route(async (req: Request, { params }: Ctx) => {
  const actor = await teacherActor(req);
  const courseId = uuidSchema.parse((await params).id);
  const input = await parseBody(req, updateCourseSchema);
  return ok(await updateCourse(actor, courseId, input, clientIp(req)));
});
