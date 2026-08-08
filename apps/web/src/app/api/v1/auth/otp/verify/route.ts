import { eq } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { getDb, profiles } from '@edtech/db';
import {
  ApiError,
  ERROR_CODES,
  REFRESH_TOKEN_TTL_SECONDS,
  otpVerifySchema,
} from '@edtech/shared';
import { establishSession, signAccessToken } from '@edtech/core';
import { clientIp, ok, parseBody, route } from '@/lib/api';
import { supabaseAdmin } from '@/lib/supabase';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/v1/auth/otp/verify  →  tokens + sessionId
 *
 * Order matters. The device-switch budget is evaluated inside
 * establishSession BEFORE any token is minted, so a blocked device never
 * receives a usable credential.
 */
export const POST = route(async (req: Request) => {
  const { phone, code, device } = await parseBody(req, otpVerifySchema);

  const { data, error } = await supabaseAdmin().auth.verifyOtp({
    phone,
    token: code,
    type: 'sms',
  });

  if (error || !data.user) {
    const expired = error?.message?.toLowerCase().includes('expired');
    throw new ApiError(401, expired ? ERROR_CODES.OTP_EXPIRED : ERROR_CODES.OTP_INVALID);
  }

  const db = getDb();
  const userId = data.user.id;

  // First OTP login creates the application profile. Supabase auth.users holds
  // credentials; this row holds everything the product cares about.
  let profile = await db.query.profiles.findFirst({ where: eq(profiles.id, userId) });

  if (!profile) {
    [profile] = await db
      .insert(profiles)
      .values({
        id: userId,
        fullName: '',
        phone,
        role: 'student',
      })
      .returning();
  }

  if (!profile) throw new ApiError(500, ERROR_CODES.INTERNAL);
  if (!profile.isActive) throw new ApiError(403, ERROR_CODES.ACCOUNT_DEACTIVATED);

  const { session, revokedSessionId } = await establishSession({
    userId,
    device,
    ipAddress: clientIp(req),
    userAgent: req.headers.get('user-agent'),
  });

  const accessToken = await signAccessToken({
    sub: userId,
    role: profile.role,
    sid: session.id,
  });

  // TODO(Phase 0): push an FCM message to revokedSessionId so the old device
  // logs out immediately rather than on its next request (Section 15).
  void revokedSessionId;

  const refreshToken = uuidv7();
  // TODO(Phase 0): persist the refresh token hash with a 30-day rotating
  // lifetime. Returned here so the mobile client contract is already correct.

  const res = ok({
    accessToken,
    refreshToken,
    sessionId: session.id,
    expiresIn: Number(process.env.ACCESS_TOKEN_TTL ?? 900),
    profileComplete: profile.fullName.length > 0,
  });

  // Web keeps the access token in memory only; the refresh token and session
  // id are httpOnly so an XSS bug cannot read them (Section 6.2).
  const secure = process.env.NODE_ENV === 'production';
  res.cookies.set('refresh_token', refreshToken, {
    httpOnly: true,
    secure,
    sameSite: 'lax',
    path: '/',
    maxAge: REFRESH_TOKEN_TTL_SECONDS,
  });
  res.cookies.set('session_id', session.id, {
    httpOnly: true,
    secure,
    sameSite: 'lax',
    path: '/',
    maxAge: REFRESH_TOKEN_TTL_SECONDS,
  });

  return res;
});
