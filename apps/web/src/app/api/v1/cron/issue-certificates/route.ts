import { assertCronRequest, sweepCertificates } from '@edtech/core';
import { ok, route } from '@/lib/api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * POST /api/v1/cron/issue-certificates — hourly (Section 13).
 *
 * Evaluates only students whose progress moved in the last window, not every
 * enrolment ever. The work then stays proportional to how much studying
 * happened rather than to how many students have signed up.
 */
export const POST = route(async (req: Request) => {
  assertCronRequest(req.headers);
  return ok(await sweepCertificates({ sinceMinutes: 90 }));
});

/** Vercel Cron issues GET. Same handler, same secret. */
export const GET = POST;
