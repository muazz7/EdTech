import { guardRequest, listMyAttempts, startAttempt } from '@edtech/core';
import { uuidSchema } from '@edtech/shared';
import { ok, route } from '@/lib/api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET /api/v1/quizzes/:id/attempts — this student's own attempts. */
export const GET = route(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const guard = await guardRequest(req.headers);
  const quizId = uuidSchema.parse((await params).id);
  const res = ok(await listMyAttempts(guard.user.sub, quizId));
  res.headers.set('Cache-Control', 'private, no-store');
  return res;
});

/**
 * POST /api/v1/quizzes/:id/attempts — start or resume.
 *
 * Resuming rather than always creating is what makes a dropped connection
 * survivable: the same attempt, the same question order, the same clock. The
 * response carries no `is_correct` and no explanations.
 */
export const POST = route(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const guard = await guardRequest(req.headers);
  const quizId = uuidSchema.parse((await params).id);
  const res = ok(await startAttempt(guard.user.sub, quizId));
  res.headers.set('Cache-Control', 'private, no-store');
  return res;
});
