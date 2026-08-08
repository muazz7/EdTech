import { ApiError, ERROR_CODES } from '@edtech/shared';

/**
 * Fixed-window rate limiting (Section 6.4).
 *
 * Two backends, chosen at runtime:
 *
 *   Upstash Redis REST  — when UPSTASH_REDIS_REST_URL and _TOKEN are set. The
 *     only correct choice on Vercel, where every request may hit a different
 *     function instance with its own memory.
 *
 *   In-process Map      — the fallback. Correct for local dev with one server,
 *     and worthless in production: an attacker simply lands on other instances.
 *     It logs a warning once so this cannot be shipped unnoticed.
 *
 * Section 6.4 also says to add Cloudflare rate-limiting rules at the edge. Do
 * both: edge rules stop volumetric abuse before it costs a function
 * invocation, and this layer enforces the per-user and per-phone semantics the
 * edge cannot see.
 */

export type RateRule = { limit: number; windowSeconds: number };

export type RateResult = {
  allowed: boolean;
  remaining: number;
  limit: number;
  /** Seconds until the window resets. Goes into Retry-After. */
  resetSeconds: number;
};

// ── In-process fallback ─────────────────────────────────────────────────────

const memory = new Map<string, { count: number; resetAt: number }>();
let warnedAboutMemory = false;

function memoryHit(key: string, rule: RateRule): RateResult {
  if (!warnedAboutMemory) {
    warnedAboutMemory = true;
    console.warn(
      '[rate-limit] UPSTASH_REDIS_REST_URL not set — using in-process counters. ' +
        'This does NOT rate limit a multi-instance deployment.',
    );
  }

  const now = Date.now();
  const existing = memory.get(key);

  if (!existing || existing.resetAt <= now) {
    const resetAt = now + rule.windowSeconds * 1000;
    memory.set(key, { count: 1, resetAt });
    // Opportunistic sweep so a long-lived dev server does not grow unbounded.
    if (memory.size > 10_000) {
      for (const [k, v] of memory) if (v.resetAt <= now) memory.delete(k);
    }
    return {
      allowed: true,
      remaining: rule.limit - 1,
      limit: rule.limit,
      resetSeconds: rule.windowSeconds,
    };
  }

  existing.count += 1;
  return {
    allowed: existing.count <= rule.limit,
    remaining: Math.max(0, rule.limit - existing.count),
    limit: rule.limit,
    resetSeconds: Math.ceil((existing.resetAt - now) / 1000),
  };
}

// ── Upstash Redis REST ──────────────────────────────────────────────────────

function upstashConfig(): { url: string; token: string } | null {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  return url && token ? { url: url.replace(/\/$/, ''), token } : null;
}

async function upstashHit(
  cfg: { url: string; token: string },
  key: string,
  rule: RateRule,
): Promise<RateResult> {
  // INCR then EXPIRE ... NX in one round trip. NX means the TTL is only set on
  // the first hit of a window, so a burst cannot keep pushing the reset out and
  // extend its own ban indefinitely.
  const res = await fetch(`${cfg.url}/pipeline`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${cfg.token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify([
      ['INCR', key],
      ['EXPIRE', key, String(rule.windowSeconds), 'NX'],
      ['TTL', key],
    ]),
    signal: AbortSignal.timeout(2000),
  });

  if (!res.ok) throw new Error(`Upstash ${res.status}`);

  const body = (await res.json()) as Array<{ result?: number; error?: string }>;
  const count = Number(body[0]?.result ?? 0);
  const ttl = Number(body[2]?.result ?? rule.windowSeconds);

  return {
    allowed: count <= rule.limit,
    remaining: Math.max(0, rule.limit - count),
    limit: rule.limit,
    resetSeconds: ttl > 0 ? ttl : rule.windowSeconds,
  };
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Counts a hit and reports whether it is allowed.
 *
 * FAILS OPEN. If Redis is unreachable, the request proceeds and the failure is
 * logged. Failing closed would let an Upstash outage lock every student out of
 * a platform they paid for, which is a worse outcome than a window of
 * unthrottled requests — Cloudflare's edge rules are still in front.
 */
export async function checkRate(
  bucket: string,
  identifier: string,
  rule: RateRule,
): Promise<RateResult> {
  // Window number in the key: a fixed window needs no stored reset timestamp.
  const window = Math.floor(Date.now() / (rule.windowSeconds * 1000));
  const key = `rl:${bucket}:${identifier}:${window}`;

  const cfg = upstashConfig();
  if (!cfg) return memoryHit(key, rule);

  try {
    return await upstashHit(cfg, key, rule);
  } catch (err) {
    console.error('[rate-limit] Upstash unavailable, failing open:', err);
    return {
      allowed: true,
      remaining: rule.limit,
      limit: rule.limit,
      resetSeconds: rule.windowSeconds,
    };
  }
}

/** checkRate, but throws the 429 so route handlers stay one line. */
export async function enforceRate(
  bucket: string,
  identifier: string,
  rule: RateRule,
): Promise<RateResult> {
  const result = await checkRate(bucket, identifier, rule);
  if (!result.allowed) {
    throw new ApiError(429, ERROR_CODES.RATE_LIMITED, undefined, {
      retryAfterSeconds: result.resetSeconds,
    });
  }
  return result;
}

/** Test-only: clears in-process counters between cases. */
export function __resetMemoryLimiter(): void {
  memory.clear();
}
