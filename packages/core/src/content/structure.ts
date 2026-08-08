import { eq, sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { getDb, lessons, modules, notePages } from '@edtech/db';
import { ApiError, ERROR_CODES, type CreateLessonInput, type UpdateLessonInput } from '@edtech/shared';
import { recordAudit } from '../audit/log.js';
import { requireCourse, requireLesson, requireModule, type Actor } from './ownership.js';
import { nextLessonOrder, nextModuleOrder } from './reorder.js';
import { deleteObject } from '../media/r2.js';
import { videoProvider } from '../media/vdocipher.js';

// ── Modules ─────────────────────────────────────────────────────────────────

export async function createModule(
  actor: Actor,
  courseId: string,
  input: { title: string; description?: string },
) {
  await requireCourse(actor, courseId);
  const db = getDb();

  const [created] = await db
    .insert(modules)
    .values({
      id: uuidv7(),
      courseId,
      title: input.title,
      description: input.description ?? null,
      displayOrder: await nextModuleOrder(courseId),
    })
    .returning();

  if (!created) throw new ApiError(500, ERROR_CODES.INTERNAL);
  return created;
}

export async function updateModule(
  actor: Actor,
  moduleId: string,
  input: { title?: string; description?: string },
) {
  await requireModule(actor, moduleId);
  const db = getDb();

  const patch: Record<string, unknown> = {};
  if (input.title !== undefined) patch.title = input.title;
  if (input.description !== undefined) patch.description = input.description;
  if (Object.keys(patch).length === 0) {
    throw new ApiError(422, ERROR_CODES.VALIDATION_FAILED, 'Nothing to update.');
  }

  const [updated] = await db
    .update(modules)
    .set(patch)
    .where(eq(modules.id, moduleId))
    .returning();

  if (!updated) throw new ApiError(500, ERROR_CODES.INTERNAL);
  return updated;
}

/**
 * Deleting a module cascades to its lessons in the database, which would orphan
 * their VdoCipher videos and R2 objects — billed continuously (Section 20.5).
 * So the media is released first, per lesson.
 */
export async function deleteModule(actor: Actor, moduleId: string) {
  const { course } = await requireModule(actor, moduleId);
  const db = getDb();

  const children = await db
    .select({ id: lessons.id })
    .from(lessons)
    .where(eq(lessons.moduleId, moduleId));

  for (const child of children) {
    await releaseLessonMedia(child.id);
  }

  await db.delete(modules).where(eq(modules.id, moduleId));

  await recordAudit({
    actorId: actor.userId,
    action: 'module.delete',
    entityType: 'module',
    entityId: moduleId,
    before: { courseId: course.courseId, lessonCount: children.length },
  });

  return { deleted: true, lessonsRemoved: children.length };
}

// ── Lessons ─────────────────────────────────────────────────────────────────

export async function createLesson(actor: Actor, moduleId: string, input: CreateLessonInput) {
  const { course } = await requireModule(actor, moduleId);
  const db = getDb();

  const [created] = await db
    .insert(lessons)
    .values({
      id: uuidv7(),
      moduleId,
      // Denormalized: every entitlement check reads it, and paying for a join
      // on the hottest path in the product is not worth the normalisation.
      courseId: course.courseId,
      title: input.title,
      description: input.description ?? null,
      type: input.type,
      isFree: input.isFree,
      isShortForm: input.isShortForm,
      isPublished: false,
      displayOrder: await nextLessonOrder(moduleId),
      // A video lesson has no file yet; the client requests upload credentials
      // next and the cron flips this to 'ready'.
      videoStatus: input.type === 'video' ? 'uploading' : null,
    })
    .returning();

  if (!created) throw new ApiError(500, ERROR_CODES.INTERNAL);
  return created;
}

export async function updateLesson(actor: Actor, lessonId: string, input: UpdateLessonInput) {
  const owned = await requireLesson(actor, lessonId);
  const db = getDb();

  const patch: Record<string, unknown> = { updatedAt: sql`now()` };
  for (const key of ['title', 'description', 'isFree', 'isShortForm', 'isPublished'] as const) {
    if (input[key] !== undefined) patch[key] = input[key];
  }

  // The lesson type decides which upload flow and which viewer applies, and
  // changing it after a file is attached leaves a PDF key on a video lesson.
  if (input.type !== undefined && input.type !== owned.type) {
    if (owned.vdocipherVideoId || owned.r2ObjectKey) {
      throw new ApiError(
        409,
        ERROR_CODES.CONFLICT,
        'Remove the uploaded file before changing the lesson type.',
      );
    }
    patch.type = input.type;
    patch.videoStatus = input.type === 'video' ? 'uploading' : null;
  }

  // Publishing a video that is not ready would show students a player that
  // cannot start.
  if (input.isPublished === true && owned.type === 'video') {
    const current = await db.query.lessons.findFirst({
      where: eq(lessons.id, lessonId),
      columns: { videoStatus: true, vdocipherVideoId: true },
    });
    if (!current?.vdocipherVideoId || current.videoStatus !== 'ready') {
      throw new ApiError(
        409,
        ERROR_CODES.CONFLICT,
        'This video is not ready yet. Wait for processing to finish before publishing.',
      );
    }
  }

  const [updated] = await db
    .update(lessons)
    .set(patch)
    .where(eq(lessons.id, lessonId))
    .returning();

  if (!updated) throw new ApiError(500, ERROR_CODES.INTERNAL);

  // is_free changes who can watch without paying, so it is audited.
  if (input.isFree !== undefined || input.isPublished !== undefined) {
    await recordAudit({
      actorId: actor.userId,
      action: 'lesson.visibility_change',
      entityType: 'lesson',
      entityId: lessonId,
      after: { isFree: updated.isFree, isPublished: updated.isPublished },
    });
  }

  return updated;
}

export async function deleteLesson(actor: Actor, lessonId: string) {
  await requireLesson(actor, lessonId);
  const db = getDb();

  await releaseLessonMedia(lessonId);
  await db.delete(lessons).where(eq(lessons.id, lessonId));

  await recordAudit({
    actorId: actor.userId,
    action: 'lesson.delete',
    entityType: 'lesson',
    entityId: lessonId,
  });

  return { deleted: true };
}

/**
 * Releases vendor storage for a lesson before its row disappears.
 *
 * Best-effort by design: a vendor outage must not block the teacher's delete,
 * and a leaked object costs cents while a stuck UI costs support time. Failures
 * are logged loudly so an orphan sweep can pick them up later — Section 20.5
 * lists deleting failed and duplicate uploads as a real cost lever, because
 * every orphan is billed all year.
 */
async function releaseLessonMedia(lessonId: string): Promise<void> {
  const db = getDb();
  const lesson = await db.query.lessons.findFirst({
    where: eq(lessons.id, lessonId),
    columns: { vdocipherVideoId: true, r2ObjectKey: true },
  });
  if (!lesson) return;

  if (lesson.vdocipherVideoId) {
    try {
      await videoProvider().deleteVideo(lesson.vdocipherVideoId);
    } catch (err) {
      console.error(`[content] orphaned video ${lesson.vdocipherVideoId}:`, err);
    }
  }

  if (lesson.r2ObjectKey) {
    try {
      await deleteObject(lesson.r2ObjectKey);
    } catch (err) {
      console.error(`[content] orphaned R2 object ${lesson.r2ObjectKey}:`, err);
    }
  }

  // An uploaded note is N page images (ADR 0001). The note_pages rows cascade
  // with the lesson, but the objects they point at do not.
  const pages = await db
    .select({ key: notePages.r2ObjectKey })
    .from(notePages)
    .where(eq(notePages.lessonId, lessonId));

  for (const page of pages) {
    try {
      await deleteObject(page.key);
    } catch (err) {
      console.error(`[content] orphaned note page ${page.key}:`, err);
    }
  }
}
