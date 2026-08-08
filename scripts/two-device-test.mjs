/**
 * Phase 0 exit criteria (Section 21.2):
 *   "you can log in on two devices and watch the first kick out the second"
 *
 *   node scripts/two-device-test.mjs
 *
 * Requires the dev server on :3000 and a Supabase test phone number.
 */
import { createJar } from './lib/cookie-jar.mjs';

// Persisted so the web device is recognised across runs instead of consuming
// the 4-per-30-days device-switch budget (Section 6.3).
const jar = createJar('dev-web');

const BASE = process.env.BASE_URL ?? 'http://localhost:3000/api/v1';
const PHONE = process.env.TEST_PHONE ?? '8801700000000';
const OTP = process.env.TEST_OTP ?? '123321';

let failures = 0;

function check(label, actual, expected) {
  const pass = actual === expected;
  if (!pass) failures++;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}  (got ${actual}, want ${expected})`);
}

async function call(path, { method = 'GET', body, token, sessionId, noCookies } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  if (sessionId) headers['x-session-id'] = sessionId;

  // /auth/refresh prefers the httpOnly cookie over the body, which is correct
  // for a browser but means the body is ignored whenever a cookie exists.
  // noCookies drives the mobile path, where the token only ever arrives in the
  // body.
  const cookie = noCookies ? undefined : jar.header();
  if (cookie) headers.cookie = cookie;

  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  jar.capture(res);
  jar.save();

  const json = await res.json().catch(() => ({}));
  return { status: res.status, ...json };
}

async function login(label, fingerprint, platform) {
  // Web must NOT send a fingerprint: the server derives it from an httpOnly
  // cookie plus the UA (Section 6.3), and rejects a client-supplied value so a
  // sharer cannot rotate it to evade the device-switch budget. Mobile sends its
  // stable install id.
  const device =
    platform === 'web' ? { label, platform } : { fingerprint, label, platform };

  const r = await call('/auth/otp/verify', {
    method: 'POST',
    body: { phone: PHONE, code: OTP, device },
  });
  if (r.status !== 200) {
    console.log(`  login(${label}) failed:`, r.status, JSON.stringify(r.error));
    return null;
  }
  return r.data;
}

console.log('--- 1. request OTP ---');
const otpReq = await call('/auth/otp/request', { method: 'POST', body: { phone: PHONE } });
// 429 is a pass here: Section 6.4 allows 3 per phone per 15 minutes, and
// repeated script runs share that window. A 429 means the limiter is working.
if (otpReq.status === 429) {
  console.log('PASS  otp/request rate limited (429) â€” limiter active, window shared');
} else {
  check('otp/request returns 200', otpReq.status, 200);
}

console.log('\n--- 2. device A logs in ---');
const a = await login('Device A (Redmi Note 12)', 'fp-device-a-0000000001', 'android');
check('device A got a session', a ? 'yes' : 'no', 'yes');
if (!a) process.exit(1);

const meA1 = await call('/auth/me', { token: a.accessToken, sessionId: a.sessionId });
check('device A can read /auth/me', meA1.status, 200);

console.log('\n--- 3. device B logs in (should kick A) ---');
const b = await login('Device B (Chrome on Windows)', 'fp-device-b-0000000002', 'web');
check('device B got a session', b ? 'yes' : 'no', 'yes');
if (!b) process.exit(1);
check('sessions are different', a.sessionId !== b.sessionId ? 'yes' : 'no', 'yes');

console.log('\n--- 4. THE TEST: A is now dead, B is alive ---');
const meA2 = await call('/auth/me', { token: a.accessToken, sessionId: a.sessionId });
check('device A now rejected', meA2.status, 401);
check('device A error code', meA2.error?.code, 'SESSION_REVOKED');

const meB = await call('/auth/me', { token: b.accessToken, sessionId: b.sessionId });
check('device B still works', meB.status, 200);

console.log('\n--- 5. token/session pairing cannot be forged ---');
const mixed = await call('/auth/me', { token: b.accessToken, sessionId: a.sessionId });
check("B's token + A's session rejected", mixed.status, 401);

const noSession = await call('/auth/me', { token: b.accessToken });
check('missing X-Session-Id rejected', noSession.status, 401);
check('missing session error code', noSession.error?.code, 'SESSION_MISSING');

const noToken = await call('/auth/me', { sessionId: b.sessionId });
check('missing bearer token rejected', noToken.status, 401);

console.log('\n--- 6. refresh rotation (mobile path: token in body) ---');
const rot1 = await call('/auth/refresh', {
  method: 'POST',
  body: { refreshToken: b.refreshToken },
  noCookies: true,
});
check('refresh returns 200', rot1.status, 200);
check('access token is new', rot1.data?.accessToken !== b.accessToken, true);
check('refresh token rotated', rot1.data?.refreshToken !== b.refreshToken, true);
check('session unchanged', rot1.data?.sessionId, b.sessionId);

const rotated = await call('/auth/me', {
  token: rot1.data?.accessToken,
  sessionId: rot1.data?.sessionId,
});
check('rotated access token works', rotated.status, 200);

// Replaying a burned token is indistinguishable from a stolen one being
// redeemed, so the whole family and the session must die.
const replay = await call('/auth/refresh', {
  method: 'POST',
  body: { refreshToken: b.refreshToken },
  noCookies: true,
});
check('replayed refresh token rejected', replay.status, 401);
check('replay error code', replay.error?.code, 'SESSION_REVOKED');

const afterReplay = await call('/auth/me', {
  token: rot1.data?.accessToken,
  sessionId: rot1.data?.sessionId,
});
check('session killed by replay', afterReplay.status, 401);

console.log('\n--- 7. re-login, then logout revokes ---');
const c = await login('Device C (relogin)', 'fp-device-b-0000000002', 'web');
check('device C got a session', c ? 'yes' : 'no', 'yes');
if (!c) process.exit(1);
Object.assign(b, c);

console.log('\n--- 8. logout revokes ---');
const out = await call('/auth/logout', {
  method: 'POST',
  token: b.accessToken,
  sessionId: b.sessionId,
});
check('logout succeeds', out.status, 200);

const afterOut = await call('/auth/me', { token: b.accessToken, sessionId: b.sessionId });
check('B dead after logout', afterOut.status, 401);

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
