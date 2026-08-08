import { z } from 'zod';
import { gradeAnswer } from '@edtech/core';
import { gradeAnswerSchema, uuidSchema } from '@edtech/shared';
import { ok, parseBody, route } from '@/lib/api';
import { teacherActor } from '@/lib/teacher';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const bodySchema = gradeAnswerSchema.extend({ questionId: uuidSchema });

/**
 * POST /api/v1/teacher/attempts/:id/grade
 *
 * Marks one written answer and re-totals the attempt. Re-totalling per save
 * rather than at the end means a teacher who grades three of five and stops
 * leaves a consistent partial state.
 */
export const POST = route(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const actor = await teacherActor(req);
  const attemptId = uuidSchema.parse((await params).id);
  const { questionId, ...input } = await parseBody(req, bodySchema);
  return ok(await gradeAnswer(actor, attemptId, questionId, input));
});

export type GradeBody = z.infer<typeof bodySchema>;
