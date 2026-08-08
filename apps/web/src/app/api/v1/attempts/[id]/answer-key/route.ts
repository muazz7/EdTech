import { getAttemptAnswerKey, guardRequest } from '@edtech/core';
import { uuidSchema } from '@edtech/shared';
import { ok, route } from '@/lib/api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/v1/attempts/:id/answer-key
 *
 * A separate endpoint on purpose. The result screen can render without ever
 * touching the key, and the key only exists here — after submission, for the
 * owning student, and only when the teacher allowed it. Refused with 404, not
 * 403: telling a student there is a key they may not see invites them to go
 * looking for it.
 */
export const GET = route(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const guard = await guardRequest(req.headers);
  const attemptId = uuidSchema.parse((await params).id);
  const res = ok(await getAttemptAnswerKey(guard.user.sub, attemptId));
  res.headers.set('Cache-Control', 'private, no-store');
  return res;
});
