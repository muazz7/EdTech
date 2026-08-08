import { evaluateCompletion, guardRequest } from '@edtech/core';
import { uuidSchema } from '@edtech/shared';
import { ok, route } from '@/lib/api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/v1/me/completion/:courseId
 *
 * Read-only: it answers "what is left" without issuing anything. The `missing`
 * list is the point — a bare "not eligible" is a support message.
 */
export const GET = route(
  async (req: Request, { params }: { params: Promise<{ courseId: string }> }) => {
    const guard = await guardRequest(req.headers);
    const courseId = uuidSchema.parse((await params).courseId);
    const res = ok(await evaluateCompletion(guard.user.sub, courseId));
    res.headers.set('Cache-Control', 'private, no-store');
    return res;
  },
);
