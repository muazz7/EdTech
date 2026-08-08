import { listCourseCertificates } from '@edtech/core';
import { uuidSchema } from '@edtech/shared';
import { ok, route } from '@/lib/api';
import { teacherActor } from '@/lib/teacher';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET /api/v1/teacher/courses/:id/certificates */
export const GET = route(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const actor = await teacherActor(req);
  const courseId = uuidSchema.parse((await params).id);
  const res = ok(await listCourseCertificates(actor, courseId));
  res.headers.set('Cache-Control', 'private, no-store');
  return res;
});
