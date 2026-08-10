import { setThreadPinned, setThreadResolved } from '@edtech/core';
import { moderateThreadSchema, uuidSchema } from '@edtech/shared';
import { ApiError, ERROR_CODES } from '@edtech/shared';
import { ok, parseBody, route } from '@/lib/api';
import { teacherActor } from '@/lib/teacher';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** POST /api/v1/doubts/:id/moderate — mark resolved, or pin to the top of the
 *  lesson. Both go through the course ownership boundary in core. */
export const POST = route(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const actor = await teacherActor(req);
  const threadId = uuidSchema.parse((await params).id);
  const input = await parseBody(req, moderateThreadSchema);

  if (input.isResolved === undefined && input.isPinned === undefined) {
    throw new ApiError(422, ERROR_CODES.VALIDATION_FAILED, 'Nothing to change.');
  }

  let result;
  if (input.isResolved !== undefined) {
    result = await setThreadResolved(actor, threadId, input.isResolved);
  }
  if (input.isPinned !== undefined) {
    result = await setThreadPinned(actor, threadId, input.isPinned);
  }

  return ok(result);
});
