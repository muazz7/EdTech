import { eq } from 'drizzle-orm';
import { getDb, profiles } from '@edtech/db';
import { guardRequest } from '@edtech/core';
import { ApiError, ERROR_CODES } from '@edtech/shared';
import { ok, route } from '@/lib/api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/v1/auth/me
 *
 * Also the canary the mobile client polls: a 401 SESSION_REVOKED here means
 * another device took over, and the dio interceptor clears storage and routes
 * to login.
 */
export const GET = route(async (req: Request) => {
  const { user } = await guardRequest(req.headers);

  const db = getDb();
  const profile = await db.query.profiles.findFirst({
    where: eq(profiles.id, user.sub),
    columns: {
      id: true,
      fullName: true,
      phone: true,
      email: true,
      role: true,
      avatarUrl: true,
      institution: true,
      isActive: true,
    },
  });

  if (!profile) throw new ApiError(401, ERROR_CODES.UNAUTHENTICATED);
  if (!profile.isActive) throw new ApiError(403, ERROR_CODES.ACCOUNT_DEACTIVATED);

  const { isActive: _isActive, ...me } = profile;
  return ok(me);
});
