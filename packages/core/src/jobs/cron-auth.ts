import { timingSafeEqual } from 'node:crypto';
import { ApiError, ERROR_CODES } from '@edtech/shared';

/**
 * Section 18: /cron/* is protected by a bearer secret Vercel sends.
 *
 * These endpoints are unauthenticated in the user sense but must not be
 * publicly callable — /cron/poll-video-status hits the paid vendor API on every
 * request, so an open endpoint is a way to burn someone else's quota, and later
 * cron jobs issue entitlements and expire access.
 */
export function assertCronRequest(headers: Headers): void {
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    // Failing closed: an unset secret must not mean "allow everyone".
    throw new ApiError(503, ERROR_CODES.INTERNAL, 'Cron is not configured.');
  }

  const provided = headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? '';

  // Length-independent compare. Comparing with === leaks the secret's length and
  // prefix through response timing.
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  const ok = a.length === b.length && timingSafeEqual(a, b);

  if (!ok) throw new ApiError(401, ERROR_CODES.UNAUTHENTICATED, 'Invalid cron credentials.');
}
