import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { eq, sql } from 'drizzle-orm';
import { closeDb, entitlements, getDb, notifications } from '@edtech/db';
import { PAYMENT_GRACE_PERIOD_DAYS } from '@edtech/shared';
import { checkCourseAccess, checkLessonAccess } from './check-lesson-access.js';
import { getExpiryStatus, sweepExpiryReminders } from './expiry.js';
import { cleanup, createCourse, createUser, grantEntitlement } from '../testing/fixtures.js';

/**
 * Grace period and expiry reminders (Section 8.3).
 *
 * The grace period changes the single entitlement gate, so these tests are
 * about the boundary in both directions: inside the window content still opens,
 * outside it does not, and a live entitlement is never mistaken for one in
 * grace.
 */

let course: Awaited<ReturnType<typeof createCourse>>;

/** Moves an entitlement's expiry, in days from now. Negative is the past. */
async function expireIn(entitlementId: string, days: number) {
  await getDb()
    .update(entitlements)
    .set({ expiresAt: sql`now() + (${days} || ' days')::interval` })
    .where(eq(entitlements.id, entitlementId));
}

async function subscriber(days: number) {
  const student = await createUser();
  const id = await grantEntitlement({
    studentId: student.id,
    kind: 'subscription',
    expiresAt: new Date(Date.now() + days * 24 * 60 * 60 * 1000),
  });
  await expireIn(id, days);
  return { student, entitlementId: id };
}

before(async () => {
  const teacher = await createUser('teacher', 'Expiry Teacher');
  course = await createCourse({ teacherId: teacher.id, isInAllAccess: true });
});

after(async () => {
  await cleanup();
  await closeDb();
});

describe('grace period', () => {
  it('keeps content open on the day access lapses', async () => {
    // "I paid and got locked out while you were asleep" is the worst support
    // conversation in the product. Three days of leakage is cheaper.
    const { student } = await subscriber(-0.5);

    const access = await checkLessonAccess(student.id, course.paidLessonId);
    assert.equal(access.allowed, true);
    assert.equal(access.allowed && access.inGrace, true);
    assert.ok(access.allowed && access.graceEndsAt);
  });

  it('still opens on the last day of grace', async () => {
    const { student } = await subscriber(-(PAYMENT_GRACE_PERIOD_DAYS - 0.5));

    const access = await checkLessonAccess(student.id, course.paidLessonId);
    assert.equal(access.allowed, true);
    assert.equal(access.allowed && access.inGrace, true);
  });

  it('locks once the grace period is over', async () => {
    const { student } = await subscriber(-(PAYMENT_GRACE_PERIOD_DAYS + 1));

    const access = await checkLessonAccess(student.id, course.paidLessonId);
    assert.equal(access.allowed, false);
    // Expired, not "never had it": the first offers a Renew button and the
    // second sends a renewing student through the whole purchase flow.
    assert.equal(access.allowed === false && access.reason, 'expired');
  });

  it('does not call a live entitlement a grace period', async () => {
    // A student who renewed early must not be told their access is running out.
    const { student } = await subscriber(10);

    const access = await checkLessonAccess(student.id, course.paidLessonId);
    assert.equal(access.allowed, true);
    assert.equal(access.allowed && access.inGrace, undefined);
  });

  it('prefers a live entitlement over one in grace', async () => {
    const student = await createUser();

    const lapsed = await grantEntitlement({
      studentId: student.id,
      kind: 'subscription',
      expiresAt: new Date(),
    });
    await expireIn(lapsed, -1);

    await grantEntitlement({
      studentId: student.id,
      kind: 'single_course',
      courseId: course.courseId,
    });

    const access = await checkLessonAccess(student.id, course.paidLessonId);
    assert.equal(access.allowed, true);
    assert.equal(access.allowed && access.inGrace, undefined, 'the live purchase wins');
  });

  it('agrees with the course-level gate', async () => {
    // If these disagreed, a course would list as open and every lesson in it
    // would refuse.
    const { student } = await subscriber(-1);

    const lesson = await checkLessonAccess(student.id, course.paidLessonId);
    const courseLevel = await checkCourseAccess(student.id, course.courseId);

    assert.equal(lesson.allowed, courseLevel.allowed);
    assert.equal(lesson.allowed && lesson.inGrace, courseLevel.allowed && courseLevel.inGrace);
  });

  it('gives a revoked entitlement no grace at all', async () => {
    // Grace is for someone who ran out of time, not for someone whose access
    // was taken away.
    const student = await createUser();
    const id = await grantEntitlement({
      studentId: student.id,
      kind: 'subscription',
      expiresAt: new Date(),
      revoked: true,
    });
    await expireIn(id, -1);

    const access = await checkLessonAccess(student.id, course.paidLessonId);
    assert.equal(access.allowed, false);
  });
});

describe('expiry status', () => {
  it('reports the days left before expiry', async () => {
    const { student } = await subscriber(5);

    const status = await getExpiryStatus(student.id);
    assert.ok(status);
    assert.equal(status.expired, false);
    assert.equal(status.stillOpen, true);
    assert.ok(status.daysLeft <= 5 && status.daysLeft >= 4);
    assert.equal(status.graceDaysLeft, null);
  });

  it('reports the grace days once it has lapsed', async () => {
    const { student } = await subscriber(-1);

    const status = await getExpiryStatus(student.id);
    assert.ok(status);
    assert.equal(status.expired, true);
    assert.equal(status.stillOpen, true);
    assert.ok(status.graceDaysLeft !== null && status.graceDaysLeft > 0);
  });

  it('reports nothing for a student with no time-limited access', async () => {
    const student = await createUser();
    await grantEntitlement({ studentId: student.id, kind: 'lifetime_all' });

    assert.equal(await getExpiryStatus(student.id), null);
  });

  it('uses the latest deadline when a student holds two', async () => {
    const student = await createUser();
    const soon = await grantEntitlement({
      studentId: student.id,
      kind: 'subscription',
      expiresAt: new Date(),
    });
    await expireIn(soon, 2);
    const later = await grantEntitlement({
      studentId: student.id,
      kind: 'subscription',
      expiresAt: new Date(),
    });
    await expireIn(later, 20);

    const status = await getExpiryStatus(student.id);
    assert.ok(status && status.daysLeft > 10, 'access lasts until the last one goes');
  });
});

describe('reminder sweep', () => {
  async function remindersFor(studentId: string) {
    return getDb()
      .select({ type: notifications.type, title: notifications.title })
      .from(notifications)
      .where(eq(notifications.userId, studentId));
  }

  it('warns seven days out and does not repeat', async () => {
    const { student, entitlementId } = await subscriber(6);

    await sweepExpiryReminders();
    const first = await remindersFor(student.id);
    assert.equal(first.length, 1);
    assert.equal(first[0]?.type, 'access_expiring');

    // Idempotent: the daily sweep must not send the same message every day.
    await sweepExpiryReminders();
    assert.equal((await remindersFor(student.id)).length, 1);

    const row = await getDb().query.entitlements.findFirst({
      where: eq(entitlements.id, entitlementId),
    });
    assert.equal(row?.reminderStage, 7);
  });

  it('escalates as the date gets closer', async () => {
    const { student, entitlementId } = await subscriber(6);
    await sweepExpiryReminders();

    await expireIn(entitlementId, 2);
    await sweepExpiryReminders();

    const sent = await remindersFor(student.id);
    assert.equal(sent.length, 2, 'a second, more urgent warning');
  });

  it('sends one catch-up message, not a backlog', async () => {
    // A sweep missed for a week must not produce four notifications at once.
    const { student } = await subscriber(-1);

    await sweepExpiryReminders();
    const sent = await remindersFor(student.id);

    assert.equal(sent.length, 1);
    assert.equal(sent[0]?.type, 'access_ended');
  });

  it('mentions the grace period in the lapse notice', async () => {
    const { student } = await subscriber(-1);
    await sweepExpiryReminders();

    const [notice] = await getDb()
      .select({ body: notifications.body })
      .from(notifications)
      .where(eq(notifications.userId, student.id));

    assert.match(notice?.body ?? '', /grace/i);
  });

  it('leaves a lifetime entitlement alone', async () => {
    const student = await createUser();
    await grantEntitlement({ studentId: student.id, kind: 'lifetime_all' });

    await sweepExpiryReminders();
    assert.equal((await remindersFor(student.id)).length, 0);
  });

  it('says nothing about an entitlement long past', async () => {
    // Outside the window there is nothing left to say, and a student who left
    // three months ago does not want a monthly reminder of it.
    const { student } = await subscriber(-60);

    await sweepExpiryReminders();
    assert.equal((await remindersFor(student.id)).length, 0);
  });
});
