import { createHmac, randomUUID } from 'node:crypto';

/**
 * Mints a student session for the dev scripts.
 *
 * Only ONE Supabase test phone number is configured, and it is used by the
 * teacher. Rather than adding fixture phone numbers to the Auth settings, this
 * signs an access token with JWT_SECRET and inserts the matching
 * active_sessions row — exactly what /auth/otp/verify would have produced.
 *
 * DEV ONLY, and only sound because the script already holds JWT_SECRET. It
 * bypasses OTP and the device-switch budget, so it exercises everything AFTER
 * authentication and nothing before it. The auth path itself is covered by
 * two-device-test.mjs.
 */

function base64url(input) {
  return Buffer.from(input).toString('base64url');
}

function signHs256(payload, secret) {
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = base64url(JSON.stringify(payload));
  const signature = createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${signature}`;
}

export async function createStudentSession(sql, userId, role = 'student') {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET must be set to mint a test session.');

  const sessionId = randomUUID();

  // Revoke first, exactly as login does. `one_live_session_per_user` is a
  // partial unique index, so inserting a second live session for a user who
  // already has one is rejected by the database — which is the index working,
  // not something to route around.
  await sql`
    UPDATE active_sessions SET revoked_at = now(), revoked_reason = 'smoke_script'
    WHERE user_id = ${userId} AND revoked_at IS NULL`;

  await sql`
    INSERT INTO active_sessions (id, user_id, device_fingerprint, device_label, platform)
    VALUES (${sessionId}, ${userId}, ${`smoke-${sessionId.slice(0, 8)}`}, 'Smoke script', 'web')`;

  const now = Math.floor(Date.now() / 1000);
  const token = signHs256(
    { sub: userId, role, sid: sessionId, iat: now, exp: now + 900 },
    secret,
  );

  return { token, sessionId };
}
