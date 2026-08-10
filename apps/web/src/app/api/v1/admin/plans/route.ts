import { createPlan, listPlansForAdmin } from '@edtech/core';
import { createPlanSchema } from '@edtech/shared';
import { ok, parseBody, route } from '@/lib/api';
import { adminActor } from '@/lib/admin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET /api/v1/admin/plans — every plan, active or not, with live subscriber
 *  and pending-payment counts. */
export const GET = route(async (req: Request) => {
  const actor = await adminActor(req);
  const res = ok(await listPlansForAdmin(actor));
  res.headers.set('Cache-Control', 'private, no-store');
  return res;
});

/**
 * POST — creates a plan INACTIVE.
 *
 * A plan appears in front of every student the moment it is active, so it is
 * never created in that state: the Owner sets the price and the length, checks
 * it, then turns it on.
 */
export const POST = route(async (req: Request) => {
  const actor = await adminActor(req);
  const input = await parseBody(req, createPlanSchema);
  return ok(await createPlan(actor, input), undefined, 201);
});
