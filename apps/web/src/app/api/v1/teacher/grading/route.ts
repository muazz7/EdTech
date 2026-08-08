import { listGradingQueue, listRecentSubmissions } from '@edtech/core';
import { uuidSchema } from '@edtech/shared';
import { ok, route } from '@/lib/api';
import { teacherActor } from '@/lib/teacher';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/v1/teacher/grading
 *
 * Everything waiting on this teacher: quiz attempts with ungraded written
 * answers, and assignment submissions with no mark. One call because they are
 * one queue in the teacher's head.
 */
export const GET = route(async (req: Request) => {
  const actor = await teacherActor(req);
  const url = new URL(req.url);
  const rawCourse = url.searchParams.get('courseId');
  const courseId = rawCourse ? uuidSchema.parse(rawCourse) : undefined;

  const [quizzes, assignments] = await Promise.all([
    listGradingQueue(actor, courseId ? { courseId } : {}),
    listRecentSubmissions(actor),
  ]);

  const res = ok({
    quizAttempts: quizzes,
    assignmentSubmissions: assignments.filter((row) => row.gradedAt === null),
  });
  res.headers.set('Cache-Control', 'private, no-store');
  return res;
});
