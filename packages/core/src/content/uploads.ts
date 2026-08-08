import { eq, inArray, sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { getDb, lessons, notePages } from '@edtech/db';
import {
  ApiError,
  ERROR_CODES,
  type AssetUploadUrlInput,
  type NotePageCommitInput,
} from '@edtech/shared';
import { deleteObject, presignUpload, r2Keys } from '../media/r2.js';
import { videoProvider } from '../media/vdocipher.js';
import { requireLesson, type Actor } from './ownership.js';

/**
 * Upload flows (Section 9.1, 9.2).
 *
 * The one rule that shapes all of them: no media byte passes through our
 * server. We issue and revoke permission; the client talks to the vendor CDN
 * directly. That is what keeps a $12/month backend able to serve 500 students.
 */

// ── Video ───────────────────────────────────────────────────────────────────

/**
 * Section 4.1 flow C, steps 1-4. Returns vendor upload credentials valid for
 * roughly six hours; the client does a resumable multipart PUT straight to the
 * vendor.
 */
export async function createVideoUpload(actor: Actor, lessonId: string) {
  const owned = await requireLesson(actor, lessonId);

  if (owned.type !== 'video') {
    throw new ApiError(
      422,
      ERROR_CODES.VALIDATION_FAILED,
      'This lesson is not a video lesson.',
    );
  }

  // Replacing an existing video must not silently orphan the old one — vendor
  // storage is billed continuously (Section 20.5).
  if (owned.vdocipherVideoId) {
    throw new ApiError(
      409,
      ERROR_CODES.CONFLICT,
      'This lesson already has a video. Remove it first to upload a replacement.',
    );
  }

  const credentials = await videoProvider().createUpload(
    `${owned.course.courseId}/${lessonId}`,
  );

  const db = getDb();
  await db
    .update(lessons)
    .set({ videoStatus: 'uploading', updatedAt: sql`now()` })
    .where(eq(lessons.id, lessonId));

  // videoId is NOT stored yet. The client confirms via video-complete, so an
  // abandoned upload leaves no row claiming a video that was never finished.
  return credentials;
}

/**
 * Section 4.1 flow C, steps 6-7. The client confirms the upload finished; the
 * cron then polls until the vendor reports 'ready'.
 */
export async function completeVideoUpload(actor: Actor, lessonId: string, videoId: string) {
  const owned = await requireLesson(actor, lessonId);

  if (owned.type !== 'video') {
    throw new ApiError(422, ERROR_CODES.VALIDATION_FAILED, 'This lesson is not a video lesson.');
  }

  // Same video id claimed on two lessons would make one delete break the other.
  const db = getDb();
  const clash = await db.query.lessons.findFirst({
    where: eq(lessons.vdocipherVideoId, videoId),
    columns: { id: true },
  });
  if (clash && clash.id !== lessonId) {
    throw new ApiError(409, ERROR_CODES.CONFLICT, 'That video is already attached to a lesson.');
  }

  const [updated] = await db
    .update(lessons)
    .set({ vdocipherVideoId: videoId, videoStatus: 'transcoding', updatedAt: sql`now()` })
    .where(eq(lessons.id, lessonId))
    .returning({ id: lessons.id, videoStatus: lessons.videoStatus });

  if (!updated) throw new ApiError(500, ERROR_CODES.INTERNAL);
  return updated;
}

/** Detaches and deletes the video so a replacement can be uploaded. */
export async function removeVideo(actor: Actor, lessonId: string) {
  const owned = await requireLesson(actor, lessonId);
  if (!owned.vdocipherVideoId) {
    throw new ApiError(409, ERROR_CODES.CONFLICT, 'This lesson has no video.');
  }

  const db = getDb();
  // Unpublish first: a published lesson pointing at a deleted video would show
  // students a player that cannot start.
  await db
    .update(lessons)
    .set({
      vdocipherVideoId: null,
      videoStatus: 'uploading',
      durationSeconds: null,
      isPublished: false,
      updatedAt: sql`now()`,
    })
    .where(eq(lessons.id, lessonId));

  try {
    await videoProvider().deleteVideo(owned.vdocipherVideoId);
  } catch (err) {
    console.error(`[uploads] orphaned video ${owned.vdocipherVideoId}:`, err);
  }

  return { removed: true };
}

// ── Documents and images ────────────────────────────────────────────────────

/**
 * Presigned PUT for a single-file lesson: a PDF, an image, or a single-page
 * uploaded note (ADR 0001).
 *
 * MIME and size are validated here and pinned into the signature, so the
 * declared type is the type R2 will accept. Section 11 is explicit that this
 * must be server-side, not a file-picker `accept` attribute.
 */
export async function createAssetUpload(
  actor: Actor,
  lessonId: string,
  input: AssetUploadUrlInput,
) {
  const owned = await requireLesson(actor, lessonId);

  if (owned.type === 'video' || owned.type === 'quiz' || owned.type === 'assignment') {
    throw new ApiError(
      422,
      ERROR_CODES.VALIDATION_FAILED,
      `A ${owned.type} lesson does not take a document upload.`,
    );
  }

  const key = r2Keys.lessonDoc(owned.course.courseId, lessonId, input.filename);
  const signed = await presignUpload({
    key,
    contentType: input.mime,
    contentLength: input.size,
  });

  return { ...signed, mime: input.mime, size: input.size };
}

/** Records the upload against the lesson once the client's PUT succeeded. */
export async function completeAssetUpload(
  actor: Actor,
  lessonId: string,
  input: { key: string; mime: string; size: number; pageCount?: number },
) {
  const owned = await requireLesson(actor, lessonId);

  // The key must be the one we issued for THIS lesson. Without this a teacher
  // could point their lesson at any object in the bucket, including another
  // teacher's course material or a student's payment proof screenshot.
  const expectedPrefix = `courses/${owned.course.courseId}/lessons/${lessonId}/`;
  if (!input.key.startsWith(expectedPrefix)) {
    throw new ApiError(422, ERROR_CODES.VALIDATION_FAILED, 'That file does not belong to this lesson.');
  }

  const db = getDb();
  const previousKey = owned.r2ObjectKey;

  const [updated] = await db
    .update(lessons)
    .set({
      r2ObjectKey: input.key,
      mimeType: input.mime,
      fileSizeBytes: input.size,
      pageCount: input.pageCount ?? null,
      updatedAt: sql`now()`,
    })
    .where(eq(lessons.id, lessonId))
    .returning();

  if (!updated) throw new ApiError(500, ERROR_CODES.INTERNAL);

  // Replacing a file orphans the old object otherwise.
  if (previousKey && previousKey !== input.key) {
    try {
      await deleteObject(previousKey);
    } catch (err) {
      console.error(`[uploads] orphaned R2 object ${previousKey}:`, err);
    }
  }

  return updated;
}

// ── Multi-page notes (ADR 0001) ─────────────────────────────────────────────

export async function createNotePageUploads(
  actor: Actor,
  lessonId: string,
  input: { pages: Array<{ pageNumber: number; mime: string; size: number }> },
) {
  const owned = await requireLesson(actor, lessonId);

  if (owned.type !== 'note' && owned.type !== 'image') {
    throw new ApiError(
      422,
      ERROR_CODES.VALIDATION_FAILED,
      'Only note or image lessons take page uploads.',
    );
  }

  const numbers = input.pages.map((p) => p.pageNumber);
  if (new Set(numbers).size !== numbers.length) {
    throw new ApiError(422, ERROR_CODES.VALIDATION_FAILED, 'Duplicate page numbers.');
  }

  return Promise.all(
    input.pages.map(async (page) => {
      const ext = page.mime.split('/')[1] ?? 'jpg';
      const key = r2Keys.notePage(owned.course.courseId, lessonId, page.pageNumber, ext);
      const signed = await presignUpload({
        key,
        contentType: page.mime,
        contentLength: page.size,
      });
      return { pageNumber: page.pageNumber, ...signed };
    }),
  );
}

/**
 * Commits the uploaded pages. Replaces the whole set rather than merging:
 * a teacher reshooting a note re-uploads it, and a partial merge would leave
 * stale pages interleaved with new ones.
 */
export async function commitNotePages(
  actor: Actor,
  lessonId: string,
  input: NotePageCommitInput,
) {
  const owned = await requireLesson(actor, lessonId);
  const db = getDb();

  const expectedPrefix = `courses/${owned.course.courseId}/lessons/${lessonId}/notes/`;
  for (const page of input.pages) {
    if (!page.key.startsWith(expectedPrefix)) {
      throw new ApiError(
        422,
        ERROR_CODES.VALIDATION_FAILED,
        'A page file does not belong to this lesson.',
      );
    }
  }

  const previous = await db
    .select({ key: notePages.r2ObjectKey })
    .from(notePages)
    .where(eq(notePages.lessonId, lessonId));

  const incomingKeys = new Set(input.pages.map((p) => p.key));

  await db.transaction(async (tx) => {
    await tx.delete(notePages).where(eq(notePages.lessonId, lessonId));
    await tx.insert(notePages).values(
      input.pages.map((page) => ({
        id: uuidv7(),
        lessonId,
        pageNumber: page.pageNumber,
        r2ObjectKey: page.key,
        mimeType: page.mime,
        fileSizeBytes: page.size,
        width: page.width ?? null,
        height: page.height ?? null,
      })),
    );
    await tx
      .update(lessons)
      .set({ pageCount: input.pages.length, updatedAt: sql`now()` })
      .where(eq(lessons.id, lessonId));
  });

  // Only objects that are no longer referenced.
  for (const old of previous) {
    if (incomingKeys.has(old.key)) continue;
    try {
      await deleteObject(old.key);
    } catch (err) {
      console.error(`[uploads] orphaned note page ${old.key}:`, err);
    }
  }

  return { pageCount: input.pages.length };
}

/** Used by the orphan sweep and by tests. */
export async function lessonKeys(lessonIds: string[]): Promise<string[]> {
  if (lessonIds.length === 0) return [];
  const db = getDb();
  const rows = await db
    .select({ key: notePages.r2ObjectKey })
    .from(notePages)
    .where(inArray(notePages.lessonId, lessonIds));
  return rows.map((r) => r.key);
}
