import { eq } from 'drizzle-orm';
import { courses, getDb, lessons, modules, profiles } from '@edtech/db';
import { ApiError, ERROR_CODES } from '@edtech/shared';

/**
 * Ownership boundary (Section 1.3): a teacher creates and publishes their OWN
 * courses and "cannot see other teachers' courses". The Owner/Admin can do
 * everything.
 *
 * Every teacher-scoped mutation resolves ownership through one of these. Doing
 * the check ad hoc per route is how one route eventually forgets, and the
 * failure mode is a teacher editing a colleague's course.
 *
 * All three deliberately return 404 rather than 403 for a resource owned by
 * someone else. A 403 confirms the id exists, which lets a teacher enumerate
 * the catalog's internal ids; 404 tells them nothing.
 */

export type Actor = { userId: string; role: 'student' | 'teacher' | 'admin' };

/** Resolves the caller's live role from the database, not from a JWT claim — a
 *  demoted teacher holding a valid 15-minute token must lose access now. */
export async function resolveActor(userId: string): Promise<Actor> {
  const db = getDb();
  const profile = await db.query.profiles.findFirst({
    where: eq(profiles.id, userId),
    columns: { role: true, isActive: true },
  });

  if (!profile) throw new ApiError(401, ERROR_CODES.UNAUTHENTICATED);
  if (!profile.isActive) throw new ApiError(403, ERROR_CODES.ACCOUNT_DEACTIVATED);
  if (profile.role === 'student') {
    throw new ApiError(403, ERROR_CODES.ROLE_REQUIRED, 'This area is for teachers.');
  }

  return { userId, role: profile.role };
}

export type OwnedCourse = {
  courseId: string;
  teacherId: string;
  state: 'draft' | 'published' | 'archived';
  isInAllAccess: boolean;
};

export async function requireCourse(actor: Actor, courseId: string): Promise<OwnedCourse> {
  const db = getDb();
  const course = await db.query.courses.findFirst({
    where: eq(courses.id, courseId),
    columns: { id: true, teacherId: true, state: true, isInAllAccess: true },
  });

  if (!course) throw new ApiError(404, ERROR_CODES.NOT_FOUND, 'Course not found.');
  if (actor.role !== 'admin' && course.teacherId !== actor.userId) {
    throw new ApiError(404, ERROR_CODES.NOT_FOUND, 'Course not found.');
  }

  return {
    courseId: course.id,
    teacherId: course.teacherId,
    state: course.state,
    isInAllAccess: course.isInAllAccess,
  };
}

export async function requireModule(
  actor: Actor,
  moduleId: string,
): Promise<{ moduleId: string; course: OwnedCourse }> {
  const db = getDb();
  const row = await db.query.modules.findFirst({
    where: eq(modules.id, moduleId),
    columns: { id: true, courseId: true },
  });

  if (!row) throw new ApiError(404, ERROR_CODES.NOT_FOUND, 'Module not found.');
  return { moduleId: row.id, course: await requireCourse(actor, row.courseId) };
}

export async function requireLesson(
  actor: Actor,
  lessonId: string,
): Promise<{
  lessonId: string;
  moduleId: string;
  type: string;
  vdocipherVideoId: string | null;
  r2ObjectKey: string | null;
  course: OwnedCourse;
}> {
  const db = getDb();
  const row = await db.query.lessons.findFirst({
    where: eq(lessons.id, lessonId),
    columns: {
      id: true,
      moduleId: true,
      courseId: true,
      type: true,
      vdocipherVideoId: true,
      r2ObjectKey: true,
    },
  });

  if (!row) throw new ApiError(404, ERROR_CODES.NOT_FOUND, 'Lesson not found.');

  return {
    lessonId: row.id,
    moduleId: row.moduleId,
    type: row.type,
    vdocipherVideoId: row.vdocipherVideoId,
    r2ObjectKey: row.r2ObjectKey,
    course: await requireCourse(actor, row.courseId),
  };
}
