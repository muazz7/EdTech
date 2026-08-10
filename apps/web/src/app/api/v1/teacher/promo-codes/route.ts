import { createPromoCode, listPromoCodes } from '@edtech/core';
import { createPromoCodeSchema, uuidSchema } from '@edtech/shared';
import { ok, parseBody, route } from '@/lib/api';
import { teacherActor } from '@/lib/teacher';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET /api/v1/teacher/promo-codes — this teacher's codes, with how many of
 *  each have been used. */
export const GET = route(async (req: Request) => {
  const actor = await teacherActor(req);
  const raw = new URL(req.url).searchParams.get('courseId');
  const courseId = raw ? uuidSchema.parse(raw) : undefined;

  const res = ok(await listPromoCodes(actor, courseId ? { courseId } : {}));
  res.headers.set('Cache-Control', 'private, no-store');
  return res;
});

/**
 * POST — issues a code (ADR 0002).
 *
 * The teacher sets the validity window and the quantity. A code can only ever
 * discount its issuer's own courses; the course scope is checked through the
 * ownership boundary in core.
 */
export const POST = route(async (req: Request) => {
  const actor = await teacherActor(req);
  const input = await parseBody(req, createPromoCodeSchema);
  return ok(await createPromoCode(actor, input), undefined, 201);
});
