import { getAssignmentForStudent, guardRequest } from '@edtech/core';
import { uuidSchema } from '@edtech/shared';
import { ok, route } from '@/lib/api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET /api/v1/assignments/:id — the brief plus this student's own submission.
 *  File names only; R2 keys are internal. */
export const GET = route(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const guard = await guardRequest(req.headers);
  const assignmentId = uuidSchema.parse((await params).id);
  const res = ok(await getAssignmentForStudent(guard.user.sub, assignmentId));
  res.headers.set('Cache-Control', 'private, no-store');
  return res;
});
