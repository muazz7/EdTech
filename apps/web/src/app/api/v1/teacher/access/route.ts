import { grantAccess } from '@edtech/core';
import { grantAccessSchema } from '@edtech/shared';
import { clientIp, ok, parseBody, route } from '@/lib/api';
import { teacherActor } from '@/lib/teacher';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/v1/teacher/access — grant a student access by hand.
 *
 * For the case that actually happens: a student pays in cash at the coaching
 * centre, or the teacher wants to comp someone.
 *
 * A teacher's grant is forced to a single course they own. `lifetime_all` and
 * `subscription` both resolve against `is_in_all_access`, so a teacher able to
 * issue one would be handing out every OTHER teacher's catalog for free. The
 * request is refused rather than silently downgraded, because a teacher who
 * believes they granted all-access has a wrong model of what their students can
 * see.
 */
export const POST = route(async (req: Request) => {
  const actor = await teacherActor(req);
  const input = await parseBody(req, grantAccessSchema);
  return ok(await grantAccess(actor, input, clientIp(req)), undefined, 201);
});
