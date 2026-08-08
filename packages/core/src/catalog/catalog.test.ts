import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { eq } from 'drizzle-orm';
import { closeDb, getDb, lessons } from '@edtech/db';
import { ApiError } from '@edtech/shared';
import {
  getCatalogCourse,
  getCatalogCurriculum,
  listCatalog,
  listFreeResources,
} from './catalog.js';
import { grantAccess } from '../payments/grant.js';
import { resolveActor, type Actor } from '../content/ownership.js';
import { cleanup, createCourse, createUser, grantEntitlement } from '../testing/fixtures.js';

/**
 * The catalog is the first surface that serves strangers, so the tests are
 * mostly about what it must NOT return: draft courses, unpublished lessons, and
 * anything about paid content beyond its title.
 */

let teacher: Actor;
let published: Awaited<ReturnType<typeof createCourse>>;
let draft: Awaited<ReturnType<typeof createCourse>>;
let hiddenLessons: Awaited<ReturnType<typeof createCourse>>;

before(async () => {
  const user = await createUser('teacher', 'Catalog Teacher');
  teacher = await resolveActor(user.id);

  published = await createCourse({ teacherId: teacher.userId, isInAllAccess: true });
  draft = await createCourse({ teacherId: teacher.userId, published: false });
  hiddenLessons = await createCourse({ teacherId: teacher.userId, lessonPublished: false });

  // Give the paid lesson a duration, so the "runtime must not leak" assertion
  // has something real to hide.
  await getDb()
    .update(lessons)
    .set({ durationSeconds: 1800 })
    .where(eq(lessons.id, published.paidLessonId));
});

after(async () => {
  await cleanup();
  await closeDb();
});

describe('catalog listing', () => {
  it('includes published courses and excludes drafts', async () => {
    const result = await listCatalog({ page: 1, perPage: 50 });
    const ids = result.courses.map((c) => c.id);

    assert.ok(ids.includes(published.courseId));
    assert.equal(ids.includes(draft.courseId), false, 'a draft course must not be listed');
  });

  it('counts only published lessons', async () => {
    const result = await listCatalog({ page: 1, perPage: 50 });
    const course = result.courses.find((c) => c.id === hiddenLessons.courseId);
    assert.ok(course);
    assert.equal(course.lessonCount, 0, 'unpublished lessons must not be counted');
  });

  it('reports the free lesson count, which is the funnel', async () => {
    const result = await listCatalog({ page: 1, perPage: 50 });
    const course = result.courses.find((c) => c.id === published.courseId);
    assert.equal(course?.freeLessonCount, 1);
  });
});

describe('course detail', () => {
  it('returns a published course', async () => {
    const course = await getCatalogCourse(`test-course-${published.courseId}`);
    assert.equal(course.id, published.courseId);
  });

  it('answers 404 for a draft, exactly as for a missing course', async () => {
    // Any other answer confirms to a stranger that a teacher is preparing
    // something.
    await assert.rejects(
      () => getCatalogCourse(`test-course-${draft.courseId}`),
      (err: unknown) => {
        assert.ok(err instanceof ApiError);
        assert.equal(err.status, 404);
        return true;
      },
    );

    await assert.rejects(
      () => getCatalogCourse('no-such-course-at-all'),
      (err: unknown) => {
        assert.ok(err instanceof ApiError);
        assert.equal(err.status, 404);
        return true;
      },
    );
  });
});

describe('curriculum lock flags', () => {
  const slug = () => `test-course-${published.courseId}`;

  it('locks paid lessons for a signed-out visitor but still shows titles', async () => {
    const curriculum = await getCatalogCurriculum(slug());
    const all = curriculum.modules.flatMap((m) => m.lessons);

    assert.equal(curriculum.entitled, false);

    const paid = all.find((l) => l.id === published.paidLessonId);
    const free = all.find((l) => l.id === published.freeLessonId);

    assert.equal(paid?.locked, true);
    // The curriculum IS the sales pitch — hiding it does not convert.
    assert.equal(typeof paid?.title, 'string');
    assert.ok((paid?.title.length ?? 0) > 0);

    assert.equal(free?.locked, false, 'a free lesson is playable by anyone');
  });

  it('hides the duration of a locked lesson', async () => {
    // Runtime has value on its own: a paid course's total length should not be
    // readable without paying.
    const curriculum = await getCatalogCurriculum(slug());
    const paid = curriculum.modules.flatMap((m) => m.lessons).find((l) => l.id === published.paidLessonId);
    assert.equal(paid?.durationSeconds, null);
  });

  it('unlocks everything for an entitled student and reveals durations', async () => {
    const student = await createUser();
    await grantEntitlement({ studentId: student.id, kind: 'lifetime_all' });

    const curriculum = await getCatalogCurriculum(slug(), student.id);
    assert.equal(curriculum.entitled, true);
    assert.equal(curriculum.via, 'lifetime_all');

    const paid = curriculum.modules.flatMap((m) => m.lessons).find((l) => l.id === published.paidLessonId);
    assert.equal(paid?.locked, false);
    assert.equal(paid?.durationSeconds, 1800);
  });

  it('leaves it locked for a signed-in student with no entitlement', async () => {
    const student = await createUser();
    const curriculum = await getCatalogCurriculum(slug(), student.id);
    const paid = curriculum.modules.flatMap((m) => m.lessons).find((l) => l.id === published.paidLessonId);
    assert.equal(paid?.locked, true);
    assert.equal(paid?.durationSeconds, null);
  });

  it('never lists unpublished lessons', async () => {
    const curriculum = await getCatalogCurriculum(`test-course-${hiddenLessons.courseId}`);
    const all = curriculum.modules.flatMap((m) => m.lessons);
    assert.equal(all.length, 0, 'a teacher unfinished lesson must not appear in the catalog');
  });

  it('answers 404 for a draft course', async () => {
    await assert.rejects(
      () => getCatalogCurriculum(`test-course-${draft.courseId}`),
      (err: unknown) => {
        assert.ok(err instanceof ApiError);
        assert.equal(err.status, 404);
        return true;
      },
    );
  });

  it('unlocks a single-course purchase without unlocking anything else', async () => {
    const other = await createCourse({ teacherId: teacher.userId, isInAllAccess: true });
    const student = await createUser();
    await grantAccess(teacher, { studentId: student.id, courseId: published.courseId });

    const mine = await getCatalogCurriculum(slug(), student.id);
    assert.equal(mine.entitled, true);

    const theirs = await getCatalogCurriculum(`test-course-${other.courseId}`, student.id);
    assert.equal(theirs.entitled, false);
  });
});

describe('free resource centre', () => {
  it('lists free published lessons from published courses only', async () => {
    const resources = await listFreeResources();
    const ids = resources.map((r) => r.lessonId);

    assert.ok(ids.includes(published.freeLessonId));
    assert.equal(
      ids.includes(published.paidLessonId),
      false,
      'a paid lesson must never appear in the free centre',
    );
    assert.equal(
      ids.includes(draft.freeLessonId),
      false,
      'a free lesson in a draft course is not published content',
    );
    assert.equal(
      ids.includes(hiddenLessons.freeLessonId),
      false,
      'an unpublished free lesson is still unpublished',
    );
  });
});
