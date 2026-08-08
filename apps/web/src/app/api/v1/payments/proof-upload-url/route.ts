import { uuidv7 } from 'uuidv7';
import { guardRequest, presignUpload, r2Keys } from '@edtech/core';
import { proofUploadUrlSchema } from '@edtech/shared';
import { ok, parseBody, route } from '@/lib/api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/v1/payments/proof-upload-url
 *
 * Presigned PUT for the payment screenshot. Straight to R2 like every other
 * upload — the image never passes through this server.
 *
 * The key is minted server-side from a fresh uuid rather than accepting a
 * client-supplied path, so one student cannot aim their upload at another
 * student's proof and overwrite the evidence in a dispute.
 */
export const POST = route(async (req: Request) => {
  await guardRequest(req.headers);
  const { mime, size } = await parseBody(req, proofUploadUrlSchema);

  const extension = mime.split('/')[1] ?? 'jpg';
  const signed = await presignUpload({
    key: r2Keys.paymentProof(uuidv7(), extension),
    contentType: mime,
    contentLength: size,
  });

  return ok(signed);
});
