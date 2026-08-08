import { assertCronRequest, sweepAbandonedAttempts } from '@edtech/core';
import { ok, route } from '@/lib/api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * POST /api/v1/cron/sweep-attempts — hourly.
 *
 * Auto-submits attempts left open past 24 hours. Without this an abandoned
 * attempt holds one of the student's limited tries forever: they close the tab,
 * come back next week, and the quiz reports an attempt in progress they cannot
 * finish because the clock ran out.
 */
export const POST = route(async (req: Request) => {
  assertCronRequest(req.headers);
  return ok(await sweepAbandonedAttempts());
});

/** Vercel Cron issues GET. Same handler, same secret. */
export const GET = POST;
