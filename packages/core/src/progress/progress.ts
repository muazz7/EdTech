import { and, asc, desc, eq, gt, inArray, isNull, or, sql } from 'drizzle-orm';
import {
  courses,
  entitlements,
  getDb,
  lessonProgress,
  lessons,
  modules,
  profiles,
  watchEvents,
} from '@edtech/db';
import {
  ApiError,
  DOCUMENT_DWELL_COMPLETE_SECONDS,
  ERROR_CODES,
  MAX_PLAYBACK_ADVANCE_FACTOR,
  MAX_PROGRESS_GAP_SECONDS,
  PROGRESS_FLUSH_INTERVAL_SECONDS,
  VIDEO_COMPLETION_THRESHOLD,
  entitlementError,
} from '@edtech/shared';
import { checkLessonAccess } from '../entitlements/check-lesson-access.js';

/**
 * Progress and resume position (Section 14).
 *
 * A video completes at 90% watched, not 100%. Students skip outros, and
 * requiring 100% strands them one lesson short of a certificate — which turns
 * into a support message rather than a completion.
 */

export type ProgressEvent = {
  event: 'play' | 'pause' | 'seek' | 'heartbeat' | 'ended';
  position: number;
  playbackRate?: number;
  /** Client clock, only used for ordering within a batch. Never trusted for
   *  the anti-gaming check — that uses server time. */
  at?: number;
};

export type ProgressResult = {
  lastPosition: number;
  secondsWatched: number;
  isComplete: boolean;
  /** Heartbeats rejected as impossible. Surfaced so the piracy dashboard in
   *  Section 17.5 has something to aggregate. */
  discarded: number;
};

/**
 * Records watch progress from a batch of heartbeats.
 *
 * ANTI-GAMING (Section 14): a heartbeat whose position advanced faster than
 * wall-clock time x playback rate x 1.2 is discarded. That catches
 * seek-scrubbing to fake completion, and doubles as a piracy signal — an
 * account racing through a catalog looks exactly like this.
 *
 * The comparison uses the SERVER's clock delta between requests, not any
 * timestamp the client sends. A client that could supply its own elapsed time
 * could claim any amount of it. That delta is also clamped to
 * MAX_PROGRESS_GAP_SECONDS, so waiting does not accumulate spendable allowance.
 */
export async function recordProgress(
  userId: string,
  lessonId: string,
  input: { position: number; events?: ProgressEvent[]; sessionId?: string; ip?: string | null },
): Promise<ProgressResult> {
  // Progress on a lesson the student cannot open is either a bug or someone
  // probing lesson ids, and either way must not be written.
  const access = await checkLessonAccess(userId, lessonId);
  if (!access.allowed) throw entitlementError(access.reason);

  const db = getDb();
  const lesson = await db.query.lessons.findFirst({
    where: eq(lessons.id, lessonId),
    columns: { id: true, courseId: true, type: true, durationSeconds: true },
  });
  if (!lesson) throw new ApiError(404, ERROR_CODES.NOT_FOUND);

  const existing = await db.query.lessonProgress.findFirst({
    where: and(eq(lessonProgress.studentId, userId), eq(lessonProgress.lessonId, lessonId)),
  });

  const now = Date.now();
  const previousPosition = existing?.lastPosition ?? 0;
  const previousAt = existing?.updatedAt?.getTime() ?? now;

  // Clamped, and a first report is treated as one flush interval rather than as
  // unlimited. Both matter: an unbounded gap would let idle time buy watch
  // credit, and an unbounded first report would let a single seek to the end
  // complete a lesson nobody watched.
  const elapsedSeconds = existing
    ? Math.min(Math.max(0, (now - previousAt) / 1000), MAX_PROGRESS_GAP_SECONDS)
    : PROGRESS_FLUSH_INTERVAL_SECONDS;

  const position = Math.max(0, Math.round(input.position));
  const advanced = position - previousPosition;

  let discarded = 0;
  let creditedSeconds = 0;

  if (advanced > 0) {
    const rate = input.events?.find((e) => e.playbackRate)?.playbackRate ?? 1;
    const allowance = elapsedSeconds * rate * MAX_PLAYBACK_ADVANCE_FACTOR;

    if (advanced > allowance + 1) {
      // Seeking forward is legitimate — it just does not earn watch credit.
      discarded = 1;
      creditedSeconds = 0;
    } else {
      creditedSeconds = advanced;
    }
  }

  const secondsWatched = (existing?.secondsWatched ?? 0) + creditedSeconds;

  const isComplete = existing?.isComplete
    ? true
    : lesson.type === 'video'
      ? // 90% of duration, not of the furthest position reached: seeking to the
        // end must not complete a lesson that was never watched.
        Boolean(
          lesson.durationSeconds &&
            secondsWatched >= lesson.durationSeconds * VIDEO_COMPLETION_THRESHOLD,
        )
      : // Documents and notes complete on open plus a dwell (Section 14).
        secondsWatched >= DOCUMENT_DWELL_COMPLETE_SECONDS;

  await db
    .insert(lessonProgress)
    .values({
      studentId: userId,
      lessonId,
      courseId: lesson.courseId,
      secondsWatched,
      lastPosition: position,
      isComplete,
      completedAt: isComplete ? new Date() : null,
    })
    .onConflictDoUpdate({
      target: [lessonProgress.studentId, lessonProgress.lessonId],
      set: {
        secondsWatched,
        lastPosition: position,
        isComplete,
        // Only stamped on the transition, so a re-watch does not move the
        // completion date a certificate was issued against.
        ...(isComplete && !existing?.isComplete ? { completedAt: new Date() } : {}),
        updatedAt: sql`now()`,
      },
    });

  // Append-only, feeds analytics and the piracy signals dashboard. Best-effort:
  // losing an event must never fail the student's playback.
  if (input.events?.length) {
    await db
      .insert(watchEvents)
      .values(
        input.events.slice(0, 50).map((event) => ({
          studentId: userId,
          lessonId,
          sessionId: input.sessionId ?? null,
          event: event.event,
          position: Math.round(event.position),
          playbackRate: event.playbackRate ? String(event.playbackRate) : null,
          ipAddress: input.ip ?? null,
        })),
      )
      .catch((err) => {
        console.error('[progress] watch_events insert failed:', err);
      });
  }

  return { lastPosition: position, secondsWatched, isComplete, discarded };
}

/** Resume position and completion for one course. */
export async function getCourseProgress(userId: string, courseId: string) {
  const db = getDb();

  const rows = await db
    .select({
      lessonId: lessonProgress.lessonId,
      lastPosition: lessonProgress.lastPosition,
      secondsWatched: lessonProgress.secondsWatched,
      isComplete: lessonProgress.isComplete,
      updatedAt: lessonProgress.updatedAt,
    })
    .from(lessonProgress)
    .where(and(eq(lessonProgress.studentId, userId), eq(lessonProgress.courseId, courseId)));

  const published = await db
    .select({ id: lessons.id })
    .from(lessons)
    .where(and(eq(lessons.courseId, courseId), eq(lessons.isPublished, true)));

  const completed = rows.filter((r) => r.isComplete).length;
  const mostRecent = [...rows].sort(
    (a, b) => (b.updatedAt?.getTime() ?? 0) - (a.updatedAt?.getTime() ?? 0),
  )[0];

  return {
    lessons: rows,
    totalLessons: published.length,
    completedLessons: completed,
    percent: published.length === 0 ? 0 : Math.round((completed / published.length) * 100),
    // "Continue where you left off" (Section 2.3).
    resume: mostRecent
      ? { lessonId: mostRecent.lessonId, position: mostRecent.lastPosition }
      : null,
  };
}

/**
 * My Courses (Section 2.3): everything this student can currently open, with
 * progress.
 *
 * Built from live entitlements rather than from a purchase history, so a
 * revoked or lapsed entitlement drops the course out immediately.
 */
export async function listMyCourses(userId: string) {
  const db = getDb();
  const now = new Date();

  const held = await db
    .select({
      kind: entitlements.kind,
      courseId: entitlements.courseId,
      source: entitlements.source,
      expiresAt: entitlements.expiresAt,
    })
    .from(entitlements)
    .where(
      and(
        eq(entitlements.studentId, userId),
        isNull(entitlements.revokedAt),
        or(isNull(entitlements.expiresAt), gt(entitlements.expiresAt, now)),
      ),
    );

  const singleCourseIds = held
    .filter((e) => e.kind === 'single_course' && e.courseId)
    .map((e) => e.courseId as string);
  const hasAllAccess = held.some((e) => e.kind === 'lifetime_all' || e.kind === 'subscription');
  const planExpiry = held
    .filter((e) => e.kind === 'subscription')
    .map((e) => e.expiresAt)
    .sort((a, b) => (b?.getTime() ?? 0) - (a?.getTime() ?? 0))[0];

  if (singleCourseIds.length === 0 && !hasAllAccess) {
    return { courses: [], hasAllAccess: false, planExpiresAt: null };
  }

  const rows = await db
    .select({
      id: courses.id,
      slug: courses.slug,
      title: courses.title,
      subtitle: courses.subtitle,
      thumbnailKey: courses.thumbnailKey,
      level: courses.level,
      subject: courses.subject,
      isInAllAccess: courses.isInAllAccess,
      teacherName: profiles.fullName,
      totalLessons: sql<number>`(
        SELECT count(*)::int FROM lessons l
        WHERE l.course_id = ${courses.id} AND l.is_published
      )`,
      completedLessons: sql<number>`(
        SELECT count(*)::int FROM lesson_progress p
        WHERE p.course_id = ${courses.id} AND p.student_id = ${userId} AND p.is_complete
      )`,
      lastActivityAt: sql<Date | null>`(
        SELECT max(p.updated_at) FROM lesson_progress p
        WHERE p.course_id = ${courses.id} AND p.student_id = ${userId}
      )`,
    })
    .from(courses)
    .innerJoin(profiles, eq(profiles.id, courses.teacherId))
    .where(
      and(
        eq(courses.state, 'published'),
        // inArray, not a raw `= ANY(...)`: drizzle binds a JS array as one
        // parameter, which Postgres rejects as a malformed array literal.
        hasAllAccess
          ? // All-access covers every course flagged into it, plus anything
            // bought outright.
            singleCourseIds.length > 0
            ? or(eq(courses.isInAllAccess, true), inArray(courses.id, singleCourseIds))
            : eq(courses.isInAllAccess, true)
          : inArray(courses.id, singleCourseIds),
      ),
    )
    .orderBy(desc(courses.publishedAt));

  return {
    courses: rows.map((row) => ({
      ...row,
      percent:
        row.totalLessons === 0 ? 0 : Math.round((row.completedLessons / row.totalLessons) * 100),
    })),
    hasAllAccess,
    planExpiresAt: planExpiry ?? null,
  };
}

/** Live entitlements for the account screen (Section 2.3). */
export async function listMyEntitlements(userId: string) {
  const db = getDb();

  return db
    .select({
      id: entitlements.id,
      kind: entitlements.kind,
      source: entitlements.source,
      startsAt: entitlements.startsAt,
      expiresAt: entitlements.expiresAt,
      revokedAt: entitlements.revokedAt,
      courseTitle: courses.title,
      courseSlug: courses.slug,
    })
    .from(entitlements)
    .leftJoin(courses, eq(courses.id, entitlements.courseId))
    .where(eq(entitlements.studentId, userId))
    .orderBy(desc(entitlements.startsAt))
    .limit(100);
}

/** Next unfinished lesson in a course, for a "continue" button. */
export async function getNextLesson(userId: string, courseId: string) {
  const db = getDb();

  const rows = await db
    .select({
      id: lessons.id,
      title: lessons.title,
      type: lessons.type,
      moduleOrder: modules.displayOrder,
      lessonOrder: lessons.displayOrder,
      isComplete: lessonProgress.isComplete,
    })
    .from(lessons)
    .innerJoin(modules, eq(modules.id, lessons.moduleId))
    .leftJoin(
      lessonProgress,
      and(
        eq(lessonProgress.lessonId, lessons.id),
        eq(lessonProgress.studentId, userId),
      ),
    )
    .where(and(eq(lessons.courseId, courseId), eq(lessons.isPublished, true)))
    .orderBy(asc(modules.displayOrder), asc(lessons.displayOrder));

  return rows.find((r) => !r.isComplete) ?? null;
}
