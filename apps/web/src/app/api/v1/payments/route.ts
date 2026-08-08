import { guardRequest, listMyPayments, submitPaymentProof } from '@edtech/core';
import { submitProofSchema } from '@edtech/shared';
import { ok, parseBody, route } from '@/lib/api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET /api/v1/payments — the student's own history (Section 18: /me/payments). */
export const GET = route(async (req: Request) => {
  const guard = await guardRequest(req.headers);
  return ok(await listMyPayments(guard.user.sub));
});

/**
 * POST /api/v1/payments — submit transaction details after paying.
 *
 * A duplicate transaction ID is refused by the uniq_channel_txid index and
 * surfaces as DUPLICATE_TRANSACTION_ID, never a 500 (Section 8.1).
 */
export const POST = route(async (req: Request) => {
  const guard = await guardRequest(req.headers);
  const input = await parseBody(req, submitProofSchema);
  return ok(await submitPaymentProof(guard.user.sub, input));
});
