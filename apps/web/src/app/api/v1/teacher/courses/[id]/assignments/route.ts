import { createAssignment, listAssignmentsForCourse } from '@edtech/core';
import { createAssignmentSchema, uuidSchema } from '@edtech/shared';
import { ok, parseBody, route } from '@/lib/api';
import { teacherActor } from '@/lib/teacher';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = route(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const actor = await teacherActor(req);
  const courseId = uuidSchema.parse((await params).id);
  return ok(await listAssignmentsForCourse(actor, courseId));
});

export const POST = route(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const actor = await teacherActor(req);
  const courseId = uuidSchema.parse((await params).id);
  const input = await parseBody(req, createAssignmentSchema);
  return ok(await createAssignment(actor, courseId, input), undefined, 201);
});
