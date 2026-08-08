import { z } from 'zod';
import { presignSubmissionDownload } from '@edtech/core';
import { uuidSchema } from '@edtech/shared';
import { ok, parseBody, route } from '@/lib/api';
import { teacherActor } from '@/lib/teacher';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const bodySchema = z.object({ key: z.string().min(1).max(500) });

/**
 * POST /api/v1/teacher/submissions/:id/download
 *
 * POST rather than GET because the key goes in the body: a signed-URL request
 * with the object key in the query string ends up in access logs and browser
 * history.
 *
 * The key must be one this submission actually holds. Signing whatever the
 * caller sends would turn this into a read primitive for the whole bucket.
 */
export const POST = route(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const actor = await teacherActor(req);
  const submissionId = uuidSchema.parse((await params).id);
  const { key } = await parseBody(req, bodySchema);

  const res = ok(await presignSubmissionDownload(actor, submissionId, key));
  res.headers.set('Cache-Control', 'private, no-store');
  return res;
});
