import { deleteAssignment, updateAssignment } from '@edtech/core';
import { updateAssignmentSchema, uuidSchema } from '@edtech/shared';
import { ok, parseBody, route } from '@/lib/api';
import { teacherActor } from '@/lib/teacher';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const PATCH = route(
  async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
    const actor = await teacherActor(req);
    const assignmentId = uuidSchema.parse((await params).id);
    const input = await parseBody(req, updateAssignmentSchema);
    return ok(await updateAssignment(actor, assignmentId, input));
  },
);

export const DELETE = route(
  async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
    const actor = await teacherActor(req);
    const assignmentId = uuidSchema.parse((await params).id);
    return ok(await deleteAssignment(actor, assignmentId));
  },
);
