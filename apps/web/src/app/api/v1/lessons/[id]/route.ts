import { getLessonForStudent, guardRequest } from '@edtech/core';
import { uuidSchema } from '@edtech/shared';
import { ok, route } from '@/lib/api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/v1/lessons/:id — metadata, 403 if not entitled (Section 18).
 *
 * Carries no media handle. The video id and the R2 key never leave the server;
 * playback and asset URLs come from the separate issuance endpoints, which mint
 * a short-lived grant at the moment of use.
 */
export const GET = route(
  async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
    const guard = await guardRequest(req.headers);
    const lessonId = uuidSchema.parse((await params).id);

    const res = ok(await getLessonForStudent(guard.user.sub, lessonId));
    res.headers.set('Cache-Control', 'private, no-store');
    return res;
  },
);
