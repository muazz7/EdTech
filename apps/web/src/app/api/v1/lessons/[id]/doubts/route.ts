import { createThread, guardRequest, listLessonThreads } from '@edtech/core';
import { createThreadSchema, uuidSchema } from '@edtech/shared';
import { ok, parseBody, route } from '@/lib/api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/v1/lessons/:id/doubts
 *
 * Pinned first, then unresolved, then newest. A teacher pins the threads worth
 * reading before asking, which is what stops the fortieth duplicate.
 */
export const GET = route(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const guard = await guardRequest(req.headers);
  const lessonId = uuidSchema.parse((await params).id);
  const res = ok(await listLessonThreads(guard.user.sub, lessonId));
  res.headers.set('Cache-Control', 'private, no-store');
  return res;
});

/** POST — asks a question. Rate limited to 10 posts per student per day in
 *  core (Section 12): a flooded thread list is worse than no thread list. */
export const POST = route(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const guard = await guardRequest(req.headers);
  const lessonId = uuidSchema.parse((await params).id);
  const input = await parseBody(req, createThreadSchema);
  return ok(await createThread(guard.user.sub, lessonId, input), undefined, 201);
});
