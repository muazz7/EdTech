import { asc, desc, eq, sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { courses, getDb, lessons, modules } from '@edtech/db';
import {
  ApiError,
  ERROR_CODES,
  type CreateCourseInput,
  type UpdateCourseInput,
} from '@edtech/shared';
import { diffFields, recordAudit } from '../audit/log.js';
import { requireCourse, type Actor } from './ownership.js';

/** Fields whose change is worth a permanent record. */
const AUDITED = ['pricePoisha', 'isInAllAccess', 'state', 'title'] as const;

export async function listCourses(actor: Actor) {
  const db = getDb();

  // A teacher sees only their own; an admin sees everything (Section 1.3).
  const where = actor.role === 'admin' ? undefined : eq(courses.teacherId, actor.userId);

  return db
    .select({
      id: courses.id,
      slug: courses.slug,
      title: courses.title,
      subtitle: courses.subtitle,
      state: courses.state,
      pricePoisha: courses.pricePoisha,
      isInAllAccess: courses.isInAllAccess,
      subject: courses.subject,
      level: courses.level,
      thumbnailKey: courses.thumbnailKey,
      teacherId: courses.teacherId,
      publishedAt: courses.publishedAt,
      updatedAt: courses.updatedAt,
    })
    .from(courses)
    .where(where)
    .orderBy(desc(courses.updatedAt));
}

export async function createCourse(actor: Actor, input: CreateCourseInput) {
  const db = getDb();
  const id = uuidv7();

  // The slug is a permanent public identifier, so a collision must be a clear
  // 409 rather than a 500 from the unique index.
  const existing = await db.query.courses.findFirst({
    where: eq(courses.slug, input.slug),
    columns: { id: true },
  });
  if (existing) {
    throw new ApiError(
      409,
      ERROR_CODES.CONFLICT,
      'That URL slug is already taken. Choose another.',
    );
  }

  const [created] = await db
    .insert(courses)
    .values({
      id,
      slug: input.slug,
      title: input.title,
      subtitle: input.subtitle ?? null,
      description: input.description ?? null,
      subject: input.subject ?? null,
      level: input.level ?? null,
      pricePoisha: input.pricePoisha,
      isInAllAccess: input.isInAllAccess,
      // An admin creating on a teacher's behalf is a Phase 2 concern; for now
      // the creator owns it.
      teacherId: actor.userId,
      state: 'draft',
    })
    .returning();

  if (!created) throw new ApiError(500, ERROR_CODES.INTERNAL);

  await recordAudit({
    actorId: actor.userId,
    action: 'course.create',
    entityType: 'course',
    entityId: id,
    after: { slug: input.slug, title: input.title, pricePoisha: input.pricePoisha },
  });

  return created;
}

export async function updateCourse(
  actor: Actor,
  courseId: string,
  input: UpdateCourseInput,
  ipAddress?: string | null,
) {
  const owned = await requireCourse(actor, courseId);
  const db = getDb();

  const before = await db.query.courses.findFirst({ where: eq(courses.id, courseId) });
  if (!before) throw new ApiError(404, ERROR_CODES.NOT_FOUND);

  const patch: Record<string, unknown> = { updatedAt: sql`now()` };
  for (const key of [
    'title',
    'subtitle',
    'description',
    'subject',
    'level',
    'pricePoisha',
    'isInAllAccess',
    'state',
  ] as const) {
    if (input[key] !== undefined) patch[key] = input[key];
  }

  // Publishing stamps published_at once. Re-publishing an archived course keeps
  // the original date — the catalog sorts by it and students remember when a
  // course appeared.
  if (input.state === 'published' && !before.publishedAt) {
    patch.publishedAt = new Date();
  }

  const [updated] = await db
    .update(courses)
    .set(patch)
    .where(eq(courses.id, courseId))
    .returning();

  if (!updated) throw new ApiError(500, ERROR_CODES.INTERNAL);

  const audited = Object.fromEntries(
    AUDITED.filter((k) => input[k] !== undefined).map((k) => [k, input[k]]),
  );
  const { before: b, after: a, changed } = diffFields(before, audited);

  // ADR 0002: a price change without a record is your word against a
  // teacher's. Only writes a row when something audited actually moved.
  if (changed.length > 0) {
    await recordAudit({
      actorId: actor.userId,
      action: changed.includes('pricePoisha') ? 'course.price_change' : 'course.update',
      entityType: 'course',
      entityId: owned.courseId,
      before: b,
      after: a,
      ipAddress,
    });
  }

  return updated;
}

/**
 * Full curriculum for the teacher portal: modules with their lessons.
 *
 * Two queries and an in-memory join rather than one join with duplicated module
 * rows — a course with 200 lessons would otherwise ship the module columns 200
 * times over a Bangladeshi mobile connection.
 */
export async function getCurriculum(actor: Actor, courseId: string) {
  await requireCourse(actor, courseId);
  const db = getDb();

  const moduleRows = await db
    .select({
      id: modules.id,
      title: modules.title,
      description: modules.description,
      displayOrder: modules.displayOrder,
    })
    .from(modules)
    .where(eq(modules.courseId, courseId))
    .orderBy(asc(modules.displayOrder));

  const lessonRows = await db
    .select({
      id: lessons.id,
      moduleId: lessons.moduleId,
      title: lessons.title,
      type: lessons.type,
      displayOrder: lessons.displayOrder,
      isFree: lessons.isFree,
      isPublished: lessons.isPublished,
      videoStatus: lessons.videoStatus,
      durationSeconds: lessons.durationSeconds,
      pageCount: lessons.pageCount,
      hasFile: sql<boolean>`(${lessons.r2ObjectKey} IS NOT NULL OR ${lessons.vdocipherVideoId} IS NOT NULL)`,
    })
    .from(lessons)
    .where(eq(lessons.courseId, courseId))
    .orderBy(asc(lessons.displayOrder));

  const byModule = new Map<string, typeof lessonRows>();
  for (const lesson of lessonRows) {
    const list = byModule.get(lesson.moduleId) ?? [];
    list.push(lesson);
    byModule.set(lesson.moduleId, list);
  }

  return moduleRows.map((m) => ({ ...m, lessons: byModule.get(m.id) ?? [] }));
}
