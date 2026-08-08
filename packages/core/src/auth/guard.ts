import { and, eq, isNull, sql } from 'drizzle-orm';
import { activeSessions, getDb, profiles, type ActiveSession } from '@edtech/db';
import {
  ApiError,
  ERROR_CODES,
  SESSION_TOUCH_INTERVAL_SECONDS,
  type UserRole,
} from '@edtech/shared';
import { bearerFrom, verifyAccessToken, type AccessClaims } from './tokens.js';

export type GuardResult = {
  user: AccessClaims;
  session: ActiveSession;
};

/**
 * Runs on every /api/v1/* call. Two independent checks:
 *
 *   1. JWT signature and expiry — proves the token was issued by us.
 *   2. X-Session-Id against a live row in active_sessions — proves the session
 *      has not been revoked since. This is what makes single-device
 *      enforcement immediate rather than "on next token refresh".
 *
 * A valid, unexpired token whose session was revoked must still fail. That is
 * the entire point: signing in on a new device kicks the old one out within
 * one request, not within 15 minutes.
 */
export async function guardRequest(headers: Headers): Promise<GuardResult> {
  const claims = await verifyAccessToken(bearerFrom(headers));

  const sessionId = headers.get('x-session-id');
  if (!sessionId) throw new ApiError(401, ERROR_CODES.SESSION_MISSING);

  // The token carries the session it was minted for. If the header disagrees,
  // someone is pairing a token with a different session.
  if (sessionId !== claims.sid) throw new ApiError(401, ERROR_CODES.SESSION_REVOKED);

  const db = getDb();
  const session = await db.query.activeSessions.findFirst({
    where: and(
      eq(activeSessions.id, sessionId),
      eq(activeSessions.userId, claims.sub),
      isNull(activeSessions.revokedAt),
    ),
  });
  if (!session) throw new ApiError(401, ERROR_CODES.SESSION_REVOKED);

  // Throttled write — once per 60s, not on every request. Fire-and-forget:
  // a failed heartbeat must never fail the user's actual request.
  void touchSession(session).catch(() => undefined);

  return { user: claims, session };
}

/** Writes last_active_at at most once per SESSION_TOUCH_INTERVAL_SECONDS. */
async function touchSession(session: ActiveSession): Promise<void> {
  const ageMs = Date.now() - session.lastActiveAt.getTime();
  if (ageMs < SESSION_TOUCH_INTERVAL_SECONDS * 1000) return;

  const db = getDb();
  await db
    .update(activeSessions)
    .set({ lastActiveAt: sql`now()` })
    .where(and(eq(activeSessions.id, session.id), isNull(activeSessions.revokedAt)));
}

/**
 * Role gate for /teacher/* and /admin/*. Checks the live profile, not the JWT
 * claim — a demoted teacher holding a 15-minute-old token must lose access
 * now, not when the token expires.
 */
export async function requireRole(
  guard: GuardResult,
  ...allowed: UserRole[]
): Promise<GuardResult> {
  const db = getDb();
  const profile = await db.query.profiles.findFirst({
    where: eq(profiles.id, guard.user.sub),
    columns: { role: true, isActive: true },
  });

  if (!profile) throw new ApiError(401, ERROR_CODES.UNAUTHENTICATED);
  if (!profile.isActive) throw new ApiError(403, ERROR_CODES.ACCOUNT_DEACTIVATED);
  if (!allowed.includes(profile.role)) {
    throw new ApiError(
      403,
      ERROR_CODES.ROLE_REQUIRED,
      `This action requires one of: ${allowed.join(', ')}.`,
    );
  }

  return { ...guard, user: { ...guard.user, role: profile.role } };
}
