import { cookies } from 'next/headers';
import { rotateRefreshToken } from '@edtech/core';
import { ApiError, ERROR_CODES, REFRESH_TOKEN_TTL_SECONDS, refreshSchema } from '@edtech/shared';
import { ok, route } from '@/lib/api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/v1/auth/refresh
 *
 * Two client shapes, one handler:
 *   - Mobile sends { refreshToken } in the body (it holds the token in the
 *     platform keychain).
 *   - Web sends nothing and relies on the httpOnly cookie, because JS on the
 *     page must not be able to read the token.
 *
 * Single-use. Redeeming rotates: the presented token is burned and a successor
 * issued. Presenting a burned token revokes the whole family and kills the
 * session — see rotateRefreshToken for why that is the right trade.
 */
export const POST = route(async (req: Request) => {
  const jar = await cookies();
  const fromCookie = jar.get('refresh_token')?.value;

  let presented = fromCookie;
  if (!presented) {
    const raw = await req.json().catch(() => null);
    const parsed = refreshSchema.safeParse(raw);
    if (!parsed.success) {
      throw new ApiError(
        401,
        ERROR_CODES.UNAUTHENTICATED,
        'No refresh token supplied. Sign in again.',
      );
    }
    presented = parsed.data.refreshToken;
  }

  const result = await rotateRefreshToken(presented);

  const res = ok({
    accessToken: result.accessToken,
    // Mobile reads this. Web ignores it and uses the rotated cookie below.
    refreshToken: result.refreshToken,
    sessionId: result.sessionId,
    expiresIn: result.expiresIn,
  });

  const secure = process.env.NODE_ENV === 'production';
  res.cookies.set('refresh_token', result.refreshToken, {
    httpOnly: true,
    secure,
    sameSite: 'lax',
    path: '/',
    maxAge: REFRESH_TOKEN_TTL_SECONDS,
  });

  return res;
});
