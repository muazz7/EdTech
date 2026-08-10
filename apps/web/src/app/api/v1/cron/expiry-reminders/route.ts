import { assertCronRequest, sweepExpiryReminders } from '@edtech/core';
import { ok, route } from '@/lib/api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * POST /api/v1/cron/expiry-reminders — daily (Section 8.3).
 *
 * There is no auto-charge in this model, so every renewal is a fresh manual
 * cycle and the student has to be told in advance. A subscription that lapses
 * silently is a churned student who thinks the product broke.
 *
 * Idempotent: the stage reached is recorded on the entitlement, so running it
 * twice in a day sends nothing twice, and catching up after an outage sends the
 * most urgent message rather than a backlog of four.
 */
export const POST = route(async (req: Request) => {
  assertCronRequest(req.headers);
  return ok(await sweepExpiryReminders());
});

/** Vercel Cron issues GET. Same handler, same secret. */
export const GET = POST;
