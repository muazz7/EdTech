import { listActivePlans } from '@edtech/core';
import { ok, route } from '@/lib/api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET /api/v1/plans — active plans for the pricing screen (Section 18). */
export const GET = route(async () => {
  const res = ok(await listActivePlans());
  res.headers.set('Cache-Control', 'public, max-age=300, stale-while-revalidate=900');
  return res;
});
