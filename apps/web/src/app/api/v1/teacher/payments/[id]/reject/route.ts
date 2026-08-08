import { rejectPayment } from '@edtech/core';
import { rejectPaymentSchema, uuidSchema } from '@edtech/shared';
import { clientIp, ok, parseBody, route } from '@/lib/api';
import { teacherActor } from '@/lib/teacher';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/v1/teacher/payments/:id/reject  { reason, note? }
 *
 * A reason is mandatory, and "other" additionally requires a note — a rejection
 * that says only "other" tells the student nothing and guarantees a support
 * message the teacher then has to answer anyway.
 */
export const POST = route(
  async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
    const actor = await teacherActor(req);
    const paymentId = uuidSchema.parse((await params).id);
    const { reason, note } = await parseBody(req, rejectPaymentSchema);
    return ok(await rejectPayment(actor, paymentId, reason, note, clientIp(req)));
  },
);
