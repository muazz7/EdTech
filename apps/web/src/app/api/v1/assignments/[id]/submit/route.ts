import { guardRequest, submitAssignment } from '@edtech/core';
import { submitAssignmentSchema, uuidSchema } from '@edtech/shared';
import { ok, parseBody, route } from '@/lib/api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/v1/assignments/:id/submit
 *
 * Resubmission is open until a teacher awards a mark, then locked (ADR 0004).
 * MIME, size and key ownership are re-checked here, not only at presign: the
 * presign response is a URL a client could hold while the rules change.
 */
export const POST = route(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const guard = await guardRequest(req.headers);
  const assignmentId = uuidSchema.parse((await params).id);
  const input = await parseBody(req, submitAssignmentSchema);

  const res = ok(await submitAssignment(guard.user.sub, assignmentId, input), undefined, 201);
  res.headers.set('Cache-Control', 'private, no-store');
  return res;
});
