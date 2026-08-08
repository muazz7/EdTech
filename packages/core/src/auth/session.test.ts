import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { and, eq, isNull } from 'drizzle-orm';
import { activeSessions, closeDb, getDb } from '@edtech/db';
import { ApiError } from '@edtech/shared';
import { guardRequest } from './guard.js';
import { establishSession, revokeSession } from './session.js';
import { evaluateDevicePolicy } from './device-policy.js';
import { issueRefreshToken, rotateRefreshToken } from './refresh.js';
import { signAccessToken } from './tokens.js';
import { cleanup, createUser } from '../testing/fixtures.js';

/**
 * Section 19.4, test 3: "Session guard -- revoked session returns 401;
 * concurrent login revokes the old one."
 *
 * Extended to cover the device-switch budget and refresh-token rotation, since
 * both are part of the same credential lifecycle.
 */

after(async () => {
  await cleanup();
  await closeDb();
});

function headers(token: string, sessionId?: string): Headers {
  const h = new Headers({ authorization: `Bearer ${token}` });
  if (sessionId) h.set('x-session-id', sessionId);
  return h;
}

async function login(userId: string, fingerprint: string, platform = 'web') {
  const { session, revokedSessionId } = await establishSession({
    userId,
    device: { fingerprint, label: fingerprint, platform: platform as 'web' },
    ipAddress: null,
    userAgent: 'node-test',
  });
  const token = await signAccessToken({ sub: userId, role: 'student', sid: session.id });
  return { session, token, revokedSessionId };
}

/** Asserts the thrown value is an ApiError with the expected status and code. */
async function assertApiError(fn: () => Promise<unknown>, status: number, code: string) {
  await assert.rejects(fn, (err: unknown) => {
    assert.ok(err instanceof ApiError, `expected ApiError, got ${String(err)}`);
    assert.equal(err.status, status);
    assert.equal(err.code, code);
    return true;
  });
}

describe('session guard', () => {
  it('accepts a live session', async () => {
    const user = await createUser();
    const a = await login(user.id, 'fp-guard-live');
    const result = await guardRequest(headers(a.token, a.session.id));
    assert.equal(result.user.sub, user.id);
    assert.equal(result.session.id, a.session.id);
  });

  it('rejects a missing X-Session-Id', async () => {
    const user = await createUser();
    const a = await login(user.id, 'fp-guard-nosid');
    await assertApiError(() => guardRequest(headers(a.token)), 401, 'SESSION_MISSING');
  });

  it('rejects a missing bearer token', async () => {
    await assertApiError(() => guardRequest(new Headers()), 401, 'UNAUTHENTICATED');
  });

  it('rejects a garbage token', async () => {
    await assertApiError(
      () => guardRequest(headers('not.a.jwt', '00000000-0000-7000-8000-000000000000')),
      401,
      'TOKEN_INVALID',
    );
  });

  it('rejects a revoked session even though the token is still valid', async () => {
    // The whole point of the X-Session-Id check: a 15-minute access token must
    // not outlive its session by up to 15 minutes.
    const user = await createUser();
    const a = await login(user.id, 'fp-guard-revoked');
    await revokeSession(a.session.id, 'test');
    await assertApiError(
      () => guardRequest(headers(a.token, a.session.id)),
      401,
      'SESSION_REVOKED',
    );
  });

  it('rejects a token paired with a different session', async () => {
    const user = await createUser();
    const a = await login(user.id, 'fp-guard-mix-a');
    const b = await login(user.id, 'fp-guard-mix-b');
    // b's token carries sid=b. Presenting it with a's session id must fail even
    // though both belong to the same user.
    await assertApiError(
      () => guardRequest(headers(b.token, a.session.id)),
      401,
      'SESSION_REVOKED',
    );
  });
});

describe('single live session', () => {
  it('revokes the previous session on a new-device login', async () => {
    const user = await createUser();
    const a = await login(user.id, 'fp-single-a');
    const b = await login(user.id, 'fp-single-b');

    assert.equal(b.revokedSessionId, a.session.id);

    const db = getDb();
    const old = await db.query.activeSessions.findFirst({
      where: eq(activeSessions.id, a.session.id),
    });
    assert.ok(old?.revokedAt, 'old session should be revoked');
    assert.equal(old?.revokedReason, 'new_device');
  });

  it('leaves exactly one live session after repeated logins', async () => {
    // Enforced by the partial unique index one_live_session_per_user, not by
    // application code. If this ever fails, the revoke step was skipped.
    const user = await createUser();
    for (const fp of ['fp-many-1', 'fp-many-2', 'fp-many-3']) {
      await login(user.id, fp);
    }

    const db = getDb();
    const live = await db
      .select({ id: activeSessions.id })
      .from(activeSessions)
      .where(and(eq(activeSessions.userId, user.id), isNull(activeSessions.revokedAt)));

    assert.equal(live.length, 1);
  });

  it('the kicked device cannot act after being kicked', async () => {
    const user = await createUser();
    const a = await login(user.id, 'fp-kick-a');
    const b = await login(user.id, 'fp-kick-b');

    await assertApiError(
      () => guardRequest(headers(a.token, a.session.id)),
      401,
      'SESSION_REVOKED',
    );
    const stillOk = await guardRequest(headers(b.token, b.session.id));
    assert.equal(stillOk.session.id, b.session.id);
  });
});

describe('device-switch budget', () => {
  it('allows the first 4 distinct devices and blocks the 5th', async () => {
    // Section 6.3: last-login-wins alone does not stop two students taking
    // turns on one account. Switching friction is what does.
    const user = await createUser();
    for (let i = 1; i <= 4; i++) {
      await login(user.id, `fp-budget-${i}`);
    }

    const policy = await evaluateDevicePolicy(user.id, 'fp-budget-5');
    assert.equal(policy.distinctDevices, 4);
    assert.equal(policy.isKnownDevice, false);
    assert.equal(policy.allowed, false);

    await assertApiError(
      () => login(user.id, 'fp-budget-5'),
      403,
      'DEVICE_LIMIT_REACHED',
    );
  });

  it('lets a student return to an already-seen device for free', async () => {
    const user = await createUser();
    for (let i = 1; i <= 4; i++) {
      await login(user.id, `fp-known-${i}`);
    }

    const policy = await evaluateDevicePolicy(user.id, 'fp-known-1');
    assert.equal(policy.isKnownDevice, true);
    assert.equal(policy.allowed, true);

    // A legitimate student rotating between their phone and laptop must never
    // hit the wall.
    const back = await login(user.id, 'fp-known-1');
    assert.ok(back.session.id);
  });
});

describe('refresh token rotation', () => {
  it('rotates and returns a working access token', async () => {
    const user = await createUser();
    const a = await login(user.id, 'fp-refresh-ok');
    const issued = await issueRefreshToken({ userId: user.id, sessionId: a.session.id });

    const rotated = await rotateRefreshToken(issued.token);
    assert.equal(rotated.sessionId, a.session.id);
    assert.notEqual(rotated.refreshToken, issued.token);

    const guarded = await guardRequest(headers(rotated.accessToken, rotated.sessionId));
    assert.equal(guarded.user.sub, user.id);
  });

  it('rejects an unknown token', async () => {
    await assertApiError(() => rotateRefreshToken('nonsense-token-value'), 401, 'TOKEN_INVALID');
  });

  it('kills the session when a used token is replayed', async () => {
    // A burned token presented again is either a replay or a stolen token
    // redeemed after the real client rotated. Indistinguishable, so revoke.
    const user = await createUser();
    const a = await login(user.id, 'fp-refresh-replay');
    const issued = await issueRefreshToken({ userId: user.id, sessionId: a.session.id });

    const rotated = await rotateRefreshToken(issued.token);

    await assertApiError(() => rotateRefreshToken(issued.token), 401, 'SESSION_REVOKED');

    // The successor must die with the family, not just the replayed token.
    await assertApiError(
      () => rotateRefreshToken(rotated.refreshToken),
      401,
      'SESSION_REVOKED',
    );

    // And the session itself is gone.
    await assertApiError(
      () => guardRequest(headers(a.token, a.session.id)),
      401,
      'SESSION_REVOKED',
    );
  });

  it('refuses to resurrect a session revoked by a new-device login', async () => {
    const user = await createUser();
    const a = await login(user.id, 'fp-refresh-stale-a');
    const issued = await issueRefreshToken({ userId: user.id, sessionId: a.session.id });

    await login(user.id, 'fp-refresh-stale-b');

    await assertApiError(() => rotateRefreshToken(issued.token), 401, 'SESSION_REVOKED');
  });

  it('revokes refresh tokens on logout', async () => {
    const user = await createUser();
    const a = await login(user.id, 'fp-refresh-logout');
    const issued = await issueRefreshToken({ userId: user.id, sessionId: a.session.id });

    await revokeSession(a.session.id, 'user_logout');

    await assertApiError(() => rotateRefreshToken(issued.token), 401, 'SESSION_REVOKED');
  });

  it('rejects an expired token', async () => {
    const user = await createUser();
    const a = await login(user.id, 'fp-refresh-expired');

    const previous = process.env.REFRESH_TOKEN_TTL;
    process.env.REFRESH_TOKEN_TTL = '-1';
    const issued = await issueRefreshToken({ userId: user.id, sessionId: a.session.id });
    if (previous === undefined) delete process.env.REFRESH_TOKEN_TTL;
    else process.env.REFRESH_TOKEN_TTL = previous;

    await assertApiError(() => rotateRefreshToken(issued.token), 401, 'TOKEN_EXPIRED');
  });
});
