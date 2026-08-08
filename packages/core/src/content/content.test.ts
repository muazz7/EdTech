import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { asc, eq } from 'drizzle-orm';
import { auditLog, closeDb, getDb, lessons, modules } from '@edtech/db';
import { ApiError } from '@edtech/shared';
import { createCourse, getCurriculum, listCourses, updateCourse } from './courses.js';
import { createLesson, createModule, updateLesson } from './structure.js';
import { reorderLessons, reorderModules } from './reorder.js';
import { requireCourse, resolveActor, type Actor } from './ownership.js';
import { cleanup, createUser } from '../testing/fixtures.js';

/**
 * Teacher content management.
 *
 * The two things worth real test pressure: cross-teacher isolation (Section 1.3
 * says a teacher "cannot see other teachers' courses") and reorder set
 * validation, where a missing check would let one teacher rewrite another
 * teacher's lesson ordering.
 */

let alice: Actor;
let bob: Actor;
let admin: Actor;
let aliceCourseId: string;

async function actorFor(role: 'teacher' | 'admin', name: string): Promise<Actor> {
  const user = await createUser(role, name);
  return resolveActor(user.id);
}

before(async () => {
  alice = await actorFor('teacher', 'Alice Teacher');
  bob = await actorFor('teacher', 'Bob Teacher');
  admin = await actorFor('admin', 'Owner');

  const course = await createCourse(alice, {
    title: "Alice's HSC Physics",
    slug: `alice-physics-${Date.now()}`,
    pricePoisha: 50_000,
    isInAllAccess: true,
  });
  aliceCourseId = course.id;
});

after(async () => {
  const db = getDb();
  // Courses created through createCourse are not tracked by the fixture
  // helper, so remove them before the teacher profiles they reference.
  await db.delete(lessons).where(eq(lessons.courseId, aliceCourseId));
  await db.delete(modules).where(eq(modules.courseId, aliceCourseId));
  await db.delete(auditLog).where(eq(auditLog.entityId, aliceCourseId));
  const { courses } = await import('@edtech/db');
  await db.delete(courses).where(eq(courses.id, aliceCourseId));
  await cleanup();
  await closeDb();
});

describe('cross-teacher isolation', () => {
  it('lists only the caller own courses', async () => {
    const mine = await listCourses(alice);
    assert.ok(mine.some((c) => c.id === aliceCourseId));

    const bobs = await listCourses(bob);
    assert.equal(
      bobs.some((c) => c.id === aliceCourseId),
      false,
      "Bob must not see Alice's course",
    );
  });

  it('lets an admin see every course', async () => {
    const all = await listCourses(admin);
    assert.ok(all.some((c) => c.id === aliceCourseId));
  });

  it("returns 404, not 403, for another teacher's course", async () => {
    // 403 would confirm the id exists and let a teacher enumerate the catalog's
    // internal ids. 404 tells them nothing.
    await assert.rejects(
      () => requireCourse(bob, aliceCourseId),
      (err: unknown) => {
        assert.ok(err instanceof ApiError);
        assert.equal(err.status, 404);
        return true;
      },
    );
  });

  it("refuses to let another teacher edit the course price", async () => {
    await assert.rejects(
      () => updateCourse(bob, aliceCourseId, { pricePoisha: 1 }),
      (err: unknown) => {
        assert.ok(err instanceof ApiError);
        assert.equal(err.status, 404);
        return true;
      },
    );
  });

  it('rejects a student outright', async () => {
    const student = await createUser('student', 'Curious Student');
    await assert.rejects(
      () => resolveActor(student.id),
      (err: unknown) => {
        assert.ok(err instanceof ApiError);
        assert.equal(err.code, 'ROLE_REQUIRED');
        return true;
      },
    );
  });
});

describe('price changes are audited', () => {
  it('writes a course.price_change row with before and after', async () => {
    // ADR 0002: teachers set their own prices, so a dispute without a record is
    // the owner's word against a teacher's.
    await updateCourse(alice, aliceCourseId, { pricePoisha: 75_000 }, '203.0.113.4');

    const db = getDb();
    const rows = await db
      .select({ action: auditLog.action, before: auditLog.before, after: auditLog.after })
      .from(auditLog)
      .where(eq(auditLog.entityId, aliceCourseId));

    const priceChange = rows.find((r) => r.action === 'course.price_change');
    assert.ok(priceChange, 'expected a course.price_change audit row');
    assert.deepEqual(priceChange.before, { pricePoisha: 50_000 });
    assert.deepEqual(priceChange.after, { pricePoisha: 75_000 });
  });

  it('writes nothing when an audited field does not actually change', async () => {
    const db = getDb();
    const countBefore = (
      await db.select({ id: auditLog.id }).from(auditLog).where(eq(auditLog.entityId, aliceCourseId))
    ).length;

    // Same value again, plus an unaudited field.
    await updateCourse(alice, aliceCourseId, { pricePoisha: 75_000, subtitle: 'New subtitle' });

    const countAfter = (
      await db.select({ id: auditLog.id }).from(auditLog).where(eq(auditLog.entityId, aliceCourseId))
    ).length;

    assert.equal(countAfter, countBefore, 'a no-op price write should not log');
  });
});

describe('reorder', () => {
  it('renumbers modules and lessons sequentially', async () => {
    const m1 = await createModule(alice, aliceCourseId, { title: 'Module A' });
    const m2 = await createModule(alice, aliceCourseId, { title: 'Module B' });
    const m3 = await createModule(alice, aliceCourseId, { title: 'Module C' });

    assert.deepEqual(
      [m1.displayOrder, m2.displayOrder, m3.displayOrder],
      [1, 2, 3],
      'appended modules should get increasing order',
    );

    await reorderModules(alice, aliceCourseId, [m3.id, m1.id, m2.id]);

    const curriculum = await getCurriculum(alice, aliceCourseId);
    assert.deepEqual(
      curriculum.map((m) => m.title),
      ['Module C', 'Module A', 'Module B'],
    );
    assert.deepEqual(
      curriculum.map((m) => m.displayOrder),
      [1, 2, 3],
      'order values should be contiguous, not sparse',
    );
  });

  it('reorders lessons within a module', async () => {
    const mod = await createModule(alice, aliceCourseId, { title: 'Lessons here' });
    const a = await createLesson(alice, mod.id, {
      title: 'Lesson 1',
      type: 'pdf',
      isFree: false,
      isShortForm: false,
    });
    const b = await createLesson(alice, mod.id, {
      title: 'Lesson 2',
      type: 'pdf',
      isFree: false,
      isShortForm: false,
    });

    await reorderLessons(alice, mod.id, [b.id, a.id]);

    const db = getDb();
    const rows = await db
      .select({ id: lessons.id, order: lessons.displayOrder })
      .from(lessons)
      .where(eq(lessons.moduleId, mod.id))
      .orderBy(asc(lessons.displayOrder));

    assert.deepEqual(
      rows.map((r) => r.id),
      [b.id, a.id],
    );
  });

  it('rejects an order that omits a child', async () => {
    const mod = await createModule(alice, aliceCourseId, { title: 'Partial' });
    const a = await createLesson(alice, mod.id, {
      title: 'Keep',
      type: 'pdf',
      isFree: false,
      isShortForm: false,
    });
    await createLesson(alice, mod.id, {
      title: 'Dropped',
      type: 'pdf',
      isFree: false,
      isShortForm: false,
    });

    await assert.rejects(
      () => reorderLessons(alice, mod.id, [a.id]),
      (err: unknown) => {
        assert.ok(err instanceof ApiError);
        assert.equal(err.status, 422);
        return true;
      },
    );
  });

  it('rejects a duplicated id', async () => {
    const mod = await createModule(alice, aliceCourseId, { title: 'Dupes' });
    const a = await createLesson(alice, mod.id, {
      title: 'One',
      type: 'pdf',
      isFree: false,
      isShortForm: false,
    });
    await createLesson(alice, mod.id, {
      title: 'Two',
      type: 'pdf',
      isFree: false,
      isShortForm: false,
    });

    await assert.rejects(() => reorderLessons(alice, mod.id, [a.id, a.id]), ApiError);
  });

  it("refuses an id belonging to a different module and changes nothing", async () => {
    // The security case. Keyed by id, an unvalidated update would rewrite a
    // foreign lesson's display_order — and a version that also set module_id
    // would move content between courses.
    const modA = await createModule(alice, aliceCourseId, { title: 'Mine A' });
    const modB = await createModule(alice, aliceCourseId, { title: 'Mine B' });

    const inA = await createLesson(alice, modA.id, {
      title: 'In A',
      type: 'pdf',
      isFree: false,
      isShortForm: false,
    });
    const inB = await createLesson(alice, modB.id, {
      title: 'In B',
      type: 'pdf',
      isFree: false,
      isShortForm: false,
    });

    await assert.rejects(
      () => reorderLessons(alice, modA.id, [inB.id]),
      (err: unknown) => {
        assert.ok(err instanceof ApiError);
        assert.equal(err.status, 422);
        return true;
      },
    );

    const db = getDb();
    const untouched = await db.query.lessons.findFirst({
      where: eq(lessons.id, inB.id),
      columns: { moduleId: true, displayOrder: true },
    });
    assert.equal(untouched?.moduleId, modB.id, 'foreign lesson must not move');
    assert.equal(untouched?.displayOrder, inA.displayOrder, 'and must keep its order');
  });

  it("refuses when another teacher tries to reorder", async () => {
    const mod = await createModule(alice, aliceCourseId, { title: 'Bob keep out' });
    await createLesson(alice, mod.id, {
      title: 'Only',
      type: 'pdf',
      isFree: false,
      isShortForm: false,
    });

    await assert.rejects(() => reorderLessons(bob, mod.id, []), ApiError);
  });
});

describe('publishing guards', () => {
  it('refuses to publish a video that is not ready', async () => {
    // Otherwise a student opens a player that cannot start.
    const mod = await createModule(alice, aliceCourseId, { title: 'Video module' });
    const lesson = await createLesson(alice, mod.id, {
      title: 'Unprocessed lecture',
      type: 'video',
      isFree: false,
      isShortForm: false,
    });

    assert.equal(lesson.videoStatus, 'uploading');

    await assert.rejects(
      () => updateLesson(alice, lesson.id, { isPublished: true }),
      (err: unknown) => {
        assert.ok(err instanceof ApiError);
        assert.equal(err.status, 409);
        return true;
      },
    );
  });

  it('allows publishing a non-video lesson', async () => {
    const mod = await createModule(alice, aliceCourseId, { title: 'Doc module' });
    const lesson = await createLesson(alice, mod.id, {
      title: 'A note',
      type: 'note',
      isFree: false,
      isShortForm: false,
    });

    const updated = await updateLesson(alice, lesson.id, { isPublished: true });
    assert.equal(updated.isPublished, true);
  });

  it('rejects a duplicate slug with a clear conflict', async () => {
    const slug = `dupe-slug-${Date.now()}`;
    const first = await createCourse(alice, {
      title: 'First',
      slug,
      pricePoisha: 0,
      isInAllAccess: true,
    });

    await assert.rejects(
      () =>
        createCourse(alice, {
          title: 'Second',
          slug,
          pricePoisha: 0,
          isInAllAccess: true,
        }),
      (err: unknown) => {
        assert.ok(err instanceof ApiError);
        assert.equal(err.status, 409);
        assert.equal(err.code, 'CONFLICT');
        return true;
      },
    );

    const db = getDb();
    const { courses } = await import('@edtech/db');
    await db.delete(courses).where(eq(courses.id, first.id));
  });
});
