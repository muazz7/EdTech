import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { activeSessions, getDb, profiles, refreshTokens } from '@edtech/db';
import { ApiError, ERROR_CODES, REFRESH_TOKEN_TTL_SECONDS } from '@edtech/shared';
import { signAccessToken } from './tokens.js';

/**
 * Rotating refresh tokens (Section 6.2).
 *
 * The access token lives 15 minutes and is held in memory. The refresh token
 * lives 30 days in an httpOnly cookie (web) or the platform keychain (mobile),
 * and is single-use: redeeming one issues a successor and burns the original.
 */

function ttlSeconds(): number {
  return Number(process.env.REFRESH_TOKEN_TTL ?? REFRESH_TOKEN_TTL_SECONDS);
}

/** Opaque, 256 bits. Not a JWT — there is nothing to read out of it, and a
 *  random string cannot be forged with a leaked signing key. */
function mintSecret(): string {
  return randomBytes(32).toString('base64url');
}

function hash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Constant-time compare, so a mismatch cannot be located by timing. */
function hashEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export type IssuedRefreshToken = {
  token: string;
  familyId: string;
  expiresAt: Date;
};

/** Called at login. Starts a new token family for this session. */
export async function issueRefreshToken(params: {
  userId: string;
  sessionId: string;
  familyId?: string;
}): Promise<IssuedRefreshToken> {
  const db = getDb();
  const token = mintSecret();
  const familyId = params.familyId ?? uuidv7();
  const expiresAt = new Date(Date.now() + ttlSeconds() * 1000);

  await db.insert(refreshTokens).values({
    id: uuidv7(),
    userId: params.userId,
    sessionId: params.sessionId,
    familyId,
    tokenHash: hash(token),
    expiresAt,
  });

  return { token, familyId, expiresAt };
}

export type RefreshResult = {
  accessToken: string;
  refreshToken: string;
  sessionId: string;
  expiresIn: number;
};

/**
 * Redeem a refresh token for a new access token and a successor refresh token.
 *
 * Reuse detection: a token that has already been used, or one that was
 * revoked, means either a replay or a stolen token being redeemed after the
 * legitimate client already rotated. The two are indistinguishable, so the
 * whole family is revoked and the session killed. Section 6.3 already enforces
 * one live session per user, so the cost of a false positive is one login.
 */
export async function rotateRefreshToken(presented: string): Promise<RefreshResult> {
  const db = getDb();
  const presentedHash = hash(presented);

  const row = await db.query.refreshTokens.findFirst({
    where: eq(refreshTokens.tokenHash, presentedHash),
  });

  // Unknown token. Nothing to revoke — there is no family to attribute it to.
  if (!row || !hashEquals(row.tokenHash, presentedHash)) {
    throw new ApiError(401, ERROR_CODES.TOKEN_INVALID, 'This session has expired. Sign in again.');
  }

  if (row.usedAt || row.revokedAt) {
    await revokeFamily(row.familyId, row.usedAt ? 'reuse_detected' : 'already_revoked');
    await revokeSessionForFamily(row.sessionId, 'refresh_token_reuse');
    throw new ApiError(
      401,
      ERROR_CODES.SESSION_REVOKED,
      'This session was ended for security reasons. Sign in again.',
    );
  }

  if (row.expiresAt.getTime() <= Date.now()) {
    throw new ApiError(401, ERROR_CODES.TOKEN_EXPIRED, 'This session has expired. Sign in again.');
  }

  // The refresh token outlives nothing: if the session was revoked by a new
  // device login, refreshing must not resurrect it.
  const session = await db.query.activeSessions.findFirst({
    where: and(eq(activeSessions.id, row.sessionId), isNull(activeSessions.revokedAt)),
  });
  if (!session) {
    await revokeFamily(row.familyId, 'session_revoked');
    throw new ApiError(401, ERROR_CODES.SESSION_REVOKED);
  }

  const profile = await db.query.profiles.findFirst({
    where: eq(profiles.id, row.userId),
    columns: { role: true, isActive: true },
  });
  if (!profile) throw new ApiError(401, ERROR_CODES.UNAUTHENTICATED);
  if (!profile.isActive) throw new ApiError(403, ERROR_CODES.ACCOUNT_DEACTIVATED);

  // Burn and re-issue in one transaction. A crash between the two must not
  // leave the client holding a token that has been consumed but not replaced.
  const successor = await db.transaction(async (tx) => {
    const burned = await tx
      .update(refreshTokens)
      .set({ usedAt: sql`now()` })
      .where(and(eq(refreshTokens.id, row.id), isNull(refreshTokens.usedAt)))
      .returning({ id: refreshTokens.id });

    // Lost the race against a concurrent refresh with the same token.
    if (burned.length === 0) {
      throw new ApiError(401, ERROR_CODES.SESSION_REVOKED);
    }

    const token = mintSecret();
    await tx.insert(refreshTokens).values({
      id: uuidv7(),
      userId: row.userId,
      sessionId: row.sessionId,
      familyId: row.familyId,
      tokenHash: hash(token),
      expiresAt: new Date(Date.now() + ttlSeconds() * 1000),
    });
    return token;
  });

  const accessToken = await signAccessToken({
    sub: row.userId,
    role: profile.role,
    sid: row.sessionId,
  });

  return {
    accessToken,
    refreshToken: successor,
    sessionId: row.sessionId,
    expiresIn: Number(process.env.ACCESS_TOKEN_TTL ?? 900),
  };
}

export async function revokeFamily(familyId: string, reason: string): Promise<number> {
  const db = getDb();
  const rows = await db
    .update(refreshTokens)
    .set({ revokedAt: sql`now()`, revokedReason: reason })
    .where(and(eq(refreshTokens.familyId, familyId), isNull(refreshTokens.revokedAt)))
    .returning({ id: refreshTokens.id });
  return rows.length;
}

/** Revoke every refresh token tied to a session. Called on logout and whenever
 *  a session is revoked, so a live refresh token cannot outlive its session. */
export async function revokeTokensForSession(sessionId: string, reason: string): Promise<number> {
  const db = getDb();
  const rows = await db
    .update(refreshTokens)
    .set({ revokedAt: sql`now()`, revokedReason: reason })
    .where(and(eq(refreshTokens.sessionId, sessionId), isNull(refreshTokens.revokedAt)))
    .returning({ id: refreshTokens.id });
  return rows.length;
}

async function revokeSessionForFamily(sessionId: string, reason: string): Promise<void> {
  const db = getDb();
  await db
    .update(activeSessions)
    .set({ revokedAt: sql`now()`, revokedReason: reason })
    .where(and(eq(activeSessions.id, sessionId), isNull(activeSessions.revokedAt)));
}
