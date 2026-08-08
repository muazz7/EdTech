import { gradeSubmission } from '@edtech/core';
import { gradeSubmissionSchema, uuidSchema } from '@edtech/shared';
import { ok, parseBody, route } from '@/lib/api';
import { teacherActor } from '@/lib/teacher';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/v1/teacher/submissions/:id/grade
 *
 * Awarding a mark also locks the submission (ADR 0004) — the student can no
 * longer replace the work the mark was given for.
 */
export const POST = route(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const actor = await teacherActor(req);
  const submissionId = uuidSchema.parse((await params).id);
  const input = await parseBody(req, gradeSubmissionSchema);
  return ok(await gradeSubmission(actor, submissionId, input));
});
