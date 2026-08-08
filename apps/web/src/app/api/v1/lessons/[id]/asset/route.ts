import { guardRequest, issueAssetUrl } from '@edtech/core';
import { uuidSchema } from '@edtech/shared';
import { ok, route } from '@/lib/api';
import { issueContext } from '@/lib/issue-context';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/v1/lessons/:id/asset  ->  { url, watermark }
 *
 * Section 4.1 flow B. A fresh 15-minute presigned URL per open — never reused
 * for a session (Section 9.2), because a URL pasted into a group chat is a leak
 * for as long as it lives.
 *
 * The client must render the bytes into a <canvas> with the returned watermark
 * overlaid, not hand the URL to an <a download> or an <iframe>. The watermark
 * text is built server-side so the client cannot choose what it displays.
 */
export const GET = route(
  async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
    const guard = await guardRequest(req.headers);
    const { id } = await params;
    const lessonId = uuidSchema.parse(id);

    const grant = await issueAssetUrl(issueContext(req, guard), lessonId);

    const res = ok(grant);
    // Belt and braces: a signed URL must never land in a shared cache.
    res.headers.set('Cache-Control', 'private, no-store');
    return res;
  },
);
