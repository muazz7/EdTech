import { and, asc, desc, eq, isNull, or, sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import {
  courses,
  doubtReplies,
  doubtReports,
  doubtThreads,
  getDb,
  lessons,
  profiles,
} from '@edtech/db';
import {
  ApiError,
  ERROR_CODES,
  RATE_LIMITS,
  entitlementError,
} from '@edtech/shared';
import { checkLessonAccess } from '../entitlements/check-lesson-access.js';
import { requireCourse, type Actor } from '../content/ownership.js';
import { notify } from '../notifications/notify.js';
import { enforceRate } from '../rate-limit/limiter.js';

/**
 * Doubt threads (Section 12).
 *
 * Public by default, and that is the whole point: the same question gets asked
 * forty times, and one searchable answered thread cuts a teacher's workload far
 * more than forty private replies would. A student can still mark a thread
 * private when the question is embarrassing or personal.
 *
 * No realtime anything. Polling when a thread is opened, plus a push on reply,
 * is entirely sufficient here and saves a whole subsystem.
 */

export type ThreadAuthor = { id: string; name: string; isTeacher: boolean };

/** Everyone entitled to the lesson can read the public threads on it. */
async function requireLessonAccess(userId: string, lessonId: string) {
  const access = await checkLessonAccess(userId, lessonId);
  if (!access.allowed) throw entitlementError(access.reason);

  const db = getDb();
  const lesson = await db.query.lessons.findFirst({
    where: eq(lessons.id, lessonId),
    columns: { id: true, courseId: true },
  });
  if (!lesson) throw new ApiError(404, ERROR_CODES.NOT_FOUND, 'Lesson not found.');

  return { lesson, via: access.via };
}

// ── Reading ─────────────────────────────────────────────────────────────────

/**
 * Threads on a lesson.
 *
 * Pinned first, then unresolved, then newest. A teacher pins the threads worth
 * reading before asking, which is what stops the fortieth duplicate.
 */
export async function listLessonThreads(userId: string, lessonId: string) {
  const { via } = await requireLessonAccess(userId, lessonId);
  const db = getDb();
  const isStaff = via === 'owner';

  return db
    .select({
      id: doubtThreads.id,
      title: doubtThreads.title,
      body: doubtThreads.body,
      isResolved: doubtThreads.isResolved,
      isPinned: doubtThreads.isPinned,
      isPublic: doubtThreads.isPublic,
      replyCount: doubtThreads.replyCount,
      createdAt: doubtThreads.createdAt,
      authorId: profiles.id,
      authorName: profiles.fullName,
      isMine: sql<boolean>`${doubtThreads.studentId} = ${userId}`,
    })
    .from(doubtThreads)
    .innerJoin(profiles, eq(profiles.id, doubtThreads.studentId))
    .where(
      and(
        eq(doubtThreads.lessonId, lessonId),
        // Hidden threads are gone for everyone but the teacher who hid them.
        isStaff ? undefined : isNull(doubtThreads.hiddenAt),
        // A private thread is between its author and the teacher.
        isStaff
          ? undefined
          : or(eq(doubtThreads.isPublic, true), eq(doubtThreads.studentId, userId)),
      ),
    )
    .orderBy(
      desc(doubtThreads.isPinned),
      asc(doubtThreads.isResolved),
      desc(doubtThreads.createdAt),
    )
    .limit(100);
}

/** One thread with its replies. */
export async function getThread(userId: string, threadId: string) {
  const db = getDb();

  const thread = await db.query.doubtThreads.findFirst({
    where: eq(doubtThreads.id, threadId),
  });
  if (!thread) throw new ApiError(404, ERROR_CODES.NOT_FOUND, 'Thread not found.');

  const { via } = await requireLessonAccess(userId, thread.lessonId);
  const isStaff = via === 'owner';
  const isAuthor = thread.studentId === userId;

  // Hidden or private: a 404 rather than a 403, so a link cannot be used to
  // confirm that a thread exists.
  if (!isStaff && (thread.hiddenAt || (!thread.isPublic && !isAuthor))) {
    throw new ApiError(404, ERROR_CODES.NOT_FOUND, 'Thread not found.');
  }

  const author = await db.query.profiles.findFirst({
    where: eq(profiles.id, thread.studentId),
    columns: { id: true, fullName: true },
  });

  const replies = await db
    .select({
      id: doubtReplies.id,
      body: doubtReplies.body,
      isTeacherAnswer: doubtReplies.isTeacherAnswer,
      createdAt: doubtReplies.createdAt,
      hiddenAt: doubtReplies.hiddenAt,
      authorId: profiles.id,
      authorName: profiles.fullName,
      authorRole: profiles.role,
    })
    .from(doubtReplies)
    .innerJoin(profiles, eq(profiles.id, doubtReplies.authorId))
    .where(
      and(
        eq(doubtReplies.threadId, threadId),
        isStaff ? undefined : isNull(doubtReplies.hiddenAt),
      ),
    )
    .orderBy(asc(doubtReplies.createdAt));

  return {
    id: thread.id,
    lessonId: thread.lessonId,
    courseId: thread.courseId,
    title: thread.title,
    body: thread.body,
    isResolved: thread.isResolved,
    isPinned: thread.isPinned,
    isPublic: thread.isPublic,
    hiddenAt: thread.hiddenAt,
    createdAt: thread.createdAt,
    author: { id: author?.id ?? thread.studentId, name: author?.fullName ?? 'Student' },
    isMine: isAuthor,
    canModerate: isStaff,
    replies,
  };
}

// ── Posting ─────────────────────────────────────────────────────────────────

export async function createThread(
  userId: string,
  lessonId: string,
  input: { title: string; body: string; isPublic?: boolean },
) {
  const { lesson } = await requireLessonAccess(userId, lessonId);

  // Section 12: 10 posts per student per day. The limit exists because a
  // flooded thread list is worse than no thread list.
  await enforceRate('doubt-post', userId, RATE_LIMITS.doubtPostPerUser);

  const db = getDb();
  const [created] = await db
    .insert(doubtThreads)
    .values({
      id: uuidv7(),
      lessonId,
      courseId: lesson.courseId,
      studentId: userId,
      title: input.title,
      body: input.body,
      isPublic: input.isPublic ?? true,
    })
    .returning();

  if (!created) throw new ApiError(500, ERROR_CODES.INTERNAL);

  const course = await db.query.courses.findFirst({
    where: eq(courses.id, lesson.courseId),
    columns: { teacherId: true, title: true },
  });

  if (course && course.teacherId !== userId) {
    await notify({
      userId: course.teacherId,
      type: 'doubt_posted',
      title: `New question on ${course.title}`,
      body: input.title,
      link: `/teacher/doubts?thread=${created.id}`,
      // In-app only. A teacher with forty students would otherwise get forty
      // pushes a day, and would turn them off.
      push: false,
    }).catch((err) => console.error('[doubts] notify failed:', err));
  }

  return created;
}

export async function replyToThread(userId: string, threadId: string, input: { body: string }) {
  const db = getDb();

  const thread = await db.query.doubtThreads.findFirst({
    where: eq(doubtThreads.id, threadId),
  });
  if (!thread) throw new ApiError(404, ERROR_CODES.NOT_FOUND, 'Thread not found.');
  if (thread.hiddenAt) {
    throw new ApiError(409, ERROR_CODES.CONFLICT, 'This thread has been closed.');
  }

  const { via } = await requireLessonAccess(userId, thread.lessonId);
  const isTeacherAnswer = via === 'owner';

  // A private thread is between its author and the teacher; nobody else may
  // join it, even holding the id.
  if (!thread.isPublic && !isTeacherAnswer && thread.studentId !== userId) {
    throw new ApiError(404, ERROR_CODES.NOT_FOUND, 'Thread not found.');
  }

  if (!isTeacherAnswer) {
    await enforceRate('doubt-post', userId, RATE_LIMITS.doubtPostPerUser);
  }

  const [reply] = await db.transaction(async (tx) => {
    const inserted = await tx
      .insert(doubtReplies)
      .values({
        id: uuidv7(),
        threadId,
        authorId: userId,
        body: input.body,
        // Set from the LIVE role, not from anything the client sends. This flag
        // is what renders a reply as the authoritative answer.
        isTeacherAnswer,
      })
      .returning();

    // Denormalised count, updated in the same transaction as the insert so the
    // list never shows a number the thread cannot produce.
    await tx
      .update(doubtThreads)
      .set({ replyCount: sql`${doubtThreads.replyCount} + 1`, updatedAt: sql`now()` })
      .where(eq(doubtThreads.id, threadId));

    return inserted;
  });

  if (!reply) throw new ApiError(500, ERROR_CODES.INTERNAL);

  // Section 15: notify on reply. The author, unless they replied themselves.
  if (thread.studentId !== userId) {
    await notify({
      userId: thread.studentId,
      type: isTeacherAnswer ? 'doubt_answered' : 'doubt_reply',
      title: isTeacherAnswer
        ? 'Your teacher answered your question'
        : 'Someone replied to your question',
      body: thread.title,
      link: `/learn/lessons/${thread.lessonId}?thread=${threadId}`,
    }).catch((err) => console.error('[doubts] reply notify failed:', err));
  }

  return reply;
}

// ── Teacher inbox and moderation ────────────────────────────────────────────

/**
 * The teacher's inbox, unanswered first (Section 12).
 *
 * Unanswered first, then oldest: a student who asked three days ago and got
 * nothing is the one to serve next, and any other order buries them.
 */
export async function listTeacherDoubts(actor: Actor, params: { courseId?: string } = {}) {
  if (params.courseId) await requireCourse(actor, params.courseId);
  const db = getDb();

  return db
    .select({
      id: doubtThreads.id,
      title: doubtThreads.title,
      body: doubtThreads.body,
      lessonId: doubtThreads.lessonId,
      lessonTitle: lessons.title,
      courseId: doubtThreads.courseId,
      courseTitle: courses.title,
      studentName: profiles.fullName,
      isResolved: doubtThreads.isResolved,
      isPinned: doubtThreads.isPinned,
      isPublic: doubtThreads.isPublic,
      replyCount: doubtThreads.replyCount,
      hiddenAt: doubtThreads.hiddenAt,
      createdAt: doubtThreads.createdAt,
      reportCount: sql<number>`(
        SELECT count(*)::int FROM doubt_reports r
        WHERE r.thread_id = ${doubtThreads.id} AND r.reviewed_at IS NULL
      )`,
    })
    .from(doubtThreads)
    .innerJoin(courses, eq(courses.id, doubtThreads.courseId))
    .innerJoin(lessons, eq(lessons.id, doubtThreads.lessonId))
    .innerJoin(profiles, eq(profiles.id, doubtThreads.studentId))
    .where(
      and(
        actor.role === 'admin' ? undefined : eq(courses.teacherId, actor.userId),
        params.courseId ? eq(doubtThreads.courseId, params.courseId) : undefined,
      ),
    )
    .orderBy(asc(doubtThreads.isResolved), asc(doubtThreads.createdAt))
    .limit(100);
}

async function requireOwnThread(actor: Actor, threadId: string) {
  const db = getDb();
  const thread = await db.query.doubtThreads.findFirst({
    where: eq(doubtThreads.id, threadId),
  });
  if (!thread) throw new ApiError(404, ERROR_CODES.NOT_FOUND, 'Thread not found.');

  // Ownership runs through the course, so a teacher can only moderate their own.
  await requireCourse(actor, thread.courseId);
  return thread;
}

export async function setThreadResolved(actor: Actor, threadId: string, isResolved: boolean) {
  await requireOwnThread(actor, threadId);
  const db = getDb();

  const [updated] = await db
    .update(doubtThreads)
    .set({ isResolved, updatedAt: sql`now()` })
    .where(eq(doubtThreads.id, threadId))
    .returning();

  return updated;
}

export async function setThreadPinned(actor: Actor, threadId: string, isPinned: boolean) {
  await requireOwnThread(actor, threadId);
  const db = getDb();

  const [updated] = await db
    .update(doubtThreads)
    .set({ isPinned, updatedAt: sql`now()` })
    .where(eq(doubtThreads.id, threadId))
    .returning();

  return updated;
}

/**
 * Hides a thread or a reply. Never deletes.
 *
 * A student whose question was taken down will ask why, and the record has to
 * survive that conversation. Deleting would also take every reply with it,
 * including a teacher's answer other students were relying on.
 */
export async function hidePost(
  actor: Actor,
  target: { threadId?: string; replyId?: string },
  reason: string,
) {
  const db = getDb();

  if (target.threadId) {
    await requireOwnThread(actor, target.threadId);
    const [updated] = await db
      .update(doubtThreads)
      .set({ hiddenAt: sql`now()`, hiddenBy: actor.userId, hiddenReason: reason })
      .where(eq(doubtThreads.id, target.threadId))
      .returning();

    await db
      .update(doubtReports)
      .set({ reviewedAt: sql`now()` })
      .where(eq(doubtReports.threadId, target.threadId));

    return updated;
  }

  if (!target.replyId) {
    throw new ApiError(422, ERROR_CODES.VALIDATION_FAILED, 'Nothing to hide.');
  }

  const reply = await db.query.doubtReplies.findFirst({
    where: eq(doubtReplies.id, target.replyId),
  });
  if (!reply) throw new ApiError(404, ERROR_CODES.NOT_FOUND, 'Reply not found.');
  await requireOwnThread(actor, reply.threadId);

  const [updated] = await db
    .update(doubtReplies)
    .set({ hiddenAt: sql`now()`, hiddenBy: actor.userId, hiddenReason: reason })
    .where(eq(doubtReplies.id, target.replyId))
    .returning();

  await db
    .update(doubtReports)
    .set({ reviewedAt: sql`now()` })
    .where(eq(doubtReports.replyId, target.replyId));

  return updated;
}

// ── Reporting ───────────────────────────────────────────────────────────────

/**
 * A student flags something for the teacher.
 *
 * One report per student per target — the unique index enforces it. A report is
 * a signal, not a vote, and letting one student file fifty makes the count
 * meaningless.
 */
export async function reportPost(
  userId: string,
  target: { threadId?: string; replyId?: string },
  reason: string,
) {
  const db = getDb();

  const threadId =
    target.threadId ??
    (
      await db.query.doubtReplies.findFirst({
        where: eq(doubtReplies.id, target.replyId ?? ''),
        columns: { threadId: true },
      })
    )?.threadId;

  if (!threadId) throw new ApiError(404, ERROR_CODES.NOT_FOUND, 'Nothing to report.');

  const thread = await db.query.doubtThreads.findFirst({
    where: eq(doubtThreads.id, threadId),
    columns: { id: true, lessonId: true },
  });
  if (!thread) throw new ApiError(404, ERROR_CODES.NOT_FOUND, 'Nothing to report.');

  // Only someone who can see it may report it.
  await requireLessonAccess(userId, thread.lessonId);

  try {
    await db.insert(doubtReports).values({
      id: uuidv7(),
      threadId: target.threadId ?? null,
      replyId: target.replyId ?? null,
      reporterId: userId,
      reason,
    });
  } catch (err) {
    // Already reported by this student. Answered as success: telling them it
    // was a duplicate invites a second attempt and changes nothing.
    if (err instanceof Error && err.message.includes('doubt_reports_')) {
      return { reported: true };
    }
    throw err;
  }

  return { reported: true };
}

/** Open reports for the teacher's moderation view. */
export async function listOpenReports(actor: Actor) {
  const db = getDb();

  return db
    .select({
      id: doubtReports.id,
      threadId: doubtReports.threadId,
      replyId: doubtReports.replyId,
      reason: doubtReports.reason,
      createdAt: doubtReports.createdAt,
      reporterName: profiles.fullName,
      threadTitle: doubtThreads.title,
      courseTitle: courses.title,
    })
    .from(doubtReports)
    .innerJoin(profiles, eq(profiles.id, doubtReports.reporterId))
    .leftJoin(doubtThreads, eq(doubtThreads.id, doubtReports.threadId))
    .leftJoin(courses, eq(courses.id, doubtThreads.courseId))
    .where(
      and(
        isNull(doubtReports.reviewedAt),
        actor.role === 'admin' ? undefined : eq(courses.teacherId, actor.userId),
      ),
    )
    .orderBy(asc(doubtReports.createdAt))
    .limit(50);
}
