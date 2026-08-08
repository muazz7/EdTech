import { z } from 'zod';
import { completeAssetUpload, createAssetUpload } from '@edtech/core';
import { DOCUMENT_MIME_TYPES, assetUploadUrlSchema, uuidSchema } from '@edtech/shared';
import { ok, parseBody, route } from '@/lib/api';
import { teacherActor } from '@/lib/teacher';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

/**
 * POST /api/v1/teacher/lessons/:id/asset-upload-url  { filename, mime, size }
 *
 * Presigned PUT straight to R2. MIME and size are validated server-side and
 * pinned into the signature, so R2 itself rejects a client that declares a 2 MB
 * PDF and sends a 2 GB video (Section 9.2, Section 11).
 */
export const POST = route(async (req: Request, { params }: Ctx) => {
  const actor = await teacherActor(req);
  const lessonId = uuidSchema.parse((await params).id);
  const input = await parseBody(req, assetUploadUrlSchema);
  return ok(await createAssetUpload(actor, lessonId, input));
});

const completeSchema = z.object({
  key: z.string().min(1).max(500),
  mime: z.enum(DOCUMENT_MIME_TYPES),
  size: z.number().int().positive(),
  /** PDF page count, so the viewer can size its canvas before fetching. */
  pageCount: z.number().int().positive().max(2000).optional(),
});

/**
 * PUT — records the completed upload against the lesson.
 *
 * The key is checked against this lesson's own prefix. Without that a teacher
 * could point their lesson at any object in the bucket, including another
 * teacher's material or a student's payment proof screenshot.
 */
export const PUT = route(async (req: Request, { params }: Ctx) => {
  const actor = await teacherActor(req);
  const lessonId = uuidSchema.parse((await params).id);
  const input = await parseBody(req, completeSchema);
  return ok(await completeAssetUpload(actor, lessonId, input));
});
