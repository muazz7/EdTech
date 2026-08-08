import { commitNotePages, createNotePageUploads } from '@edtech/core';
import { notePageCommitSchema, notePageUploadUrlSchema, uuidSchema } from '@edtech/shared';
import { ok, parseBody, route } from '@/lib/api';
import { teacherActor } from '@/lib/teacher';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

/**
 * POST /api/v1/teacher/lessons/:id/note-pages  { pages: [{ pageNumber, mime, size }] }
 *
 * Presigned PUTs for a multi-page uploaded note — teacher-photographed
 * handwritten pages (ADR 0001). There is no rich-text editor and no render job;
 * the uploaded images are the artifact.
 */
export const POST = route(async (req: Request, { params }: Ctx) => {
  const actor = await teacherActor(req);
  const lessonId = uuidSchema.parse((await params).id);
  const input = await parseBody(req, notePageUploadUrlSchema);
  return ok(await createNotePageUploads(actor, lessonId, input));
});

/**
 * PUT — commits the uploaded pages.
 *
 * Replaces the whole set rather than merging: a teacher reshooting a note
 * re-uploads it, and merging would interleave stale pages with new ones.
 * Objects that are no longer referenced are deleted.
 */
export const PUT = route(async (req: Request, { params }: Ctx) => {
  const actor = await teacherActor(req);
  const lessonId = uuidSchema.parse((await params).id);
  const input = await parseBody(req, notePageCommitSchema);
  return ok(await commitNotePages(actor, lessonId, input));
});
