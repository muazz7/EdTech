import { guardRequest, markNotificationRead } from '@edtech/core';
import { uuidSchema } from '@edtech/shared';
import { ok, route } from '@/lib/api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/v1/me/notifications/:id/read
 *
 * Scoped to the owner. Without the user predicate this would mark any
 * notification read by id, which is a cross-account write.
 */
export const POST = route(
  async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
    const guard = await guardRequest(req.headers);
    const id = uuidSchema.parse((await params).id);
    return ok(await markNotificationRead(guard.user.sub, id));
  },
);
