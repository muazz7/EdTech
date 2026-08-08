import { guardRequest, listMyEntitlements } from '@edtech/core';
import { ok, route } from '@/lib/api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET /api/v1/me/entitlements — what the student holds, including expired and
 *  revoked, for the account screen. */
export const GET = route(async (req: Request) => {
  const guard = await guardRequest(req.headers);
  const res = ok(await listMyEntitlements(guard.user.sub));
  res.headers.set('Cache-Control', 'private, no-store');
  return res;
});
