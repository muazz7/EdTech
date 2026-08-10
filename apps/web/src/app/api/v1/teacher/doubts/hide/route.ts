import { hidePost } from '@edtech/core';
import { hidePostSchema } from '@edtech/shared';
import { ApiError, ERROR_CODES } from '@edtech/shared';
import { ok, parseBody, route } from '@/lib/api';
import { teacherActor } from '@/lib/teacher';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/v1/teacher/doubts/hide
 *
 * Hides, never deletes. A student whose question was taken down will ask why,
 * and the record has to survive that conversation — a delete would also take
 * every reply with it, including a teacher's answer other students were relying
 * on.
 */
export const POST = route(async (req: Request) => {
  const actor = await teacherActor(req);
  const input = await parseBody(req, hidePostSchema);

  if (Boolean(input.threadId) === Boolean(input.replyId)) {
    throw new ApiError(422, ERROR_CODES.VALIDATION_FAILED, 'Hide either a thread or a reply.');
  }

  return ok(
    await hidePost(
      actor,
      {
        ...(input.threadId ? { threadId: input.threadId } : {}),
        ...(input.replyId ? { replyId: input.replyId } : {}),
      },
      input.reason,
    ),
  );
});
