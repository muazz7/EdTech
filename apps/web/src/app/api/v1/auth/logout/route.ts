import { guardRequest, revokeSession } from '@edtech/core';
import { ok, route } from '@/lib/api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** POST /api/v1/auth/logout */
export const POST = route(async (req: Request) => {
  const { session } = await guardRequest(req.headers);
  await revokeSession(session.id, 'user_logout');

  const res = ok({ loggedOut: true });
  res.cookies.delete('refresh_token');
  res.cookies.delete('session_id');
  return res;
});
