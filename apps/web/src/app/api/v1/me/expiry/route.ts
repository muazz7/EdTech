import { getExpiryStatus, guardRequest } from '@edtech/core';
import { ok, route } from '@/lib/api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/v1/me/expiry — `null` when nothing is time-limited.
 *
 * One call rather than making every screen work this out from a list of
 * entitlements, so the banner says the same thing everywhere.
 */
export const GET = route(async (req: Request) => {
  const guard = await guardRequest(req.headers);
  const res = ok(await getExpiryStatus(guard.user.sub));
  res.headers.set('Cache-Control', 'private, no-store');
  return res;
});
