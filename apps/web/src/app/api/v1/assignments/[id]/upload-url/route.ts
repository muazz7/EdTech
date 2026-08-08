import { enforceRate, guardRequest, presignAssignmentUpload } from '@edtech/core';
import { assignmentUploadUrlSchema, uuidSchema } from '@edtech/shared';
import { ok, parseBody, route } from '@/lib/api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/v1/assignments/:id/upload-url
 *
 * The MIME and size checks live in core, against the assignment's own
 * `allowed_mime` — this is the only gate a client cannot skip, since it has to
 * come back for a URL. A file picker's accept attribute is a hint.
 *
 * Rate limited per user: each call mints a signed PUT, and an unlimited supply
 * of those is an unlimited supply of writes to the bucket.
 */
export const POST = route(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const guard = await guardRequest(req.headers);
  const assignmentId = uuidSchema.parse((await params).id);

  await enforceRate('assignment-upload', guard.user.sub, {
    limit: 60,
    windowSeconds: 60 * 60,
  });

  const input = await parseBody(req, assignmentUploadUrlSchema);

  const res = ok(await presignAssignmentUpload(guard.user.sub, assignmentId, input));
  res.headers.set('Cache-Control', 'private, no-store');
  return res;
});
