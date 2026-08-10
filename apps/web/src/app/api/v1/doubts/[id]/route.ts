import { getThread, guardRequest } from '@edtech/core';
import { uuidSchema } from '@edtech/shared';
import { ok, route } from '@/lib/api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/v1/doubts/:id — one thread with its replies.
 *
 * A hidden or private thread answers 404 rather than 403, so a link cannot be
 * used to confirm that a thread exists.
 */
export const GET = route(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const guard = await guardRequest(req.headers);
  const threadId = uuidSchema.parse((await params).id);
  const res = ok(await getThread(guard.user.sub, threadId));
  res.headers.set('Cache-Control', 'private, no-store');
  return res;
});
