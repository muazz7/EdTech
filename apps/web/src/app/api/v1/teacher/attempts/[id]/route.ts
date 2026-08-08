import { getAttemptForGrading } from '@edtech/core';
import { uuidSchema } from '@edtech/shared';
import { ok, route } from '@/lib/api';
import { teacherActor } from '@/lib/teacher';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET /api/v1/teacher/attempts/:id — one attempt, ready to mark. */
export const GET = route(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const actor = await teacherActor(req);
  const attemptId = uuidSchema.parse((await params).id);
  const res = ok(await getAttemptForGrading(actor, attemptId));
  res.headers.set('Cache-Control', 'private, no-store');
  return res;
});
