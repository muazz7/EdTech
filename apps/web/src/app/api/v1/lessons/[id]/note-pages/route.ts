import { guardRequest, issueNotePages } from '@edtech/core';
import { uuidSchema } from '@edtech/shared';
import { ok, route } from '@/lib/api';
import { issueContext } from '@/lib/issue-context';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/v1/lessons/:id/note-pages  ->  [{ url, page, watermark }]
 *
 * A multi-page uploaded note: teacher-photographed handwritten pages or a
 * multi-file upload (ADR 0001). Single-file PDF notes use /asset instead.
 *
 * One rate-limit hit for the whole note, not one per page — a 40-page note
 * would otherwise consume a third of the hourly signed-URL budget on one open.
 */
export const GET = route(
  async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
    const guard = await guardRequest(req.headers);
    const { id } = await params;
    const lessonId = uuidSchema.parse(id);

    const grant = await issueNotePages(issueContext(req, guard), lessonId);

    const res = ok(grant);
    res.headers.set('Cache-Control', 'private, no-store');
    return res;
  },
);
