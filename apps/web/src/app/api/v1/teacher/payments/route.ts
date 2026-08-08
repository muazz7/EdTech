import { z } from 'zod';
import { listPaymentQueue } from '@edtech/core';
import { ok, route } from '@/lib/api';
import { teacherActor } from '@/lib/teacher';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const statusSchema = z.enum(['pending', 'verified', 'rejected', 'expired']).default('pending');

/**
 * GET /api/v1/teacher/payments?status=pending — the verification queue.
 *
 * A teacher sees only payments routed to their own courses; an admin sees
 * everything, including plan payments, which carry no reviewer because they
 * span every teacher's catalog.
 *
 * Pending is ordered oldest-first: the student who has waited longest is served
 * first, and the SLA in Section 8.1 is measured from submission.
 */
export const GET = route(async (req: Request) => {
  const actor = await teacherActor(req);
  const status = statusSchema.parse(new URL(req.url).searchParams.get('status') ?? undefined);
  return ok(await listPaymentQueue(actor, status));
});
