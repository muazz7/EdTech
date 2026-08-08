import { z } from 'zod';
import { enforceRate, listCatalog, listCatalogFacets } from '@edtech/core';
import { RATE_LIMITS } from '@edtech/shared';
import { clientIp, ok, route } from '@/lib/api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const querySchema = z.object({
  level: z.string().trim().max(50).optional(),
  subject: z.string().trim().max(100).optional(),
  teacher: z.string().uuid().optional(),
  q: z.string().trim().max(100).optional(),
  page: z.coerce.number().int().min(1).max(500).default(1),
  perPage: z.coerce.number().int().min(1).max(50).default(20),
});

/**
 * GET /api/v1/courses — the public catalog (Section 18).
 *
 * Unauthenticated. Only published courses are ever returned, and nothing here
 * carries a media handle.
 *
 * Rate limited by IP rather than by user, because there is no user. This is the
 * only kind of limit available on a public endpoint, and Section 6.4 expects
 * Cloudflare rules in front of it for the volumetric case.
 */
export const GET = route(async (req: Request) => {
  const ip = clientIp(req);
  if (ip) await enforceRate('catalog', ip, RATE_LIMITS.defaultPerUser);

  const url = new URL(req.url);
  const filters = querySchema.parse(Object.fromEntries(url.searchParams));

  const [result, facets] = await Promise.all([
    listCatalog({
      ...(filters.level ? { level: filters.level } : {}),
      ...(filters.subject ? { subject: filters.subject } : {}),
      ...(filters.teacher ? { teacherId: filters.teacher } : {}),
      ...(filters.q ? { q: filters.q } : {}),
      page: filters.page,
      perPage: filters.perPage,
    }),
    listCatalogFacets(),
  ]);

  const res = ok({ ...result, facets });
  // Short shared cache: the catalog changes when a teacher publishes, and a
  // minute of staleness is invisible next to the bandwidth it saves on a
  // connection Section 1.4 describes as uneven.
  res.headers.set('Cache-Control', 'public, max-age=60, stale-while-revalidate=300');
  return res;
});
