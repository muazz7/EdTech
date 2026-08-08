import { and, asc, count, desc, eq, ilike, or, sql } from 'drizzle-orm';
import { courses, getDb, lessons, modules, plans, profiles } from '@edtech/db';
import { ApiError, ERROR_CODES } from '@edtech/shared';
import { checkCourseAccess } from '../entitlements/check-lesson-access.js';

/**
 * The public catalog (Section 18).
 *
 * This is the first surface in the codebase that serves UNAUTHENTICATED
 * callers, which changes the rules: there is no session to scope a query by, so
 * every read here has to be safe for a stranger to make. Two consequences run
 * through the whole file:
 *
 *   1. Only `state = 'published'` rows are ever visible. A draft course is a
 *      teacher's unfinished work and must not be discoverable by guessing.
 *   2. Nothing returns a media handle. Lesson titles are catalog copy; video
 *      ids, R2 keys and durations of paid content are not.
 */

export type CatalogFilters = {
  level?: string;
  subject?: string;
  teacherId?: string;
  q?: string;
  page: number;
  perPage: number;
};

export type CatalogCourse = {
  id: string;
  slug: string;
  title: string;
  subtitle: string | null;
  thumbnailKey: string | null;
  subject: string | null;
  level: string | null;
  pricePoisha: number;
  isInAllAccess: boolean;
  teacherName: string;
  publishedAt: Date | null;
  lessonCount: number;
  freeLessonCount: number;
};

export async function listCatalog(filters: CatalogFilters) {
  const db = getDb();

  const conditions = [eq(courses.state, 'published')];
  if (filters.level) conditions.push(eq(courses.level, filters.level));
  if (filters.subject) conditions.push(eq(courses.subject, filters.subject));
  if (filters.teacherId) conditions.push(eq(courses.teacherId, filters.teacherId));
  if (filters.q) {
    // ilike, not full-text search: Bangla titles are common and Postgres has no
    // Bengali text-search configuration, so a tsvector search would silently
    // match nothing for exactly the queries that matter most here.
    const term = `%${filters.q.replace(/[%_]/g, '')}%`;
    const match = or(ilike(courses.title, term), ilike(courses.subtitle, term));
    if (match) conditions.push(match);
  }

  const where = and(...conditions);
  const offset = (filters.page - 1) * filters.perPage;

  const rows = await db
    .select({
      id: courses.id,
      slug: courses.slug,
      title: courses.title,
      subtitle: courses.subtitle,
      thumbnailKey: courses.thumbnailKey,
      subject: courses.subject,
      level: courses.level,
      pricePoisha: courses.pricePoisha,
      isInAllAccess: courses.isInAllAccess,
      teacherName: profiles.fullName,
      publishedAt: courses.publishedAt,
      lessonCount: sql<number>`(
        SELECT count(*)::int FROM lessons l
        WHERE l.course_id = ${courses.id} AND l.is_published
      )`,
      freeLessonCount: sql<number>`(
        SELECT count(*)::int FROM lessons l
        WHERE l.course_id = ${courses.id} AND l.is_published AND l.is_free
      )`,
    })
    .from(courses)
    .innerJoin(profiles, eq(profiles.id, courses.teacherId))
    .where(where)
    .orderBy(asc(courses.displayOrder), desc(courses.publishedAt))
    .limit(filters.perPage)
    .offset(offset);

  const [totals] = await db.select({ total: count() }).from(courses).where(where);

  return {
    courses: rows,
    page: filters.page,
    perPage: filters.perPage,
    total: totals?.total ?? 0,
  };
}

/** Distinct levels and subjects actually in use, for the filter controls.
 *  Derived rather than hardcoded so a teacher adding "Admission" does not need
 *  a code change. */
export async function listCatalogFacets() {
  const db = getDb();

  const rows = await db
    .selectDistinct({ level: courses.level, subject: courses.subject })
    .from(courses)
    .where(eq(courses.state, 'published'));

  const levels = [...new Set(rows.map((r) => r.level).filter((v): v is string => Boolean(v)))];
  const subjects = [...new Set(rows.map((r) => r.subject).filter((v): v is string => Boolean(v)))];

  return { levels: levels.sort(), subjects: subjects.sort() };
}

export async function getCatalogCourse(slug: string) {
  const db = getDb();

  const [row] = await db
    .select({
      id: courses.id,
      slug: courses.slug,
      title: courses.title,
      subtitle: courses.subtitle,
      description: courses.description,
      thumbnailKey: courses.thumbnailKey,
      subject: courses.subject,
      level: courses.level,
      pricePoisha: courses.pricePoisha,
      isInAllAccess: courses.isInAllAccess,
      publishedAt: courses.publishedAt,
      teacherId: profiles.id,
      teacherName: profiles.fullName,
      teacherInstitution: profiles.institution,
    })
    .from(courses)
    .innerJoin(profiles, eq(profiles.id, courses.teacherId))
    .where(and(eq(courses.slug, slug), eq(courses.state, 'published')))
    .limit(1);

  // A draft course is indistinguishable from one that does not exist. Any other
  // answer lets a stranger confirm a teacher is preparing something.
  if (!row) throw new ApiError(404, ERROR_CODES.NOT_FOUND, 'Course not found.');

  return row;
}

export type CurriculumLesson = {
  id: string;
  title: string;
  type: string;
  isFree: boolean;
  /** Playable right now by this caller. */
  locked: boolean;
  /** Only for lessons the caller can actually open — otherwise a paid course's
   *  total runtime is readable without paying. */
  durationSeconds: number | null;
};

/**
 * Course structure with a lock flag per lesson (Section 18).
 *
 * Titles are deliberately public: the curriculum IS the sales pitch, and a
 * paywall that hides what is being sold does not convert. What stays hidden is
 * anything that has value on its own — descriptions, durations, page counts,
 * and every media handle.
 *
 * `userId` is optional because this endpoint serves signed-out visitors too.
 */
export async function getCatalogCurriculum(slug: string, userId?: string) {
  const db = getDb();

  const [course] = await db
    .select({ id: courses.id, isInAllAccess: courses.isInAllAccess })
    .from(courses)
    .where(and(eq(courses.slug, slug), eq(courses.state, 'published')))
    .limit(1);

  if (!course) throw new ApiError(404, ERROR_CODES.NOT_FOUND, 'Course not found.');

  // One access check for the whole course rather than one per lesson: a
  // 200-lesson course would otherwise issue 200 identical entitlement queries.
  const access = userId ? await checkCourseAccess(userId, course.id) : { allowed: false as const };
  const entitled = access.allowed;

  const moduleRows = await db
    .select({ id: modules.id, title: modules.title, displayOrder: modules.displayOrder })
    .from(modules)
    .where(eq(modules.courseId, course.id))
    .orderBy(asc(modules.displayOrder));

  const lessonRows = await db
    .select({
      id: lessons.id,
      moduleId: lessons.moduleId,
      title: lessons.title,
      type: lessons.type,
      isFree: lessons.isFree,
      durationSeconds: lessons.durationSeconds,
      displayOrder: lessons.displayOrder,
    })
    .from(lessons)
    .where(and(eq(lessons.courseId, course.id), eq(lessons.isPublished, true)))
    .orderBy(asc(lessons.displayOrder));

  const byModule = new Map<string, CurriculumLesson[]>();
  for (const lesson of lessonRows) {
    const unlocked = entitled || lesson.isFree;
    const list = byModule.get(lesson.moduleId) ?? [];
    list.push({
      id: lesson.id,
      title: lesson.title,
      type: lesson.type,
      isFree: lesson.isFree,
      locked: !unlocked,
      durationSeconds: unlocked ? lesson.durationSeconds : null,
    });
    byModule.set(lesson.moduleId, list);
  }

  return {
    courseId: course.id,
    entitled,
    via: access.allowed ? access.via : null,
    modules: moduleRows.map((m) => ({ ...m, lessons: byModule.get(m.id) ?? [] })),
  };
}

/**
 * The Free Resource Center (Section 2.3) — the conversion funnel.
 *
 * Every published free lesson across every published course. No entitlement
 * check: these are free by definition, and the point is that a signed-out
 * visitor can watch one before deciding.
 */
export async function listFreeResources(limit = 60) {
  const db = getDb();

  return db
    .select({
      lessonId: lessons.id,
      title: lessons.title,
      type: lessons.type,
      durationSeconds: lessons.durationSeconds,
      courseId: courses.id,
      courseSlug: courses.slug,
      courseTitle: courses.title,
      subject: courses.subject,
      level: courses.level,
      teacherName: profiles.fullName,
    })
    .from(lessons)
    .innerJoin(courses, eq(courses.id, lessons.courseId))
    .innerJoin(profiles, eq(profiles.id, courses.teacherId))
    .where(
      and(
        eq(lessons.isFree, true),
        eq(lessons.isPublished, true),
        eq(courses.state, 'published'),
      ),
    )
    .orderBy(desc(courses.publishedAt), asc(lessons.displayOrder))
    .limit(limit);
}

/** Active plans, for the pricing screen. */
export async function listActivePlans() {
  const db = getDb();
  return db
    .select({
      id: plans.id,
      kind: plans.kind,
      name: plans.name,
      description: plans.description,
      pricePoisha: plans.pricePoisha,
      durationDays: plans.durationDays,
    })
    .from(plans)
    .where(eq(plans.isActive, true))
    .orderBy(asc(plans.displayOrder));
}
