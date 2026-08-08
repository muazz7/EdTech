import { approvePayment } from '@edtech/core';
import { uuidSchema } from '@edtech/shared';
import { clientIp, ok, route } from '@/lib/api';
import { teacherActor } from '@/lib/teacher';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/v1/teacher/payments/:id/approve
 *
 * Section 8.2. Marks the payment verified and issues the entitlement in ONE
 * transaction — a payment recorded as verified without its entitlement means a
 * student who paid and cannot watch, which is the worst outcome this product
 * has.
 *
 * The status is re-checked inside the transaction, so two reviewers hitting
 * approve at the same moment cannot issue two entitlements for one payment.
 */
export const POST = route(
  async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
    const actor = await teacherActor(req);
    const paymentId = uuidSchema.parse((await params).id);
    return ok(await approvePayment(actor, paymentId, clientIp(req)));
  },
);
