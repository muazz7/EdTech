import { and, asc, eq } from 'drizzle-orm';
import { assignments, courses, getDb, lessons, modules, quizzes } from '@edtech/db';
import { ApiError, ERROR_CODES, entitlementError } from '@edtech/shared';
import { checkLessonAccess } from '../entitlements/check-lesson-access.js';

/**
 * Student-facing lesson metadata (Section 18: `GET /lessons/:id -> metadata;
 * 403 if not entitled`).
 *
 * Deliberately returns NO media handle: no vdocipher_video_id, no R2 key, no
 * signed URL. Those come from the separate issuance endpoints, which mint a
 * short-lived grant at the moment of playback. A metadata response that carried
 * a video id would hand out a durable identifier for a piece of paid content.
 */
export type StudentLessonView = {
  id: string;
  courseId: string;
  courseTitle: string;
  courseSlug: string;
  moduleTitle: string;
  title: string;
  description: string | null;
  type: string;
  isFree: boolean;
  durationSeconds: number | null;
  pageCount: number | null;
  /** 'ready' | 'transcoding' | ... — lets the player show a real reason rather
   *  than failing when a teacher publishes early. */
  videoStatus: string | null;
  /** How access was granted, for the UI to explain itself. */
  via: string;
  /**
   * The published quiz or assignment on this lesson, if any.
   *
   * An id only — starting an attempt or reading the brief goes through the
   * assessment endpoints, which re-check entitlement and strip the answer key.
   * Null while the teacher is still authoring, so a published lesson pointing
   * at a draft quiz shows the student "not ready yet" rather than an empty
   * player.
   */
  quizId: string | null;
  assignmentId: string | null;
  siblings: Array<{ id: string; title: string; type: string; isFree: boolean }>;
};

export async function getLessonForStudent(
  userId: string,
  lessonId: string,
): Promise<StudentLessonView> {
  // Access first, always, before anything about the lesson is revealed.
  const access = await checkLessonAccess(userId, lessonId);
  if (!access.allowed) {
    const error = entitlementError(access.reason);

    // A paywall has to name what is being sold. Attaching the course and its
    // price to the denial is what lets the lock screen offer a real "buy this"
    // route instead of a dead end.
    //
    // Nothing sensitive: the course is published, its title and price are
    // catalog data, and no lesson content is included. Withheld for
    // 'unpublished' and 'revoked', where there is nothing to sell.
    if (access.reason === 'no_entitlement' || access.reason === 'expired') {
      const paywall = await getPaywallInfo(lessonId);
      if (paywall) {
        return Promise.reject(
          new ApiError(error.status, error.code, error.message, paywall),
        );
      }
    }

    throw error;
  }

  const db = getDb();
  const [row] = await db
    .select({
      id: lessons.id,
      courseId: lessons.courseId,
      moduleId: lessons.moduleId,
      title: lessons.title,
      description: lessons.description,
      type: lessons.type,
      isFree: lessons.isFree,
      durationSeconds: lessons.durationSeconds,
      pageCount: lessons.pageCount,
      videoStatus: lessons.videoStatus,
      courseTitle: courses.title,
      courseSlug: courses.slug,
      moduleTitle: modules.title,
    })
    .from(lessons)
    .innerJoin(courses, eq(courses.id, lessons.courseId))
    .innerJoin(modules, eq(modules.id, lessons.moduleId))
    .where(eq(lessons.id, lessonId))
    .limit(1);

  if (!row) throw new ApiError(404, ERROR_CODES.NOT_FOUND);

  // Siblings for in-module navigation. Only published ones — an unpublished
  // lesson appearing in the list would leak that a teacher is preparing it.
  const siblings = await db
    .select({
      id: lessons.id,
      title: lessons.title,
      type: lessons.type,
      isFree: lessons.isFree,
      isPublished: lessons.isPublished,
    })
    .from(lessons)
    .where(eq(lessons.moduleId, row.moduleId))
    .orderBy(asc(lessons.displayOrder));

  // Only looked up for the lesson types that can carry one, and only when
  // published — a teacher previewing their own draft quiz uses the builder.
  const quiz =
    row.type === 'quiz'
      ? await db.query.quizzes.findFirst({
          where: and(eq(quizzes.lessonId, lessonId), eq(quizzes.isPublished, true)),
          columns: { id: true },
        })
      : null;

  const assignment =
    row.type === 'assignment'
      ? await db.query.assignments.findFirst({
          where: and(eq(assignments.lessonId, lessonId), eq(assignments.isPublished, true)),
          columns: { id: true },
        })
      : null;

  return {
    ...row,
    via: access.via,
    quizId: quiz?.id ?? null,
    assignmentId: assignment?.id ?? null,
    siblings: siblings
      .filter((s) => s.isPublished)
      .map(({ id, title, type, isFree }) => ({ id, title, type, isFree })),
  };
}

export type PaywallInfo = {
  courseId: string;
  courseTitle: string;
  courseSlug: string;
  pricePoisha: number;
  isInAllAccess: boolean;
};

/** Catalog-level facts about the course a locked lesson belongs to. */
async function getPaywallInfo(lessonId: string): Promise<PaywallInfo | null> {
  const db = getDb();
  const [row] = await db
    .select({
      courseId: courses.id,
      courseTitle: courses.title,
      courseSlug: courses.slug,
      pricePoisha: courses.pricePoisha,
      isInAllAccess: courses.isInAllAccess,
      state: courses.state,
    })
    .from(lessons)
    .innerJoin(courses, eq(courses.id, lessons.courseId))
    .where(eq(lessons.id, lessonId))
    .limit(1);

  // An unpublished course is not for sale, so there is nothing to offer.
  if (!row || row.state !== 'published') return null;

  const { state: _state, ...paywall } = row;
  return paywall;
}
