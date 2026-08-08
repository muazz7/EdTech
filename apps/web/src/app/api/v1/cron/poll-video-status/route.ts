import { assertCronRequest, pollVideoStatus } from '@edtech/core';
import { ok, route } from '@/lib/api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
/** Vercel Hobby caps at 10s, Pro at 60s. The poll is batched to 25 lessons so
 *  it stays well inside either. */
export const maxDuration = 60;

/**
 * POST /api/v1/cron/poll-video-status — every 5 minutes (Section 9.1).
 *
 * Protected by CRON_SECRET, compared in constant time. Not user-authenticated
 * but absolutely not public: every call hits the paid vendor API, so an open
 * endpoint is a way for a stranger to burn your quota.
 */
export const POST = route(async (req: Request) => {
  assertCronRequest(req.headers);
  return ok(await pollVideoStatus());
});

/** Vercel Cron issues GET. Same handler, same secret. */
export const GET = POST;
