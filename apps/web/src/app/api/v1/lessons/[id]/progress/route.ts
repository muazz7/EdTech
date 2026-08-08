import { z } from 'zod';
import { guardRequest, recordProgress } from '@edtech/core';
import { uuidSchema } from '@edtech/shared';
import { clientIp, ok, parseBody, route } from '@/lib/api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  position: z.number().int().min(0).max(24 * 60 * 60),
  events: z
    .array(
      z.object({
        event: z.enum(['play', 'pause', 'seek', 'heartbeat', 'ended']),
        position: z.number().int().min(0).max(24 * 60 * 60),
        playbackRate: z.number().min(0.25).max(4).optional(),
        at: z.number().int().optional(),
      }),
    )
    // Batched: a heartbeat every 15 seconds would otherwise be a request every
    // 15 seconds per watching student (Section 18 calls these batched).
    .max(50)
    .optional(),
});

/**
 * POST /api/v1/lessons/:id/progress
 *
 * Records the resume position and watch credit. Progress on a lesson the
 * student cannot open is refused — it is either a bug or someone probing lesson
 * ids, and neither should write a row.
 *
 * Watch credit is checked against the SERVER's elapsed time, so a client cannot
 * claim to have watched an hour in a second (Section 14 anti-gaming).
 */
export const POST = route(
  async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
    const guard = await guardRequest(req.headers);
    const lessonId = uuidSchema.parse((await params).id);
    const body = await parseBody(req, bodySchema);

    const result = await recordProgress(guard.user.sub, lessonId, {
      position: body.position,
      ...(body.events ? { events: body.events } : {}),
      sessionId: guard.session.id,
      ip: clientIp(req),
    });

    const res = ok(result);
    res.headers.set('Cache-Control', 'private, no-store');
    return res;
  },
);
