import { assertCronRequest, expireStalePayments } from '@edtech/core';
import { ok, route } from '@/lib/api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * POST /api/v1/cron/expire-stale-payments — daily (Section 8.1).
 *
 * A pending payment older than 7 days becomes 'expired'. Without this the
 * teacher's queue silently fills with intents from students who changed their
 * mind, and the real submissions get lost among them.
 *
 * Only untouched intents age out; a submitted payment stays pending until a
 * human reviews it, however long that takes.
 */
export const POST = route(async (req: Request) => {
  assertCronRequest(req.headers);
  return ok(await expireStalePayments());
});

export const GET = POST;
