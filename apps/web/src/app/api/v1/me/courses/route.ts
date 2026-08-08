import { guardRequest, listMyCourses } from '@edtech/core';
import { ok, route } from '@/lib/api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/v1/me/courses — My Courses (Section 2.3).
 *
 * Built from LIVE entitlements rather than purchase history, so a lapsed
 * subscription or a revoked grant drops the course out immediately instead of
 * showing a student a course they can no longer open.
 */
export const GET = route(async (req: Request) => {
  const guard = await guardRequest(req.headers);
  const res = ok(await listMyCourses(guard.user.sub));
  res.headers.set('Cache-Control', 'private, no-store');
  return res;
});
