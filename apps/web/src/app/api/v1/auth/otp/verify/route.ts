import { eq } from 'drizzle-orm';
import { getDb, profiles } from '@edtech/db';
import {
  ApiError,
  ERROR_CODES,
  RATE_LIMITS,
  REFRESH_TOKEN_TTL_SECONDS,
  otpVerifySchema,
} from '@edtech/shared';
import {
  enforceRate,
  establishSession,
  issueRefreshToken,
  notifySessionRevoked,
  signAccessToken,
} from '@edtech/core';
import { clientIp, ok, parseBody, route } from '@/lib/api';
import { DEVICE_COOKIE, resolveDevice } from '@/lib/device';
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

  // Without this, the 6-digit code is brute-forceable: a million guesses is
  // nothing at HTTP speed. Section 6.4's login limit, keyed by IP and phone.
  const ip = clientIp(req);
  if (ip) await enforceRate('otp-verify-ip', ip, RATE_LIMITS.loginPerIp);
  await enforceRate('otp-verify-phone', phone, RATE_LIMITS.loginPerIp);

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

  // Web fingerprints are derived here, not supplied by the client (Section 6.3).
  const userAgent = req.headers.get('user-agent');
  const { resolved, setCookie } = await resolveDevice(device, userAgent);

  const { session, revokedSessionId } = await establishSession({
    userId,
    device: resolved,
    ipAddress: clientIp(req),
    userAgent,
  });

  const accessToken = await signAccessToken({
    sub: userId,
    role: profile.role,
    sid: session.id,
  });

  // Tell the device we just kicked, so it logs out now rather than on its next
  // request (Section 15). Best-effort: a push failure must not fail the login.
  if (revokedSessionId) {
    await notifySessionRevoked({
      userId,
      revokedSessionId,
      reason: 'new_device',
    }).catch(() => undefined);
  }

  const refresh = await issueRefreshToken({ userId, sessionId: session.id });

  const res = ok({
    accessToken,
    refreshToken: refresh.token,
    sessionId: session.id,
    expiresIn: Number(process.env.ACCESS_TOKEN_TTL ?? 900),
    profileComplete: profile.fullName.length > 0,
  });

  // Web keeps the access token in memory only; the refresh token and session
  // id are httpOnly so an XSS bug cannot read them (Section 6.2).
  const secure = process.env.NODE_ENV === 'production';
  res.cookies.set('refresh_token', refresh.token, {
    httpOnly: true,
    secure,
    sameSite: 'lax',
    path: '/',
    maxAge: REFRESH_TOKEN_TTL_SECONDS,
  });
  if (setCookie) {
    res.cookies.set(DEVICE_COOKIE, setCookie.value, {
      httpOnly: true,
      secure,
      sameSite: 'lax',
      path: '/',
      maxAge: setCookie.maxAge,
    });
  }

  res.cookies.set('session_id', session.id, {
    httpOnly: true,
    secure,
    sameSite: 'lax',
    path: '/',
    maxAge: REFRESH_TOKEN_TTL_SECONDS,
  });

  return res;
});
