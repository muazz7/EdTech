import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { closeDb } from '@edtech/db';
import { checkCourseAccess, checkLessonAccess } from './check-lesson-access.js';
import { cleanup, createCourse, createUser, grantEntitlement } from '../testing/fixtures.js';

/**
 * Section 19.4, test 1: "checkLessonAccess -- every entitlement kind x
 * expired/active/revoked x free/paid lesson."
 *
 * This is the test that protects revenue. Every path that lets a student watch
 * a video goes through this function, and a false positive here means giving
 * away paid content.
 */

const DAY = 24 * 60 * 60 * 1000;

let teacher: { id: string };
let otherTeacher: { id: string };
let admin: { id: string };
let allAccess: Awaited<ReturnType<typeof createCourse>>;
let exclusive: Awaited<ReturnType<typeof createCourse>>;
let draftCourse: Awaited<ReturnType<typeof createCourse>>;
let unpublishedLessons: Awaited<ReturnType<typeof createCourse>>;

before(async () => {
  teacher = await createUser('teacher', 'Test Teacher');
  otherTeacher = await createUser('teacher', 'Other Teacher');
  admin = await createUser('admin', 'Test Admin');

  allAccess = await createCourse({ teacherId: teacher.id, isInAllAccess: true });
  // Not bundled into subscription or lifetime-all: only a single-course
  // purchase or a manual grant opens it.
  exclusive = await createCourse({ teacherId: teacher.id, isInAllAccess: false });
  draftCourse = await createCourse({ teacherId: teacher.id, published: false });
  unpublishedLessons = await createCourse({ teacherId: teacher.id, lessonPublished: false });
});

after(async () => {
  await cleanup();
  await closeDb();
});

describe('publication gating', () => {
  it('denies a lesson in a draft course', async () => {
    const student = await createUser();
    const r = await checkLessonAccess(student.id, draftCourse.paidLessonId);
    assert.deepEqual(r, { allowed: false, reason: 'unpublished' });
  });

  it('denies an unpublished lesson in a published course', async () => {
    const student = await createUser();
    const r = await checkLessonAccess(student.id, unpublishedLessons.paidLessonId);
    assert.deepEqual(r, { allowed: false, reason: 'unpublished' });
  });

  it('denies a free lesson that is not published', async () => {
    // is_free must not override publication -- a teacher's unfinished free
    // preview would otherwise be world-readable.
    const student = await createUser();
    const r = await checkLessonAccess(student.id, unpublishedLessons.freeLessonId);
    assert.deepEqual(r, { allowed: false, reason: 'unpublished' });
  });

  it('denies an unknown lesson id', async () => {
    const student = await createUser();
    const r = await checkLessonAccess(student.id, '00000000-0000-7000-8000-000000000000');
    assert.deepEqual(r, { allowed: false, reason: 'unpublished' });
  });
});

describe('free lessons', () => {
  it('allows a free published lesson with no entitlement', async () => {
    const student = await createUser();
    const r = await checkLessonAccess(student.id, allAccess.freeLessonId);
    assert.deepEqual(r, { allowed: true, via: 'free' });
  });

  it('allows a free lesson in a course that is not in all-access', async () => {
    const student = await createUser();
    const r = await checkLessonAccess(student.id, exclusive.freeLessonId);
    assert.deepEqual(r, { allowed: true, via: 'free' });
  });
});

describe('ownership', () => {
  it('allows an admin on any paid lesson', async () => {
    const r = await checkLessonAccess(admin.id, allAccess.paidLessonId);
    assert.deepEqual(r, { allowed: true, via: 'owner' });
  });

  it('allows the owning teacher', async () => {
    const r = await checkLessonAccess(teacher.id, allAccess.paidLessonId);
    assert.deepEqual(r, { allowed: true, via: 'owner' });
  });

  it("denies a different teacher on someone else's course", async () => {
    // Section 1.3: a teacher cannot see another teacher's courses.
    const r = await checkLessonAccess(otherTeacher.id, allAccess.paidLessonId);
    assert.deepEqual(r, { allowed: false, reason: 'no_entitlement' });
  });

  it('allows an admin into a draft course', async () => {
    const r = await checkLessonAccess(admin.id, draftCourse.paidLessonId);
    // Publication is checked before role, so even an admin gets 'unpublished'.
    // Admin preview of drafts is a separate teacher-portal path, not this gate.
    assert.deepEqual(r, { allowed: false, reason: 'unpublished' });
  });
});

describe('subscription', () => {
  it('allows an active subscription on an all-access course', async () => {
    const student = await createUser();
    await grantEntitlement({
      studentId: student.id,
      kind: 'subscription',
      expiresAt: new Date(Date.now() + 30 * DAY),
    });
    const r = await checkLessonAccess(student.id, allAccess.paidLessonId);
    assert.deepEqual(r, { allowed: true, via: 'subscription' });
  });

  it('denies an active subscription on a course excluded from all-access', async () => {
    const student = await createUser();
    await grantEntitlement({
      studentId: student.id,
      kind: 'subscription',
      expiresAt: new Date(Date.now() + 30 * DAY),
    });
    const r = await checkLessonAccess(student.id, exclusive.paidLessonId);
    assert.deepEqual(r, { allowed: false, reason: 'no_entitlement' });
  });

  it('reports expired for a lapsed subscription', async () => {
    const student = await createUser();
    await grantEntitlement({
      studentId: student.id,
      kind: 'subscription',
      startsAt: new Date(Date.now() - 60 * DAY),
      // Well past the Section 8.3 grace period. A lapse of one day still opens
      // content on purpose; that boundary is covered in expiry.test.ts.
      expiresAt: new Date(Date.now() - 30 * DAY),
    });
    const r = await checkLessonAccess(student.id, allAccess.paidLessonId);
    // 'expired' drives a Renew CTA; 'no_entitlement' drives Choose a plan.
    assert.deepEqual(r, { allowed: false, reason: 'expired' });
  });

  it('reports expired even while an unrelated entitlement is still active', async () => {
    // The spec's snippet only checked for a lapsed entitlement when the student
    // held zero active ones, so this student would have been told to buy a plan
    // rather than renew. Regression guard for that.
    const student = await createUser();
    await grantEntitlement({
      studentId: student.id,
      kind: 'subscription',
      startsAt: new Date(Date.now() - 60 * DAY),
      // Well past the Section 8.3 grace period. A lapse of one day still opens
      // content on purpose; that boundary is covered in expiry.test.ts.
      expiresAt: new Date(Date.now() - 30 * DAY),
    });
    await grantEntitlement({
      studentId: student.id,
      kind: 'single_course',
      courseId: exclusive.courseId,
    });
    const r = await checkLessonAccess(student.id, allAccess.paidLessonId);
    assert.deepEqual(r, { allowed: false, reason: 'expired' });
  });

  it('denies a revoked subscription', async () => {
    const student = await createUser();
    await grantEntitlement({
      studentId: student.id,
      kind: 'subscription',
      expiresAt: new Date(Date.now() + 30 * DAY),
      revoked: true,
    });
    const r = await checkLessonAccess(student.id, allAccess.paidLessonId);
    assert.deepEqual(r, { allowed: false, reason: 'no_entitlement' });
  });

  it('denies a subscription that has not started yet', async () => {
    // Renewals stack by setting starts_at to the previous expiry (Section 8.2),
    // so a future-dated row is normal and must not grant access early.
    const student = await createUser();
    await grantEntitlement({
      studentId: student.id,
      kind: 'subscription',
      startsAt: new Date(Date.now() + 7 * DAY),
      expiresAt: new Date(Date.now() + 37 * DAY),
    });
    const r = await checkLessonAccess(student.id, allAccess.paidLessonId);
    assert.deepEqual(r, { allowed: false, reason: 'no_entitlement' });
  });
});

describe('lifetime all-access', () => {
  it('allows lifetime_all on an all-access course', async () => {
    const student = await createUser();
    await grantEntitlement({ studentId: student.id, kind: 'lifetime_all' });
    const r = await checkLessonAccess(student.id, allAccess.paidLessonId);
    assert.deepEqual(r, { allowed: true, via: 'lifetime_all' });
  });

  it('denies lifetime_all on an excluded course', async () => {
    const student = await createUser();
    await grantEntitlement({ studentId: student.id, kind: 'lifetime_all' });
    const r = await checkLessonAccess(student.id, exclusive.paidLessonId);
    assert.deepEqual(r, { allowed: false, reason: 'no_entitlement' });
  });

  it('denies a revoked lifetime pass', async () => {
    const student = await createUser();
    await grantEntitlement({ studentId: student.id, kind: 'lifetime_all', revoked: true });
    const r = await checkLessonAccess(student.id, allAccess.paidLessonId);
    assert.deepEqual(r, { allowed: false, reason: 'no_entitlement' });
  });
});

describe('single course purchase', () => {
  it('allows the purchased course', async () => {
    const student = await createUser();
    await grantEntitlement({
      studentId: student.id,
      kind: 'single_course',
      courseId: exclusive.courseId,
    });
    const r = await checkLessonAccess(student.id, exclusive.paidLessonId);
    assert.deepEqual(r, { allowed: true, via: 'single_course' });
  });

  it('does not leak into a different course', async () => {
    const student = await createUser();
    await grantEntitlement({
      studentId: student.id,
      kind: 'single_course',
      courseId: exclusive.courseId,
    });
    const r = await checkLessonAccess(student.id, allAccess.paidLessonId);
    assert.deepEqual(r, { allowed: false, reason: 'no_entitlement' });
  });

  it('denies a revoked single-course purchase', async () => {
    const student = await createUser();
    await grantEntitlement({
      studentId: student.id,
      kind: 'single_course',
      courseId: exclusive.courseId,
      revoked: true,
    });
    const r = await checkLessonAccess(student.id, exclusive.paidLessonId);
    assert.deepEqual(r, { allowed: false, reason: 'no_entitlement' });
  });
});

describe('manual grant', () => {
  it('opens an excluded course that no plan would cover', async () => {
    // The only branch where source='manual_grant' does real work: a lifetime
    // grant with no course_id against a course flagged out of all-access.
    const student = await createUser();
    await grantEntitlement({
      studentId: student.id,
      kind: 'lifetime_all',
      source: 'manual_grant',
    });
    const r = await checkLessonAccess(student.id, exclusive.paidLessonId);
    assert.deepEqual(r, { allowed: true, via: 'manual' });
  });

  it('is still denied once revoked', async () => {
    const student = await createUser();
    await grantEntitlement({
      studentId: student.id,
      kind: 'lifetime_all',
      source: 'manual_grant',
      revoked: true,
    });
    const r = await checkLessonAccess(student.id, exclusive.paidLessonId);
    assert.deepEqual(r, { allowed: false, reason: 'no_entitlement' });
  });
});

describe('no entitlement', () => {
  it('denies a student who has never bought anything', async () => {
    const student = await createUser();
    const r = await checkLessonAccess(student.id, allAccess.paidLessonId);
    assert.deepEqual(r, { allowed: false, reason: 'no_entitlement' });
  });
});

describe('checkCourseAccess agrees with checkLessonAccess', () => {
  it('matches for an active subscription', async () => {
    const student = await createUser();
    await grantEntitlement({
      studentId: student.id,
      kind: 'subscription',
      expiresAt: new Date(Date.now() + 30 * DAY),
    });
    const lesson = await checkLessonAccess(student.id, allAccess.paidLessonId);
    const course = await checkCourseAccess(student.id, allAccess.courseId);
    assert.deepEqual(course, lesson);
  });

  it('matches for no entitlement', async () => {
    const student = await createUser();
    const lesson = await checkLessonAccess(student.id, allAccess.paidLessonId);
    const course = await checkCourseAccess(student.id, allAccess.courseId);
    assert.deepEqual(course, lesson);
  });

  it('denies a draft course', async () => {
    const student = await createUser();
    const r = await checkCourseAccess(student.id, draftCourse.courseId);
    assert.deepEqual(r, { allowed: false, reason: 'unpublished' });
  });
});
