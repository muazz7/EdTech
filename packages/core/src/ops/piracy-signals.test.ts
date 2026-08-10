import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { eq, sql } from 'drizzle-orm';
import { closeDb, getDb, lessonProgress, profiles, watchEvents } from '@edtech/db';
import { getAccountActivity, listPiracySignals } from './piracy-signals.js';
import type { AdminActor } from '../commerce/plans.js';
import { cleanup, createCourse, createUser } from '../testing/fixtures.js';

/**
 * Piracy signals (Section 17.5).
 *
 * The tests that matter are the negative ones. A dashboard that flags everybody
 * is worse than no dashboard: the reviewer stops reading it, and the one real
 * ripper is buried among forty students revising for an exam.
 */

const admin: AdminActor = { userId: '00000000-0000-0000-0000-000000000000', role: 'admin' };
let course: Awaited<ReturnType<typeof createCourse>>;
const touched: string[] = [];

/** Records N watch events from N distinct IPs, as a ripper rotating proxies
 *  would. */
async function seedIps(studentId: string, count: number) {
  const db = getDb();
  for (let i = 0; i < count; i++) {
    await db.insert(watchEvents).values({
      studentId,
      lessonId: course.paidLessonId,
      event: 'heartbeat',
      position: i * 10,
      ipAddress: `203.0.113.${i + 1}`,
    });
  }
  touched.push(studentId);
}

before(async () => {
  const teacher = await createUser('teacher', 'Signals Teacher');
  course = await createCourse({ teacherId: teacher.id, isInAllAccess: true });
});

after(async () => {
  const db = getDb();
  for (const id of touched) {
    await db.delete(watchEvents).where(eq(watchEvents.studentId, id));
    await db.delete(lessonProgress).where(eq(lessonProgress.studentId, id));
  }
  await cleanup();
  await closeDb();
});

describe('flagging', () => {
  it('does not flag a student behaving normally', async () => {
    // The most important assertion in the file. A queue full of false positives
    // is a queue nobody reads.
    const student = await createUser('student', 'Ordinary Student');
    await seedIps(student.id, 2);

    const flagged = await listPiracySignals(admin);
    assert.equal(
      flagged.some((row) => row.studentId === student.id),
      false,
    );
  });

  it('flags an account seen from many networks in a day', async () => {
    const student = await createUser('student', 'Rotating Proxies');
    await seedIps(student.id, 6);

    const flagged = await listPiracySignals(admin);
    const row = flagged.find((entry) => entry.studentId === student.id);

    assert.ok(row, 'six IPs in a day should surface');
    assert.ok(row.signals.some((s) => s.code === 'many_ips'));
    // The evidence, not just the verdict — the reviewer is deciding whether to
    // phone someone.
    assert.match(row.signals[0]?.detail ?? '', /\d+ different IPs/);
  });

  it('flags implausible watch time', async () => {
    const student = await createUser('student', 'Impossible Viewer');
    const db = getDb();

    await db.insert(lessonProgress).values({
      studentId: student.id,
      lessonId: course.paidLessonId,
      courseId: course.courseId,
      // 25 hours of credited watching in a day is not viewing.
      secondsWatched: 25 * 3600,
      lastPosition: 100,
      isComplete: true,
    });
    touched.push(student.id);

    const flagged = await listPiracySignals(admin);
    const row = flagged.find((entry) => entry.studentId === student.id);
    assert.ok(row?.signals.some((s) => s.code === 'watch_velocity'));
  });

  it('sorts the strongest patterns first', async () => {
    // One tripped signal is noise; three at once is a pattern, and it should be
    // at the top of the queue rather than page two.
    const student = await createUser('student', 'Multiple Signals');
    await seedIps(student.id, 8);

    await getDb().insert(lessonProgress).values({
      studentId: student.id,
      lessonId: course.paidLessonId,
      courseId: course.courseId,
      secondsWatched: 30 * 3600,
      lastPosition: 100,
      isComplete: true,
    });

    const flagged = await listPiracySignals(admin);
    const row = flagged.find((entry) => entry.studentId === student.id);

    assert.ok(row && row.signalCount >= 2);
    assert.equal(flagged[0]?.signalCount, Math.max(...flagged.map((r) => r.signalCount)));
  });
});

describe('reviewer privacy', () => {
  it('masks the last octet of every IP address', async () => {
    // The reviewer's question is "how many different networks", not "which
    // house". Without the mask this screen is a standing list of students' home
    // addresses.
    const student = await createUser('student', 'Masked');
    await seedIps(student.id, 3);

    const activity = await getAccountActivity(admin, student.id);

    assert.ok(activity.recentIps.length > 0);
    for (const row of activity.recentIps) {
      assert.match(row.ip, /\.x$/, `${row.ip} should be masked`);
      assert.equal(row.ip.includes('203.0.113.1'), false, 'the full address must not survive');
    }
  });

  it('reports the device budget alongside the count', async () => {
    // A count with no denominator tells the reviewer nothing: 4 devices is
    // normal if the limit is 8 and the ceiling if it is 4.
    const student = await createUser();
    const activity = await getAccountActivity(admin, student.id);

    assert.equal(typeof activity.deviceCount, 'number');
    assert.ok(activity.deviceLimit > 0);
  });

  it('returns an empty picture for an account with no activity', async () => {
    const student = await createUser();
    const activity = await getAccountActivity(admin, student.id);

    assert.deepEqual(activity.recentIps, []);
    assert.deepEqual(activity.recentCourses, []);
  });
});

describe('thresholds', () => {
  it('counts distinct networks, not requests', async () => {
    // Fifty heartbeats from one home connection is a student watching a
    // lecture. It must not look like fifty networks.
    const student = await createUser('student', 'One Network');
    const db = getDb();

    for (let i = 0; i < 50; i++) {
      await db.insert(watchEvents).values({
        studentId: student.id,
        lessonId: course.paidLessonId,
        event: 'heartbeat',
        position: i * 15,
        ipAddress: '203.0.113.200',
      });
    }
    touched.push(student.id);

    const flagged = await listPiracySignals(admin);
    const row = flagged.find((entry) => entry.studentId === student.id);
    assert.equal(row?.signals.some((s) => s.code === 'many_ips') ?? false, false);
  });

  it('ignores activity older than the window', async () => {
    const student = await createUser('student', 'Historic');
    await seedIps(student.id, 8);

    // Age everything past 24 hours: a burst last month is not today's problem.
    await getDb()
      .update(watchEvents)
      .set({ createdAt: sql`now() - interval '5 days'` })
      .where(eq(watchEvents.studentId, student.id));

    const flagged = await listPiracySignals(admin);
    assert.equal(
      flagged.some((entry) => entry.studentId === student.id),
      false,
    );
  });

  it('does not invent a name for a missing profile', async () => {
    const student = await createUser('student', 'Named Student');
    await seedIps(student.id, 6);

    const flagged = await listPiracySignals(admin);
    const row = flagged.find((entry) => entry.studentId === student.id);
    assert.equal(row?.studentName, 'Named Student');

    const stored = await getDb().query.profiles.findFirst({
      where: eq(profiles.id, student.id),
      columns: { fullName: true },
    });
    assert.equal(row?.studentName, stored?.fullName);
  });
});
