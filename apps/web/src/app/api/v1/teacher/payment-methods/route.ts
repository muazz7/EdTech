import { createPaymentMethod, listMyPaymentMethods } from '@edtech/core';
import { paymentMethodSchema } from '@edtech/shared';
import { ok, parseBody, route } from '@/lib/api';
import { teacherActor } from '@/lib/teacher';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The teacher's own bKash / Nagad / Rocket numbers.
 *
 * Money moves student -> teacher directly and never transits the platform, so
 * these numbers are the entire payment rail. Every change is audited: a
 * silently altered receiving number is the highest-value thing an attacker
 * could touch here.
 */
export const GET = route(async (req: Request) => {
  const actor = await teacherActor(req);
  return ok(await listMyPaymentMethods(actor));
});

export const POST = route(async (req: Request) => {
  const actor = await teacherActor(req);
  const input = await parseBody(req, paymentMethodSchema);
  return ok(await createPaymentMethod(actor, input), undefined, 201);
});
