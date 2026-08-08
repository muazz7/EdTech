import { createPaymentIntent, guardRequest } from '@edtech/core';
import { paymentIntentSchema } from '@edtech/shared';
import { ok, parseBody, route } from '@/lib/api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/v1/payments/intent -> { referenceCode, amount, instructions }
 *
 * Section 8.1. The reference code is generated BEFORE the student pays and they
 * are told to put it in the wallet's reference field — that is what turns the
 * teacher's reconciliation from guesswork into a lookup.
 *
 * The amount is locked here. Teachers change prices freely (ADR 0002), and a
 * student quoted 500 BDT who transfers 500 BDT must be approved for 500 even if
 * the price moved while they were at the shop.
 */
export const POST = route(async (req: Request) => {
  const guard = await guardRequest(req.headers);
  const input = await parseBody(req, paymentIntentSchema);
  return ok(await createPaymentIntent(guard.user.sub, input));
});
