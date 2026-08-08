import { guardRequest, resolveActor, type Actor } from '@edtech/core';

/**
 * Authenticates and resolves a teacher/admin actor for /api/v1/teacher/*.
 *
 * Two steps on purpose: guardRequest proves the session is live (so a device
 * that was kicked cannot keep editing a course), and resolveActor reads the
 * live role from the database rather than the JWT claim (so a demoted teacher
 * loses access immediately, not when their 15-minute token expires).
 */
export async function teacherActor(req: Request): Promise<Actor> {
  const guard = await guardRequest(req.headers);
  return resolveActor(guard.user.sub);
}
