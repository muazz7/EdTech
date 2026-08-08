import { guardRequest, listMyCertificates } from '@edtech/core';
import { ok, route } from '@/lib/api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET /api/v1/me/certificates */
export const GET = route(async (req: Request) => {
  const guard = await guardRequest(req.headers);
  const res = ok(await listMyCertificates(guard.user.sub));
  res.headers.set('Cache-Control', 'private, no-store');
  return res;
});
