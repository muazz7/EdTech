import { guardRequest, submitAttempt } from '@edtech/core';
import { submitAttemptSchema, uuidSchema } from '@edtech/shared';
import { ok, parseBody, route } from '@/lib/api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/v1/attempts/:id/submit
 *
 * The time limit is enforced here against the database's `started_at` plus a
 * 30-second grace. The countdown the student saw was decoration. Answers
 * arriving after the grace window count as unanswered rather than voiding the
 * whole attempt — discarding it would be indistinguishable from losing it to a
 * bad connection.
 */
export const POST = route(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const guard = await guardRequest(req.headers);
  const attemptId = uuidSchema.parse((await params).id);
  const input = await parseBody(req, submitAttemptSchema);

  const res = ok(await submitAttempt(guard.user.sub, attemptId, input));
  res.headers.set('Cache-Control', 'private, no-store');
  return res;
});
