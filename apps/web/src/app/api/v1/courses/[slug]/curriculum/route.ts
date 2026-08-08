import { getCatalogCurriculum, optionalGuard } from '@edtech/core';
import { ok, route } from '@/lib/api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/v1/courses/:slug/curriculum -> modules + lessons, each with
 * { locked } (Section 18).
 *
 * Serves signed-out visitors and students alike, so authentication is optional:
 * a stranger sees every lesson locked, a student sees what they can open.
 *
 * Lesson TITLES are public on purpose — the curriculum is the sales pitch, and
 * a paywall that hides what it is selling does not convert. Durations and every
 * media handle stay hidden until entitled, so a paid course's runtime is not
 * readable for free.
 */
export const GET = route(
  async (req: Request, { params }: { params: Promise<{ slug: string }> }) => {
    const { slug } = await params;
    const guard = await optionalGuard(req.headers);

    const res = ok(await getCatalogCurriculum(slug, guard?.user.sub));
    // Per-user: the lock flags differ between a stranger and an entitled
    // student, so a shared cache would serve one the other's answer.
    res.headers.set('Cache-Control', 'private, no-store');
    return res;
  },
);
