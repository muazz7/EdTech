import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { courses, getDb, lessons, notifications } from '@edtech/db';
import { videoProvider } from '../media/vdocipher.js';

/**
 * Section 9.1: cron polls the vendor every 5 minutes and flips lessons to
 * 'ready' (storing duration) or 'failed' (with the vendor's error), notifying
 * the teacher either way.
 *
 * Polling rather than webhooks is deliberate for a solo developer: there is no
 * endpoint to secure, no signature scheme to get wrong, and no retry semantics
 * to reason about. A five-minute delay on "your upload finished" is invisible.
 */

export type PollResult = {
  checked: number;
  ready: number;
  failed: number;
  errors: number;
};

/** Bounded so one run cannot exceed the Vercel function ceiling. Anything left
 *  over is picked up five minutes later. */
const BATCH_SIZE = 25;

export async function pollVideoStatus(): Promise<PollResult> {
  const db = getDb();
  const result: PollResult = { checked: 0, ready: 0, failed: 0, errors: 0 };

  const pending = await db
    .select({
      id: lessons.id,
      videoId: lessons.vdocipherVideoId,
      courseId: lessons.courseId,
      title: lessons.title,
    })
    .from(lessons)
    .where(
      and(
        isNotNull(lessons.vdocipherVideoId),
        inArray(lessons.videoStatus, ['uploading', 'transcoding']),
      ),
    )
    .limit(BATCH_SIZE);

  for (const lesson of pending) {
    if (!lesson.videoId) continue;
    result.checked++;

    let details;
    try {
      details = await videoProvider().getVideo(lesson.videoId);
    } catch (err) {
      // A vendor blip must not mark a good upload failed — leave the row alone
      // and retry on the next run.
      result.errors++;
      console.error(`[poll-video] ${lesson.videoId}:`, err);
      continue;
    }

    if (details.status === 'ready') {
      await db
        .update(lessons)
        .set({
          videoStatus: 'ready',
          durationSeconds: details.durationSeconds,
          updatedAt: sql`now()`,
        })
        .where(eq(lessons.id, lesson.id));

      await notifyTeacher(lesson.courseId, {
        type: 'video.ready',
        title: 'Video ready',
        body: `"${lesson.title}" has finished processing and can be published.`,
        link: `/teacher/courses/${lesson.courseId}`,
      });
      result.ready++;
      continue;
    }

    if (details.status === 'failed') {
      await db
        .update(lessons)
        .set({ videoStatus: 'failed', updatedAt: sql`now()` })
        .where(eq(lessons.id, lesson.id));

      await notifyTeacher(lesson.courseId, {
        type: 'video.failed',
        title: 'Video processing failed',
        // The vendor's own message: the teacher needs to know whether to
        // re-upload or change the file.
        body: `"${lesson.title}" could not be processed. ${details.errorMessage ?? 'Try uploading again.'}`,
        link: `/teacher/courses/${lesson.courseId}`,
      });
      result.failed++;
      continue;
    }

    // Still uploading or transcoding: nothing to write.
  }

  return result;
}

/** Notifies the course's owning teacher. In-app only — Section 15 reserves SMS
 *  for OTP, payment outcomes and expiry warnings, because SMS costs real money
 *  per message in BD. */
async function notifyTeacher(
  courseId: string,
  message: { type: string; title: string; body: string; link: string },
): Promise<void> {
  const db = getDb();
  const course = await db.query.courses.findFirst({
    where: eq(courses.id, courseId),
    columns: { teacherId: true },
  });

  const teacherId = course?.teacherId;
  if (!teacherId) return;

  await db.insert(notifications).values({
    id: uuidv7(),
    userId: teacherId,
    type: message.type,
    title: message.title,
    body: message.body,
    link: message.link,
  });
}
