import { deactivatePromoCode } from '@edtech/core';
import { uuidSchema } from '@edtech/shared';
import { ok, route } from '@/lib/api';
import { teacherActor } from '@/lib/teacher';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * DELETE deactivates the code. It is never removed.
 *
 * Payments reference it, and a student holding a pending payment keeps the
 * price they were quoted even after the teacher stops handing the code out.
 */
export const DELETE = route(
  async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
    const actor = await teacherActor(req);
    const promoCodeId = uuidSchema.parse((await params).id);
    return ok(await deactivatePromoCode(actor, promoCodeId));
  },
);
