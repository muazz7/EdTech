import { getAttemptResult, guardRequest } from '@edtech/core';
import { uuidSchema } from '@edtech/shared';
import { ok, route } from '@/lib/api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/v1/attempts/:id/result
 *
 * Scoped to the owning student. Explanations appear only when the teacher set
 * `show_answers_after`; otherwise the student sees their score and nothing that
 * would let them reconstruct the key for a reattempt.
 */
export const GET = route(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const guard = await guardRequest(req.headers);
  const attemptId = uuidSchema.parse((await params).id);
  const res = ok(await getAttemptResult(guard.user.sub, attemptId));
  res.headers.set('Cache-Control', 'private, no-store');
  return res;
});
