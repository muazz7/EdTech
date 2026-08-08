import { createVideoUpload } from '@edtech/core';
import { uuidSchema } from '@edtech/shared';
import { ok, route } from '@/lib/api';
import { teacherActor } from '@/lib/teacher';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/v1/teacher/lessons/:id/video-credentials
 *
 * Section 4.1 flow C. Returns short-lived vendor credentials; the client
 * uploads straight to the vendor with a resumable multipart PUT. The file never
 * touches this server — that is what keeps the backend cheap enough to serve
 * 500 students (Section 4).
 *
 * The returned clientPayload is vendor-shaped and passed through untouched.
 */
export const POST = route(
  async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
    const actor = await teacherActor(req);
    const lessonId = uuidSchema.parse((await params).id);
    return ok(await createVideoUpload(actor, lessonId));
  },
);
