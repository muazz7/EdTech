import { completeVideoUpload, removeVideo } from '@edtech/core';
import { uuidSchema, videoCompleteSchema } from '@edtech/shared';
import { ok, parseBody, route } from '@/lib/api';
import { teacherActor } from '@/lib/teacher';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

/**
 * POST /api/v1/teacher/lessons/:id/video-complete  { videoId }
 *
 * Stores the vendor video id and sets status to 'transcoding'. The cron
 * (/cron/poll-video-status, every 5 min) flips it to 'ready' or 'failed'.
 *
 * The id is only recorded here, not when credentials are issued, so an
 * abandoned upload leaves no row claiming a video that was never finished.
 */
export const POST = route(async (req: Request, { params }: Ctx) => {
  const actor = await teacherActor(req);
  const lessonId = uuidSchema.parse((await params).id);
  const { videoId } = await parseBody(req, videoCompleteSchema);
  return ok(await completeVideoUpload(actor, lessonId, videoId));
});

/**
 * DELETE — detaches and deletes the video so a replacement can be uploaded.
 * Unpublishes the lesson first: a published lesson pointing at a deleted video
 * shows students a player that cannot start.
 */
export const DELETE = route(async (req: Request, { params }: Ctx) => {
  const actor = await teacherActor(req);
  const lessonId = uuidSchema.parse((await params).id);
  return ok(await removeVideo(actor, lessonId));
});
