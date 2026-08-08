import { getCompletionRules, requireCourse, setCompletionRules } from '@edtech/core';
import { completionRulesSchema, uuidSchema } from '@edtech/shared';
import { ok, parseBody, route } from '@/lib/api';
import { teacherActor } from '@/lib/teacher';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/v1/teacher/courses/:id/completion-rules
 *
 * getCompletionRules is deliberately unguarded in core — the student-facing
 * progress screen needs it too — so ownership is checked here.
 */
export const GET = route(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const actor = await teacherActor(req);
  const courseId = uuidSchema.parse((await params).id);
  await requireCourse(actor, courseId);
  return ok(await getCompletionRules(courseId));
});

/** PUT — these thresholds decide who gets a certificate, so the change is
 *  audited inside setCompletionRules. */
export const PUT = route(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const actor = await teacherActor(req);
  const courseId = uuidSchema.parse((await params).id);
  const input = await parseBody(req, completionRulesSchema);
  return ok(await setCompletionRules(actor, courseId, input));
});
