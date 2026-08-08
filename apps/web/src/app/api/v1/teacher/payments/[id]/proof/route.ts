import { eq } from 'drizzle-orm';
import { getDb, payments } from '@edtech/db';
import { presignDownload, resolveActor } from '@edtech/core';
import { ApiError, ERROR_CODES, uuidSchema } from '@edtech/shared';
import { guardRequest } from '@edtech/core';
import { ok, route } from '@/lib/api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/v1/teacher/payments/:id/proof — a short-lived URL for the payment
 * screenshot.
 *
 * Issued per view rather than embedded in the queue response: a signed URL that
 * shipped with the list would stay valid for every row the reviewer never
 * opened, and a payment proof carries a student's name, number and bank
 * balance.
 *
 * Scoped to the reviewer who owns the payment. 404 for anyone else, so the
 * payment id space cannot be probed for other teachers' proofs.
 */
export const GET = route(
  async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
    const guard = await guardRequest(req.headers);
    const actor = await resolveActor(guard.user.sub);
    const paymentId = uuidSchema.parse((await params).id);

    const db = getDb();
    const payment = await db.query.payments.findFirst({
      where: eq(payments.id, paymentId),
      columns: { proofR2Key: true, reviewerId: true },
    });

    if (!payment) throw new ApiError(404, ERROR_CODES.NOT_FOUND, 'Payment not found.');
    if (actor.role !== 'admin' && payment.reviewerId !== actor.userId) {
      throw new ApiError(404, ERROR_CODES.NOT_FOUND, 'Payment not found.');
    }
    if (!payment.proofR2Key) {
      throw new ApiError(404, ERROR_CODES.NOT_FOUND, 'No screenshot was attached.');
    }

    const signed = await presignDownload({ key: payment.proofR2Key });

    const res = ok(signed);
    res.headers.set('Cache-Control', 'private, no-store');
    return res;
  },
);
