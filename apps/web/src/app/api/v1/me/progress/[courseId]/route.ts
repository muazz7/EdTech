import { getCourseProgress, getNextLesson, guardRequest } from '@edtech/core';
import { uuidSchema } from '@edtech/shared';
import { ok, route } from '@/lib/api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/v1/me/progress/:courseId
 *
 * Carries the resume position and the next unfinished lesson, so
 * "continue where you left off" (Section 2.3) is one request rather than the
 * client working it out from a lesson list.
 */
export const GET = route(
  async (req: Request, { params }: { params: Promise<{ courseId: string }> }) => {
    const guard = await guardRequest(req.headers);
    const courseId = uuidSchema.parse((await params).courseId);

    const [progress, next] = await Promise.all([
      getCourseProgress(guard.user.sub, courseId),
      getNextLesson(guard.user.sub, courseId),
    ]);

    const res = ok({ ...progress, nextLesson: next });
    res.headers.set('Cache-Control', 'private, no-store');
    return res;
  },
);
