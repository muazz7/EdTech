import { revokeEntitlement } from '@edtech/core';
import { revokeAccessSchema, uuidSchema } from '@edtech/shared';
import { clientIp, ok, parseBody, route } from '@/lib/api';
import { teacherActor } from '@/lib/teacher';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/v1/teacher/access/:id — revoke an entitlement.
 *
 * A teacher may revoke only single-course access to a course they own; pulling
 * a subscription would cut the student off from every other teacher too, so
 * that is the Owner's action.
 *
 * Revocation bites on the student's next playback request, not at next login —
 * Section 7 caps the entitlement cache at 60 seconds precisely so this is fast.
 */
export const POST = route(
  async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
    const actor = await teacherActor(req);
    const entitlementId = uuidSchema.parse((await params).id);
    const { reason } = await parseBody(req, revokeAccessSchema);
    return ok(await revokeEntitlement(actor, entitlementId, reason, clientIp(req)));
  },
);
