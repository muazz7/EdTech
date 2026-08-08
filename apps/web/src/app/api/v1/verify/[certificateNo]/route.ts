import { enforceRate, verifyCertificate } from '@edtech/core';
import { ApiError, ERROR_CODES, certificateNoSchema } from '@edtech/shared';
import { clientIp, ok, route } from '@/lib/api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/v1/verify/:certificateNo — PUBLIC and UNAUTHENTICATED.
 *
 * That is the entire point of a certificate: an employer with the number and no
 * account must be able to check it. Which makes this the most exposed endpoint
 * in the product, so:
 *
 *  - The response carries only number, name, course, teacher, issue date and
 *    validity. No student id, no course id, no contact details, no scores.
 *  - Certificate numbers carry 32 random bits, so the number space cannot be
 *    walked. The rate limit below is the second line: it makes brute forcing
 *    slow even if the format ever weakens.
 *  - A revoked certificate reports `revoked`, not 404. "This was revoked" and
 *    "this never existed" are different claims and an employer needs the right
 *    one.
 */
export const GET = route(
  async (req: Request, { params }: { params: Promise<{ certificateNo: string }> }) => {
    // Keyed by IP: there is no session here to key on.
    await enforceRate('certificate-verify', clientIp(req) ?? 'unknown', {
      limit: 30,
      windowSeconds: 60 * 60,
    });

    const parsed = certificateNoSchema.safeParse((await params).certificateNo);
    // A malformed number gets the same answer as a missing one, so the shape of
    // a valid number cannot be probed for.
    if (!parsed.success) {
      throw new ApiError(404, ERROR_CODES.NOT_FOUND, 'No certificate with that number.');
    }

    const certificate = await verifyCertificate(parsed.data);
    if (!certificate) {
      throw new ApiError(404, ERROR_CODES.NOT_FOUND, 'No certificate with that number.');
    }

    const res = ok(certificate);
    // Cacheable at the edge: it is public and changes only on revocation.
    res.headers.set('Cache-Control', 'public, max-age=300');
    return res;
  },
);
