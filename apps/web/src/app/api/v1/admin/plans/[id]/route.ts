import { countPlanSubscribers, retirePlan, updatePlan } from '@edtech/core';
import { updatePlanSchema, uuidSchema } from '@edtech/shared';
import { ok, parseBody, route } from '@/lib/api';
import { adminActor } from '@/lib/admin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const PATCH = route(
  async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
    const actor = await adminActor(req);
    const planId = uuidSchema.parse((await params).id);
    const input = await parseBody(req, updatePlanSchema);
    return ok(await updatePlan(actor, planId, input));
  },
);

/**
 * DELETE retires the plan — it deactivates, it does not delete.
 *
 * Entitlements and payments reference the plan, and a student who bought
 * "Monthly All-Access" must still be able to see what they paid for a year
 * later. The response reports how many pending payments were left open, since
 * those students already sent money and still need reviewing.
 */
export const DELETE = route(
  async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
    const actor = await adminActor(req);
    const planId = uuidSchema.parse((await params).id);

    const subscribers = await countPlanSubscribers(planId);
    const result = await retirePlan(actor, planId);

    return ok({ ...result, liveSubscribersKept: subscribers });
  },
);
