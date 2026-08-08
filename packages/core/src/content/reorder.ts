import { asc, eq } from 'drizzle-orm';
import { getDb, lessons, modules } from '@edtech/db';
import { ApiError, ERROR_CODES } from '@edtech/shared';
import { requireCourse, requireModule, type Actor } from './ownership.js';

/**
 * Drag-and-drop reordering at both levels (Section 2.2).
 *
 * The client sends the complete ordered list of children. Before writing
 * anything, the server asserts that list is EXACTLY the current set of
 * children — same members, no extras, no omissions, no duplicates.
 *
 * That check is a security boundary, not input hygiene. Without it, passing a
 * lesson id belonging to another teacher's course would reassign it: the update
 * is keyed by id, so a foreign id would have its display_order rewritten, and a
 * naive implementation that also set module_id would silently move content
 * between courses. Set equality makes that unrepresentable.
 */

function assertExactSet(provided: string[], actual: string[]): void {
  if (provided.length !== new Set(provided).size) {
    throw new ApiError(
      422,
      ERROR_CODES.VALIDATION_FAILED,
      'The order contains the same item more than once.',
    );
  }

  if (provided.length !== actual.length) {
    throw new ApiError(
      422,
      ERROR_CODES.VALIDATION_FAILED,
      `Expected ${actual.length} items in the new order, received ${provided.length}. ` +
        'Reload and try again.',
    );
  }

  const known = new Set(actual);
  for (const id of provided) {
    if (!known.has(id)) {
      // Deliberately does not echo the offending id back.
      throw new ApiError(
        422,
        ERROR_CODES.VALIDATION_FAILED,
        'The order refers to an item that is not part of this course.',
      );
    }
  }
}

/** Reorder the modules of one course. */
export async function reorderModules(
  actor: Actor,
  courseId: string,
  orderedIds: string[],
): Promise<{ updated: number }> {
  await requireCourse(actor, courseId);
  const db = getDb();

  const existing = await db
    .select({ id: modules.id })
    .from(modules)
    .where(eq(modules.courseId, courseId))
    .orderBy(asc(modules.displayOrder));

  assertExactSet(
    orderedIds,
    existing.map((m) => m.id),
  );

  // One transaction: a partially applied order leaves the curriculum in an
  // arbitrary sequence, which a student sees immediately.
  await db.transaction(async (tx) => {
    for (const [index, id] of orderedIds.entries()) {
      await tx
        .update(modules)
        .set({ displayOrder: index + 1 })
        .where(eq(modules.id, id));
    }
  });

  return { updated: orderedIds.length };
}

/** Reorder the lessons within one module. */
export async function reorderLessons(
  actor: Actor,
  moduleId: string,
  orderedIds: string[],
): Promise<{ updated: number }> {
  await requireModule(actor, moduleId);
  const db = getDb();

  const existing = await db
    .select({ id: lessons.id })
    .from(lessons)
    .where(eq(lessons.moduleId, moduleId))
    .orderBy(asc(lessons.displayOrder));

  assertExactSet(
    orderedIds,
    existing.map((l) => l.id),
  );

  await db.transaction(async (tx) => {
    for (const [index, id] of orderedIds.entries()) {
      await tx
        .update(lessons)
        .set({ displayOrder: index + 1 })
        .where(eq(lessons.id, id));
    }
  });

  return { updated: orderedIds.length };
}

/** Next display_order for an appended child. Not unique-constrained, so a gap
 *  or a tie is survivable — but ties make drag-and-drop feel broken. */
export async function nextModuleOrder(courseId: string): Promise<number> {
  const db = getDb();
  const rows = await db
    .select({ order: modules.displayOrder })
    .from(modules)
    .where(eq(modules.courseId, courseId));
  return rows.reduce((max, r) => Math.max(max, r.order), 0) + 1;
}

export async function nextLessonOrder(moduleId: string): Promise<number> {
  const db = getDb();
  const rows = await db
    .select({ order: lessons.displayOrder })
    .from(lessons)
    .where(eq(lessons.moduleId, moduleId));
  return rows.reduce((max, r) => Math.max(max, r.order), 0) + 1;
}
