import { guardRequest, resolveAdmin, type AdminActor } from '@edtech/core';

/**
 * Authenticates and resolves the platform Owner for /api/v1/admin/*.
 *
 * Same two steps as teacherActor, and for the same reasons: guardRequest proves
 * the session is live, and resolveAdmin reads the role from the database rather
 * than the JWT claim, so a demoted admin loses the console immediately instead
 * of when their 15-minute token expires.
 */
export async function adminActor(req: Request): Promise<AdminActor> {
  const guard = await guardRequest(req.headers);
  return resolveAdmin(guard.user.sub);
}
