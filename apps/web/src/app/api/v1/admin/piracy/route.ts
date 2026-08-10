import { listPiracySignals } from '@edtech/core';
import { ok, route } from '@/lib/api';
import { adminActor } from '@/lib/admin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/v1/admin/piracy — the review queue from Section 17.5.
 *
 * Admin only, not teacher. IP addresses and device counts are exactly the kind
 * of data a teacher has no business reading about another teacher's students,
 * and piracy is a platform-level concern rather than a per-course one.
 *
 * Nothing here bans anybody. The spec is explicit: false positives cost paying
 * students, so this is a queue a human works through.
 */
export const GET = route(async (req: Request) => {
  const actor = await adminActor(req);
  const res = ok(await listPiracySignals(actor));
  res.headers.set('Cache-Control', 'private, no-store');
  return res;
});
