import { listOpenReports, listTeacherDoubts } from '@edtech/core';
import { uuidSchema } from '@edtech/shared';
import { ok, route } from '@/lib/api';
import { teacherActor } from '@/lib/teacher';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/v1/teacher/doubts — the inbox, unanswered first.
 *
 * Open reports come back in the same call: moderation and answering are the
 * same sitting, and a second round trip for a list that is usually empty is
 * wasted on the connections Section 1.4 describes.
 */
export const GET = route(async (req: Request) => {
  const actor = await teacherActor(req);
  const raw = new URL(req.url).searchParams.get('courseId');
  const courseId = raw ? uuidSchema.parse(raw) : undefined;

  const [threads, reports] = await Promise.all([
    listTeacherDoubts(actor, courseId ? { courseId } : {}),
    listOpenReports(actor),
  ]);

  const res = ok({ threads, reports });
  res.headers.set('Cache-Control', 'private, no-store');
  return res;
});
