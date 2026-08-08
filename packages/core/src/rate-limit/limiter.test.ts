import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { ApiError } from '@edtech/shared';
import { __resetMemoryLimiter, checkRate, enforceRate } from './limiter.js';

/**
 * In-process backend only. Exercising the Upstash path would need a live Redis
 * and would test their service rather than this logic; what matters here is
 * that the window arithmetic and the throw are right.
 */

const RULE = { limit: 3, windowSeconds: 60 };

beforeEach(() => {
  __resetMemoryLimiter();
});

describe('checkRate', () => {
  it('allows up to the limit and denies past it', async () => {
    for (let i = 1; i <= 3; i++) {
      const r = await checkRate('test', 'user-1', RULE);
      assert.equal(r.allowed, true, `hit ${i} should be allowed`);
      assert.equal(r.remaining, 3 - i);
    }

    const over = await checkRate('test', 'user-1', RULE);
    assert.equal(over.allowed, false);
    assert.equal(over.remaining, 0);
  });

  it('counts identifiers separately', async () => {
    for (let i = 0; i < 3; i++) await checkRate('test', 'user-a', RULE);

    // One student exhausting their OTP budget must not lock out everyone else.
    const other = await checkRate('test', 'user-b', RULE);
    assert.equal(other.allowed, true);
    assert.equal(other.remaining, 2);
  });

  it('counts buckets separately', async () => {
    for (let i = 0; i < 3; i++) await checkRate('otp-phone', 'x', RULE);

    const different = await checkRate('otp-verify-phone', 'x', RULE);
    assert.equal(different.allowed, true);
  });

  it('reports a reset window', async () => {
    const r = await checkRate('test', 'user-reset', RULE);
    assert.ok(r.resetSeconds > 0 && r.resetSeconds <= 60);
  });
});

describe('enforceRate', () => {
  it('throws 429 RATE_LIMITED past the limit', async () => {
    for (let i = 0; i < 3; i++) await enforceRate('test', 'user-throw', RULE);

    await assert.rejects(
      () => enforceRate('test', 'user-throw', RULE),
      (err: unknown) => {
        assert.ok(err instanceof ApiError);
        assert.equal(err.status, 429);
        assert.equal(err.code, 'RATE_LIMITED');
        // The client needs to know how long to wait, not just that it failed.
        const details = err.details as { retryAfterSeconds?: number };
        assert.ok(typeof details?.retryAfterSeconds === 'number');
        return true;
      },
    );
  });

  it('does not throw inside the limit', async () => {
    const r = await enforceRate('test', 'user-ok', RULE);
    assert.equal(r.allowed, true);
  });
});
