import { guardRequest, listNotifications, markAllNotificationsRead } from '@edtech/core';
import { ok, route } from '@/lib/api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET /api/v1/me/notifications (Section 18). */
export const GET = route(async (req: Request) => {
  const guard = await guardRequest(req.headers);
  const res = ok(await listNotifications(guard.user.sub));
  res.headers.set('Cache-Control', 'private, no-store');
  return res;
});

/** POST — marks everything read, for a "clear all" control. */
export const POST = route(async (req: Request) => {
  const guard = await guardRequest(req.headers);
  return ok(await markAllNotificationsRead(guard.user.sub));
});
