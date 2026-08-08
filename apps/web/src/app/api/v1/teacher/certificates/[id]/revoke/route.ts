import { z } from 'zod';
import { revokeCertificate } from '@edtech/core';
import { uuidSchema } from '@edtech/shared';
import { ok, parseBody, route } from '@/lib/api';
import { teacherActor } from '@/lib/teacher';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** A reason is required: revocation is permanent, public, and the audit trail
 *  is worthless without one. */
const bodySchema = z.object({ reason: z.string().trim().min(3).max(500) });

/**
 * POST /api/v1/teacher/certificates/:id/revoke
 *
 * The public verification page then reports the certificate as revoked rather
 * than 404ing — an employer checking a revoked certificate must be told it was
 * revoked, not that it never existed.
 */
export const POST = route(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const actor = await teacherActor(req);
  const certificateId = uuidSchema.parse((await params).id);
  const { reason } = await parseBody(req, bodySchema);
  return ok(await revokeCertificate(actor, certificateId, reason));
});
