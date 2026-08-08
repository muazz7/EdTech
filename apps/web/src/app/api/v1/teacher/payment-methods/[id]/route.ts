import { deactivatePaymentMethod, updatePaymentMethod } from '@edtech/core';
import { updatePaymentMethodSchema, uuidSchema } from '@edtech/shared';
import { ok, parseBody, route } from '@/lib/api';
import { teacherActor } from '@/lib/teacher';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

export const PATCH = route(async (req: Request, { params }: Ctx) => {
  const actor = await teacherActor(req);
  const id = uuidSchema.parse((await params).id);
  const input = await parseBody(req, updatePaymentMethodSchema);
  return ok(await updatePaymentMethod(actor, id, input));
});

/**
 * Deactivates rather than deletes. A payment row references the method it was
 * shown against, and a student disputing "you told me to send here" needs that
 * record to still exist.
 */
export const DELETE = route(async (req: Request, { params }: Ctx) => {
  const actor = await teacherActor(req);
  const id = uuidSchema.parse((await params).id);
  return ok(await deactivatePaymentMethod(actor, id));
});
