import { listSubmissions } from '@edtech/core';
import { uuidSchema } from '@edtech/shared';
import { ok, route } from '@/lib/api';
import { teacherActor } from '@/lib/teacher';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET /api/v1/teacher/assignments/:id/submissions — ungraded first. */
export const GET = route(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const actor = await teacherActor(req);
  const assignmentId = uuidSchema.parse((await params).id);
  const res = ok(await listSubmissions(actor, assignmentId));
  res.headers.set('Cache-Control', 'private, no-store');
  return res;
});
