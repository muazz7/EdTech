import { guardRequest, saveAnswer } from '@edtech/core';
import { saveAnswerSchema, uuidSchema } from '@edtech/shared';
import { ok, parseBody, route } from '@/lib/api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/v1/attempts/:id/answers — autosave (Section 10).
 *
 * Returns `{ saved: true }` and nothing else. A save endpoint that answered
 * "right" or "wrong" would be a free answer key: post each option in turn and
 * read the replies.
 */
export const POST = route(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const guard = await guardRequest(req.headers);
  const attemptId = uuidSchema.parse((await params).id);
  const input = await parseBody(req, saveAnswerSchema);

  const res = ok(await saveAnswer(guard.user.sub, attemptId, input));
  res.headers.set('Cache-Control', 'private, no-store');
  return res;
});
