import { listFreeResources } from '@edtech/core';
import { ok, route } from '@/lib/api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/v1/free-resources — the Free Resource Center (Section 2.3).
 *
 * The conversion funnel: a signed-out visitor can watch a real lesson before
 * deciding. No entitlement check because these lessons are free by definition —
 * a teacher marked them so.
 */
export const GET = route(async () => {
  const res = ok(await listFreeResources());
  res.headers.set('Cache-Control', 'public, max-age=120, stale-while-revalidate=600');
  return res;
});
