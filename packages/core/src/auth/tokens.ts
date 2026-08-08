import { SignJWT, jwtVerify, type JWTPayload } from 'jose';
import { ACCESS_TOKEN_TTL_SECONDS, ApiError, ERROR_CODES, type UserRole } from '@edtech/shared';

export type AccessClaims = {
  /** profiles.id */
  sub: string;
  role: UserRole;
  /** active_sessions.id — bound into the token so a stolen token without the
   *  matching X-Session-Id header is still useless. */
  sid: string;
};

function secret(): Uint8Array {
  const raw = process.env.JWT_SECRET;
  if (!raw || raw.length < 32) {
    throw new Error('JWT_SECRET is missing or shorter than 32 characters.');
  }
  return new TextEncoder().encode(raw);
}

export async function signAccessToken(claims: AccessClaims): Promise<string> {
  const ttl = Number(process.env.ACCESS_TOKEN_TTL ?? ACCESS_TOKEN_TTL_SECONDS);
  return new SignJWT({ role: claims.role, sid: claims.sid })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(claims.sub)
    .setIssuedAt()
    .setExpirationTime(`${ttl}s`)
    .sign(secret());
}

export async function verifyAccessToken(token: string): Promise<AccessClaims> {
  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(token, secret(), { algorithms: ['HS256'] }));
  } catch (err) {
    const expired = err instanceof Error && err.name === 'JWTExpired';
    throw new ApiError(401, expired ? ERROR_CODES.TOKEN_EXPIRED : ERROR_CODES.TOKEN_INVALID);
  }

  const { sub, role, sid } = payload as JWTPayload & { role?: string; sid?: string };
  if (!sub || !role || !sid) {
    throw new ApiError(401, ERROR_CODES.TOKEN_INVALID, 'Token is missing required claims.');
  }

  return { sub, role: role as UserRole, sid };
}

/**
 * Extracts the bearer token. Never read the access token from localStorage on
 * the web — an XSS bug there hands an attacker a working session (Section 6.2).
 * Web keeps it in memory; the refresh token lives in an httpOnly cookie.
 */
export function bearerFrom(headers: Headers): string {
  const raw = headers.get('authorization');
  if (!raw?.startsWith('Bearer ')) {
    throw new ApiError(401, ERROR_CODES.UNAUTHENTICATED);
  }
  return raw.slice('Bearer '.length).trim();
}
