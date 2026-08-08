import { guardRequest, issuePlayback } from '@edtech/core';
import { uuidSchema } from '@edtech/shared';
import { ok, route } from '@/lib/api';
import { issueContext } from '@/lib/issue-context';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/v1/lessons/:id/playback  ->  { otp, playbackInfo }
 *
 * Section 4.1 flow A. Returns a single-use, short-lived grant — never the bare
 * video id. Entitlement is checked inside issuePlayback, immediately before the
 * grant is minted, so a subscription that lapsed mid-session fails here rather
 * than at next login.
 */
export const GET = route(
  async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
    const guard = await guardRequest(req.headers);
    const { id } = await params;
    const lessonId = uuidSchema.parse(id);

    const grant = await issuePlayback(issueContext(req, guard), lessonId);

    return ok(
      {
        otp: grant.otp,
        playbackInfo: grant.playbackInfo,
        expiresInSeconds: grant.expiresInSeconds,
      },
      // Useful for the paywall UI and for support ("why can this student watch
      // this?"), and it is not sensitive.
      { via: grant.via },
    );
  },
);
