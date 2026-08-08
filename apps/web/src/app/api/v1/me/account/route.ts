import { getAccountSecurity, guardRequest } from '@edtech/core';
import { ok, route } from '@/lib/api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/v1/me/account
 *
 * The signed-in device and the remaining device-switch budget (Section 6.3).
 * Scoped to the caller's own account by the guard — there is no id parameter,
 * so there is nothing to tamper with.
 */
export const GET = route(async (req: Request) => {
  const guard = await guardRequest(req.headers);
  const res = ok(await getAccountSecurity(guard.user.sub, guard.session.id));
  res.headers.set('Cache-Control', 'private, no-store');
  return res;
});
