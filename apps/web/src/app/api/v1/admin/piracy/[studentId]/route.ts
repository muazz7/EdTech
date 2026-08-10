import { getAccountActivity } from '@edtech/core';
import { uuidSchema } from '@edtech/shared';
import { ok, route } from '@/lib/api';
import { adminActor } from '@/lib/admin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/v1/admin/piracy/:studentId — the evidence behind a flag.
 *
 * IP addresses come back with the last octet masked. The reviewer's question is
 * "how many different networks", not "which house", and without the mask this
 * screen is a standing list of students' home addresses.
 */
export const GET = route(
  async (req: Request, { params }: { params: Promise<{ studentId: string }> }) => {
    const actor = await adminActor(req);
    const studentId = uuidSchema.parse((await params).studentId);
    const res = ok(await getAccountActivity(actor, studentId));
    res.headers.set('Cache-Control', 'private, no-store');
    return res;
  },
);
