import { guardRequest, reportPost } from '@edtech/core';
import { reportPostSchema } from '@edtech/shared';
import { ok, parseBody, route } from '@/lib/api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/v1/doubts/report
 *
 * One report per student per target, enforced by a unique index. A duplicate
 * answers success rather than an error: telling a student they already reported
 * something invites a second attempt and changes nothing.
 */
export const POST = route(async (req: Request) => {
  const guard = await guardRequest(req.headers);
  const input = await parseBody(req, reportPostSchema);

  return ok(
    await reportPost(
      guard.user.sub,
      {
        ...(input.threadId ? { threadId: input.threadId } : {}),
        ...(input.replyId ? { replyId: input.replyId } : {}),
      },
      input.reason,
    ),
  );
});
