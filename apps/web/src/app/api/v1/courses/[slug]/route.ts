import { getCatalogCourse } from '@edtech/core';
import { ok, route } from '@/lib/api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/v1/courses/:slug — public course detail.
 *
 * A draft course answers 404, identical to one that does not exist. Any other
 * response lets a stranger confirm a teacher is preparing something.
 */
export const GET = route(
  async (_req: Request, { params }: { params: Promise<{ slug: string }> }) => {
    const { slug } = await params;
    const res = ok(await getCatalogCourse(slug));
    res.headers.set('Cache-Control', 'public, max-age=60, stale-while-revalidate=300');
    return res;
  },
);
