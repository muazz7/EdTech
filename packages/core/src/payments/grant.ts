import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { courses, entitlements, getDb, plans, profiles } from '@edtech/db';
import { ApiError, ERROR_CODES } from '@edtech/shared';
import { recordAudit } from '../audit/log.js';
import { requireCourse, type Actor } from '../content/ownership.js';

/**
 * Manual access grants and revocations.
 *
 * THE BOUNDARY THAT MATTERS: a teacher may grant access only to their OWN
 * courses, and only as a single-course entitlement.
 *
 * Nothing else is safe. `lifetime_all` and `subscription` both resolve against
 * `courses.is_in_all_access`, so a teacher able to issue one would be handing
 * out every other teacher's catalog — for free, from their own account, with no
 * payment attached. That is not a hypothetical: it is a single missing check
 * away, which is why the kind is not a parameter a teacher can influence.
 *
 * Admin retains the full range.
 */

export type ManualGrantInput = {
  studentId: string;
  courseId?: string;
  /** Admin only. A teacher's grants are always single_course. */
  kind?: 'subscription' | 'lifetime_all' | 'single_course';
  planId?: string;
  expiresAt?: Date | null;
  note?: string;
};

export async function grantAccess(actor: Actor, input: ManualGrantInput, ipAddress?: string | null) {
  const db = getDb();

  const student = await db.query.profiles.findFirst({
    where: eq(profiles.id, input.studentId),
    columns: { id: true, isActive: true, role: true },
  });
  if (!student) throw new ApiError(404, ERROR_CODES.NOT_FOUND, 'Student not found.');
  if (!student.isActive) {
    throw new ApiError(422, ERROR_CODES.VALIDATION_FAILED, 'That account is deactivated.');
  }

  let kind: 'subscription' | 'lifetime_all' | 'single_course';
  let courseId: string | null = null;
  let expiresAt: Date | null = null;

  if (actor.role === 'admin') {
    kind = input.kind ?? 'single_course';
    if (kind === 'single_course') {
      if (!input.courseId) {
        throw new ApiError(422, ERROR_CODES.VALIDATION_FAILED, 'Choose a course.');
      }
      courseId = input.courseId;
    }
    // Only a subscription may carry an expiry — the lifetime_has_no_expiry
    // CHECK enforces this at the database level too.
    expiresAt = kind === 'subscription' ? (input.expiresAt ?? null) : null;
  } else {
    if (!input.courseId) {
      throw new ApiError(422, ERROR_CODES.VALIDATION_FAILED, 'Choose one of your courses.');
    }
    // Ownership check. Throws 404 for a course belonging to someone else.
    await requireCourse(actor, input.courseId);

    kind = 'single_course';
    courseId = input.courseId;
    expiresAt = null;

    // Ignoring a supplied kind silently would be worse than refusing: a teacher
    // who believes they granted all-access has a wrong mental model of what
    // their students can see.
    if (input.kind && input.kind !== 'single_course') {
      throw new ApiError(
        403,
        ERROR_CODES.FORBIDDEN,
        'Teachers can only grant access to their own individual courses.',
      );
    }
  }

  if (courseId) {
    const course = await db.query.courses.findFirst({
      where: eq(courses.id, courseId),
      columns: { id: true },
    });
    if (!course) throw new ApiError(404, ERROR_CODES.NOT_FOUND, 'Course not found.');

    const existing = await db
      .select({ id: entitlements.id })
      .from(entitlements)
      .where(
        and(
          eq(entitlements.studentId, input.studentId),
          eq(entitlements.kind, 'single_course'),
          eq(entitlements.courseId, courseId),
          isNull(entitlements.revokedAt),
        ),
      )
      .limit(1);

    if (existing.length > 0) {
      throw new ApiError(
        409,
        ERROR_CODES.CONFLICT,
        'This student already has access to that course.',
      );
    }
  }

  if (input.planId) {
    const plan = await db.query.plans.findFirst({ where: eq(plans.id, input.planId) });
    if (!plan) throw new ApiError(404, ERROR_CODES.NOT_FOUND, 'Plan not found.');
  }

  const id = uuidv7();
  await db.insert(entitlements).values({
    id,
    studentId: input.studentId,
    kind,
    courseId,
    planId: input.planId ?? null,
    // 'manual_grant' is load-bearing in checkLessonAccess: it is what opens a
    // course flagged out of all-access.
    source: 'manual_grant',
    grantedBy: actor.userId,
    startsAt: new Date(),
    expiresAt,
    notes: input.note ?? null,
  });

  // Granting access without payment is exactly the action that needs a
  // permanent record — it is the one way to give content away for free.
  await recordAudit({
    actorId: actor.userId,
    action: 'entitlement.manual_grant',
    entityType: 'entitlement',
    entityId: id,
    after: { studentId: input.studentId, kind, courseId, expiresAt, note: input.note ?? null },
    ipAddress,
  });

  return { entitlementId: id, kind, courseId, expiresAt };
}

export async function revokeEntitlement(
  actor: Actor,
  entitlementId: string,
  reason: string,
  ipAddress?: string | null,
) {
  const db = getDb();
  const existing = await db.query.entitlements.findFirst({
    where: eq(entitlements.id, entitlementId),
  });

  if (!existing) throw new ApiError(404, ERROR_CODES.NOT_FOUND, 'Entitlement not found.');
  if (existing.revokedAt) {
    throw new ApiError(409, ERROR_CODES.CONFLICT, 'That access was already revoked.');
  }

  if (actor.role !== 'admin') {
    // A teacher may only revoke access to their own course. Revoking a
    // subscription would cut a student off from every other teacher too.
    if (existing.kind !== 'single_course' || !existing.courseId) {
      throw new ApiError(
        403,
        ERROR_CODES.FORBIDDEN,
        'Only the platform owner can revoke plan access.',
      );
    }
    await requireCourse(actor, existing.courseId);
  }

  await db
    .update(entitlements)
    .set({ revokedAt: sql`now()`, revokedReason: reason })
    .where(eq(entitlements.id, entitlementId));

  await recordAudit({
    actorId: actor.userId,
    action: 'entitlement.revoke',
    entityType: 'entitlement',
    entityId: entitlementId,
    before: { revokedAt: null },
    after: { revokedAt: new Date(), reason },
    ipAddress,
  });

  // Section 7: the entitlement cache is at most 60 seconds, so revocation bites
  // on the student's next playback request rather than at next login.
  return { revoked: true };
}

/** Students holding access to a given course, for the teacher's roster. */
export async function listCourseStudents(actor: Actor, courseId: string) {
  await requireCourse(actor, courseId);
  const db = getDb();

  return db
    .select({
      entitlementId: entitlements.id,
      studentId: profiles.id,
      studentName: profiles.fullName,
      studentPhone: profiles.phone,
      source: entitlements.source,
      startsAt: entitlements.startsAt,
      expiresAt: entitlements.expiresAt,
      revokedAt: entitlements.revokedAt,
      notes: entitlements.notes,
    })
    .from(entitlements)
    .innerJoin(profiles, eq(profiles.id, entitlements.studentId))
    .where(and(eq(entitlements.courseId, courseId), eq(entitlements.kind, 'single_course')))
    .orderBy(desc(entitlements.startsAt))
    .limit(500);
}
