import { enforceRate, guardRequest, validatePromoCode } from '@edtech/core';
import { validatePromoCodeSchema } from '@edtech/shared';
import { ok, parseBody, route } from '@/lib/api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/v1/promo/validate — prices a code before the student commits.
 *
 * Rate limited hard, and per user rather than per IP: a promo code is a short
 * bearer secret, and an unlimited endpoint that answers "valid / not valid" is
 * a brute-force oracle. Every refusal returns the same message for the same
 * reason — see validatePromoCode in core.
 *
 * This is a PREVIEW, not a reservation. The slot is only taken when the payment
 * intent is created, under a row lock.
 */
export const POST = route(async (req: Request) => {
  const guard = await guardRequest(req.headers);

  await enforceRate('promo-validate', guard.user.sub, { limit: 20, windowSeconds: 60 * 60 });

  const input = await parseBody(req, validatePromoCodeSchema);
  const res = ok(await validatePromoCode(guard.user.sub, input));
  res.headers.set('Cache-Control', 'private, no-store');
  return res;
});
