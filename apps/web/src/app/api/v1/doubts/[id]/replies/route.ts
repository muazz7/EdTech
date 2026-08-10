import { guardRequest, replyToThread } from '@edtech/core';
import { createReplySchema, uuidSchema } from '@edtech/shared';
import { ok, parseBody, route } from '@/lib/api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/v1/doubts/:id/replies
 *
 * `is_teacher_answer` is set from the caller's LIVE role, never from the
 * request. That flag is what renders a reply as the authoritative answer, so a
 * client must not be able to claim it.
 */
export const POST = route(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const guard = await guardRequest(req.headers);
  const threadId = uuidSchema.parse((await params).id);
  const input = await parseBody(req, createReplySchema);
  return ok(await replyToThread(guard.user.sub, threadId, input), undefined, 201);
});
