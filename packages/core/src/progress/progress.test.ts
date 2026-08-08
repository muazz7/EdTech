import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { and, eq, sql } from 'drizzle-orm';
import { closeDb, getDb, lessonProgress, lessons } from '@edtech/db';
import { ApiError } from '@edtech/shared';
import { getCourseProgress, listMyCourses, recordProgress } from './progress.js';
import { cleanup, createCourse, createUser, grantEntitlement } from '../testing/fixtures.js';

/**
 * Progress tracking (Section 14).
 *
 * The anti-gaming rule is the part worth pressure: without it a student can
 * seek to the end of every lesson and collect a certificate for a course they
 * never watched, and the same behaviour is what a catalog ripper looks like
 * (Section 17.5).
 */

let course: Awaited<ReturnType<typeof createCourse>>;
let teacherId: string;

/** Ages the stored row so the next report measures against a known elapsed
 *  time, without the test sleeping for real. */
async function backdateProgress(studentId: string, lessonId: string, seconds: number) {
  await getDb()
    .update(lessonProgress)
    .set({ updatedAt: sql`now() - interval '${sql.raw(String(seconds))} seconds'` })
    .where(
      and(eq(lessonProgress.studentId, studentId), eq(lessonProgress.lessonId, lessonId)),
    );
}

before(async () => {
  const teacher = await createUser('teacher', 'Progress Teacher');
  teacherId = teacher.id;
  course = await createCourse({ teacherId, isInAllAccess: true });

  // A 600-second video: 90% is 540 seconds of credited watching.
  await getDb()
    .update(lessons)
    .set({ durationSeconds: 600, videoStatus: 'ready' })
    .where(eq(lessons.id, course.paidLessonId));
  await getDb()
    .update(lessons)
    .set({ durationSeconds: 600, videoStatus: 'ready' })
    .where(eq(lessons.id, course.freeLessonId));
});

after(async () => {
  await cleanup();
  await closeDb();
});

describe('access gating', () => {
  it('refuses progress on a lesson the student cannot open', async () => {
    // Either a bug or someone probing lesson ids. Neither should write a row.
    const student = await createUser();
    await assert.rejects(
      () => recordProgress(student.id, course.paidLessonId, { position: 10 }),
      (err: unknown) => {
        assert.ok(err instanceof ApiError);
        assert.equal(err.status, 403);
        return true;
      },
    );

    const db = getDb();
    const rows = await db
      .select({ lessonId: lessonProgress.lessonId })
      .from(lessonProgress)
      .where(eq(lessonProgress.studentId, student.id));
    assert.equal(rows.length, 0);
  });

  it('allows progress on a free lesson without any entitlement', async () => {
    const student = await createUser();
    const result = await recordProgress(student.id, course.freeLessonId, { position: 5 });
    assert.equal(result.lastPosition, 5);
  });
});

describe('anti-gaming', () => {
  it('discards a jump that outruns wall-clock time', async () => {
    const student = await createUser();
    await grantEntitlement({ studentId: student.id, kind: 'lifetime_all' });

    await recordProgress(student.id, course.paidLessonId, { position: 10 });
    // Two seconds of real time, then a claim of having reached 9 minutes.
    await backdateProgress(student.id, course.paidLessonId, 2);

    const jumped = await recordProgress(student.id, course.paidLessonId, { position: 540 });

    assert.equal(jumped.discarded, 1, 'the impossible advance should be rejected');
    assert.equal(
      jumped.isComplete,
      false,
      'seeking to 90% must not complete a lesson that was never watched',
    );
    assert.ok(
      jumped.secondsWatched < 60,
      `expected almost no credit, got ${jumped.secondsWatched}s`,
    );
    // The resume position still moves: seeking forward is legitimate, it just
    // earns no watch credit.
    assert.equal(jumped.lastPosition, 540);
  });

  it('credits a normal heartbeat', async () => {
    const student = await createUser();
    await grantEntitlement({ studentId: student.id, kind: 'lifetime_all' });

    await recordProgress(student.id, course.paidLessonId, { position: 0 });
    await backdateProgress(student.id, course.paidLessonId, 15);

    const beat = await recordProgress(student.id, course.paidLessonId, { position: 15 });
    assert.equal(beat.discarded, 0);
    assert.ok(beat.secondsWatched >= 14, `expected ~15s credited, got ${beat.secondsWatched}`);
  });

  it('refuses to credit a first report that claims the whole video', async () => {
    // The first report has no earlier row to measure against. Crediting it at
    // face value would mean one request completes any lesson: open, seek to
    // 90%, done. It is measured against one flush interval instead.
    const student = await createUser();
    await grantEntitlement({ studentId: student.id, kind: 'lifetime_all' });

    const opening = await recordProgress(student.id, course.paidLessonId, { position: 540 });

    assert.equal(opening.discarded, 1);
    assert.equal(opening.secondsWatched, 0, 'a seek on open earns nothing');
    assert.equal(opening.isComplete, false);
    assert.equal(opening.lastPosition, 540, 'the resume position still moves');
  });

  it('does not let idle time accumulate spendable credit', async () => {
    // The gap between two reports is wall-clock, not watch time. Left
    // unclamped, a lesson opened and abandoned overnight would let a single
    // seek to the end sit inside an allowance of 86400 seconds.
    const student = await createUser();
    await grantEntitlement({ studentId: student.id, kind: 'lifetime_all' });

    await recordProgress(student.id, course.paidLessonId, { position: 0 });
    await backdateProgress(student.id, course.paidLessonId, 6 * 60 * 60);

    const afterIdle = await recordProgress(student.id, course.paidLessonId, { position: 540 });

    assert.equal(afterIdle.discarded, 1, 'six idle hours must not buy nine minutes');
    assert.equal(afterIdle.isComplete, false);
    assert.ok(
      afterIdle.secondsWatched < 60,
      `expected almost no credit, got ${afterIdle.secondsWatched}s`,
    );
  });

  it('still credits a slow but legitimate report', async () => {
    // A backgrounded tab or a stalled connection can delay a flush well past
    // the usual 30 seconds. That is not cheating.
    const student = await createUser();
    await grantEntitlement({ studentId: student.id, kind: 'lifetime_all' });

    await recordProgress(student.id, course.paidLessonId, { position: 0 });
    await backdateProgress(student.id, course.paidLessonId, 90);

    const slow = await recordProgress(student.id, course.paidLessonId, { position: 90 });
    assert.equal(slow.discarded, 0);
    assert.ok(slow.secondsWatched >= 89, `expected ~90s credited, got ${slow.secondsWatched}`);
  });

  it('allows the extra credit that 2x playback earns', async () => {
    // Speed watching is legitimate — the 1.2 factor exists to permit it plus
    // clock jitter, not to punish it.
    const student = await createUser();
    await grantEntitlement({ studentId: student.id, kind: 'lifetime_all' });

    await recordProgress(student.id, course.paidLessonId, { position: 0 });
    await backdateProgress(student.id, course.paidLessonId, 15);

    const fast = await recordProgress(student.id, course.paidLessonId, {
      position: 30,
      events: [{ event: 'heartbeat', position: 30, playbackRate: 2 }],
    });
    assert.equal(fast.discarded, 0, '2x playback is not cheating');
  });
});

describe('completion', () => {
  it('completes a video at 90% watched, not 100%', async () => {
    // Students skip outros. Requiring 100% strands them one lesson short of a
    // certificate (Section 14).
    const student = await createUser();
    await grantEntitlement({ studentId: student.id, kind: 'lifetime_all' });

    let last = 0;
    // Walk the lesson in realistic 60-second steps.
    for (let step = 0; step < 9; step++) {
      await recordProgress(student.id, course.paidLessonId, { position: last });
      await backdateProgress(student.id, course.paidLessonId, 60);
      last += 60;
    }
    const result = await recordProgress(student.id, course.paidLessonId, { position: last });

    assert.ok(
      result.secondsWatched >= 540,
      `expected >=540s credited, got ${result.secondsWatched}`,
    );
    assert.equal(result.isComplete, true);
    assert.ok(last < 600, 'completed before reaching the very end');
  });

  it('stays complete once complete', async () => {
    const student = await createUser();
    await grantEntitlement({ studentId: student.id, kind: 'lifetime_all' });

    const db = getDb();
    await db.insert(lessonProgress).values({
      studentId: student.id,
      lessonId: course.paidLessonId,
      courseId: course.courseId,
      secondsWatched: 600,
      lastPosition: 600,
      isComplete: true,
      completedAt: new Date(),
    });

    // Re-watching from the start must not un-complete it.
    const result = await recordProgress(student.id, course.paidLessonId, { position: 5 });
    assert.equal(result.isComplete, true);
  });
});

describe('course progress and resume', () => {
  it('reports percentage and a resume point', async () => {
    const student = await createUser();
    await grantEntitlement({ studentId: student.id, kind: 'lifetime_all' });

    await recordProgress(student.id, course.freeLessonId, { position: 42 });

    const progress = await getCourseProgress(student.id, course.courseId);
    assert.equal(progress.totalLessons, 2);
    assert.equal(progress.resume?.lessonId, course.freeLessonId);
    assert.equal(progress.resume?.position, 42);
  });
});

describe('my courses', () => {
  it('lists a course unlocked by a single purchase', async () => {
    const student = await createUser();
    await grantEntitlement({
      studentId: student.id,
      kind: 'single_course',
      courseId: course.courseId,
    });

    const mine = await listMyCourses(student.id);
    assert.equal(mine.hasAllAccess, false);
    assert.ok(mine.courses.some((c) => c.id === course.courseId));
  });

  it('drops a course when the entitlement is revoked', async () => {
    // Built from live entitlements, so a revoked grant disappears rather than
    // showing a course the student can no longer open.
    const student = await createUser();
    await grantEntitlement({
      studentId: student.id,
      kind: 'single_course',
      courseId: course.courseId,
      revoked: true,
    });

    const mine = await listMyCourses(student.id);
    assert.equal(mine.courses.some((c) => c.id === course.courseId), false);
  });

  it('returns nothing for a student with no entitlements', async () => {
    const student = await createUser();
    const mine = await listMyCourses(student.id);
    assert.deepEqual(mine.courses, []);
  });
});
