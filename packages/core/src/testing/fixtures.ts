import { eq, inArray } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import {
  auditLog,
  courses,
  entitlements,
  getDb,
  lessons,
  modules,
  payments,
  profiles,
} from '@edtech/db';
import type { UserRole } from '@edtech/shared';

/**
 * Test fixtures against the real database.
 *
 * These tests deliberately do not mock the database. The bugs worth catching
 * here live in SQL: partial unique indexes, CHECK constraints, RLS recursion,
 * and transaction behaviour under connection pooling. A mocked `db` would have
 * passed every one of the four bugs found while getting Phase 0 running.
 *
 * profiles.id has an FK to Supabase's auth.users, so a test profile needs a
 * real auth user. Created through the Admin REST API rather than by inserting
 * into auth.users directly — that table's shape is Supabase's to change.
 */

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} must be set to run these tests.`);
  return value;
}

function adminHeaders() {
  const key = requireEnv('SUPABASE_SERVICE_ROLE_KEY');
  return {
    apikey: key,
    authorization: `Bearer ${key}`,
    'content-type': 'application/json',
  };
}

/** Distinct per run so parallel or repeated runs never collide on the phone
 *  unique index. */
export function randomPhone(): string {
  const digits = Math.floor(10_000_000 + Math.random() * 89_999_999);
  return `+88017${digits}`;
}

// Everything created during a run, torn down in reverse dependency order.
const createdUserIds: string[] = [];
const createdCourseIds: string[] = [];

export async function createUser(
  role: UserRole = 'student',
  fullName = 'Test User',
): Promise<{ id: string; phone: string }> {
  const url = requireEnv('SUPABASE_URL');
  const phone = randomPhone();

  const res = await fetch(`${url}/auth/v1/admin/users`, {
    method: 'POST',
    headers: adminHeaders(),
    body: JSON.stringify({ phone, phone_confirm: true }),
  });

  if (!res.ok) {
    throw new Error(`createUser failed: ${res.status} ${await res.text()}`);
  }

  const { id } = (await res.json()) as { id: string };
  createdUserIds.push(id);

  const db = getDb();
  await db.insert(profiles).values({ id, fullName, phone, role });

  return { id, phone };
}

export type CourseFixture = {
  courseId: string;
  moduleId: string;
  paidLessonId: string;
  freeLessonId: string;
};

export async function createCourse(params: {
  teacherId: string;
  published?: boolean;
  lessonPublished?: boolean;
  isInAllAccess?: boolean;
}): Promise<CourseFixture> {
  const db = getDb();
  const courseId = uuidv7();
  const moduleId = uuidv7();
  const paidLessonId = uuidv7();
  const freeLessonId = uuidv7();
  const published = params.published ?? true;
  const lessonPublished = params.lessonPublished ?? true;

  await db.insert(courses).values({
    id: courseId,
    // Full uuid, not a prefix: UUIDv7 leads with a millisecond timestamp, so
    // any short prefix collides for courses created in the same batch.
    slug: `test-course-${courseId}`,
    title: 'Test Course',
    teacherId: params.teacherId,
    pricePoisha: 50_000, // 500 BDT
    isInAllAccess: params.isInAllAccess ?? true,
    state: published ? 'published' : 'draft',
    publishedAt: published ? new Date() : null,
  });
  createdCourseIds.push(courseId);

  await db.insert(modules).values({
    id: moduleId,
    courseId,
    title: 'Module 1',
    displayOrder: 1,
  });

  await db.insert(lessons).values([
    {
      id: paidLessonId,
      moduleId,
      courseId,
      title: 'Paid lesson',
      type: 'video',
      displayOrder: 1,
      isFree: false,
      isPublished: lessonPublished,
    },
    {
      id: freeLessonId,
      moduleId,
      courseId,
      title: 'Free preview lesson',
      type: 'video',
      displayOrder: 2,
      isFree: true,
      isPublished: lessonPublished,
    },
  ]);

  return { courseId, moduleId, paidLessonId, freeLessonId };
}

/**
 * Insert an entitlement. Note the schema CHECKs constrain what is even
 * expressible:
 *   single_course_needs_course — course_id set iff kind is 'single_course'
 *   lifetime_has_no_expiry     — only 'subscription' may carry expires_at
 * So "an expired lifetime pass" is not a state the database permits, and the
 * tests below do not pretend otherwise.
 */
export async function grantEntitlement(params: {
  studentId: string;
  kind: 'subscription' | 'lifetime_all' | 'single_course';
  courseId?: string | null;
  source?: 'purchase' | 'manual_grant' | 'promo' | 'migration';
  startsAt?: Date;
  expiresAt?: Date | null;
  revoked?: boolean;
}): Promise<string> {
  const db = getDb();
  const id = uuidv7();

  await db.insert(entitlements).values({
    id,
    studentId: params.studentId,
    kind: params.kind,
    courseId: params.kind === 'single_course' ? (params.courseId ?? null) : null,
    source: params.source ?? 'purchase',
    startsAt: params.startsAt ?? new Date(Date.now() - 60_000),
    expiresAt: params.kind === 'subscription' ? (params.expiresAt ?? null) : null,
    revokedAt: params.revoked ? new Date() : null,
    revokedReason: params.revoked ? 'test' : null,
  });

  return id;
}

/**
 * Teardown. Order matters: courses.teacher_id has no ON DELETE CASCADE, so a
 * teacher profile cannot be removed while their courses exist.
 */
export async function cleanup(): Promise<void> {
  const db = getDb();
  const url = process.env.SUPABASE_URL;

  if (createdCourseIds.length > 0) {
    // Order is forced by the foreign keys and is not interchangeable:
    // entitlements reference BOTH courses and payments
    // (fk_entitlement_payment), and payments reference courses. Deleting
    // payments before entitlements fails on the entitlement FK.
    const doomed = await db
      .select({ id: payments.id })
      .from(payments)
      .where(inArray(payments.courseId, createdCourseIds));

    await db.delete(entitlements).where(inArray(entitlements.courseId, createdCourseIds));
    if (doomed.length > 0) {
      await db.delete(entitlements).where(
        inArray(
          entitlements.paymentId,
          doomed.map((p) => p.id),
        ),
      );
    }
    await db.delete(payments).where(inArray(payments.courseId, createdCourseIds));
    await db.delete(courses).where(inArray(courses.id, createdCourseIds));
    createdCourseIds.length = 0;
  }

  if (createdUserIds.length > 0) {
    // audit_log.actor_id has no ON DELETE rule — the trail is immutable by
    // design, so a profile that performed an audited action cannot be removed
    // while its rows exist. Correct in production; here it would strand every
    // fixture that created a course or approved a payment.
    await db.delete(auditLog).where(inArray(auditLog.actorId, createdUserIds));
    await db.delete(entitlements).where(inArray(entitlements.grantedBy, createdUserIds));
    await db.delete(payments).where(inArray(payments.reviewedBy, createdUserIds));
  }

  for (const id of createdUserIds) {
    // Deleting the auth user cascades to profiles, and from there to sessions,
    // entitlements, refresh tokens and device tokens.
    if (url) {
      await fetch(`${url}/auth/v1/admin/users/${id}`, {
        method: 'DELETE',
        headers: adminHeaders(),
      }).catch(() => undefined);
    }
    await db.delete(profiles).where(eq(profiles.id, id)).catch(() => undefined);
  }
  createdUserIds.length = 0;
}
