import { and, eq, gt, isNull, isNotNull, lte, or } from 'drizzle-orm';
import { courses, entitlements, getDb, lessons, profiles } from '@edtech/db';
import { PAYMENT_GRACE_PERIOD_DAYS } from '@edtech/shared';

export type AccessResult =
  | {
      allowed: true;
      via: 'free' | 'subscription' | 'lifetime_all' | 'single_course' | 'manual' | 'owner';
      /**
       * The entitlement has actually lapsed, but is inside the Section 8.3
       * grace period. Access continues; the UI is expected to say so loudly.
       */
      inGrace?: true;
      graceEndsAt?: Date;
    }
  | { allowed: false; reason: 'no_entitlement' | 'expired' | 'revoked' | 'unpublished' };

/**
 * Grace period (Section 8.3): three days after expiry, content still opens.
 *
 * This is deliberate revenue leakage. Without it a student who paid at 11pm and
 * is verified at 9am spends the night locked out of a course they have paid
 * for, and "I paid and got locked out while you were asleep" is the worst
 * support conversation in the product. Three days of leakage is cheaper than
 * that conversation, and far cheaper than the refund it usually ends in.
 *
 * The window is measured from `expires_at`, not from a payment, so it applies
 * uniformly to a lapsed subscription and to a manual grant that ran out.
 */
function graceCutoff(now: Date): Date {
  return new Date(now.getTime() - PAYMENT_GRACE_PERIOD_DAYS * 24 * 60 * 60 * 1000);
}

function graceEnd(expiresAt: Date): Date {
  return new Date(expiresAt.getTime() + PAYMENT_GRACE_PERIOD_DAYS * 24 * 60 * 60 * 1000);
}

type AccessVia = 'subscription' | 'lifetime_all' | 'single_course' | 'manual';

/**
 * Which access rule this entitlement satisfies for this course, in the order
 * the rules are written, or null if none.
 *
 * Order matters and is not interchangeable: a manual `lifetime_all` grant on a
 * course flagged OUT of all-access matches only the last rule, and calling it
 * 'lifetime_all' would report an access route the student does not hold.
 */
function matchVia(
  entitlement: { kind: string; courseId: string | null; source: string },
  courseId: string,
  isInAllAccess: boolean,
): AccessVia | null {
  if (entitlement.kind === 'single_course' && entitlement.courseId === courseId) {
    return 'single_course';
  }
  if (entitlement.kind === 'lifetime_all' && isInAllAccess) return 'lifetime_all';
  if (entitlement.kind === 'subscription' && isInAllAccess) return 'subscription';
  if (
    entitlement.source === 'manual_grant' &&
    (!entitlement.courseId || entitlement.courseId === courseId)
  ) {
    return 'manual';
  }
  return null;
}

/**
 * The single entitlement gate. Not two, not a helper per feature — one.
 *
 * Rules that are not negotiable (Section 7):
 *
 *  - Runs on the SERVER, on EVERY protected request. A client-side `hasAccess`
 *    flag exists only to decide whether to grey out a button.
 *  - Runs immediately before issuing a VdoCipher OTP or an R2 signed URL, not
 *    at page load. A student whose subscription expires mid-session loses
 *    access on their next play, not at their next login.
 *  - Cache the result for at most 60 seconds per (user, course). Longer, and a
 *    revocation takes too long to bite.
 */
export async function checkLessonAccess(userId: string, lessonId: string): Promise<AccessResult> {
  const db = getDb();

  const [row] = await db
    .select({
      lessonId: lessons.id,
      courseId: lessons.courseId,
      isFree: lessons.isFree,
      isPublished: lessons.isPublished,
      courseState: courses.state,
      teacherId: courses.teacherId,
      isInAllAccess: courses.isInAllAccess,
    })
    .from(lessons)
    .innerJoin(courses, eq(courses.id, lessons.courseId))
    .where(eq(lessons.id, lessonId))
    .limit(1);

  if (!row || row.courseState !== 'published' || !row.isPublished) {
    return { allowed: false, reason: 'unpublished' };
  }

  const profile = await db.query.profiles.findFirst({
    where: eq(profiles.id, userId),
    columns: { role: true },
  });

  if (profile?.role === 'admin') return { allowed: true, via: 'owner' };
  if (profile?.role === 'teacher' && row.teacherId === userId) {
    return { allowed: true, via: 'owner' };
  }

  // Free lessons are the conversion funnel. Checked after the ownership cases
  // so a teacher previewing their own unpublished course still works.
  if (row.isFree) return { allowed: true, via: 'free' };

  const now = new Date();
  const active = await db
    .select({
      kind: entitlements.kind,
      courseId: entitlements.courseId,
      source: entitlements.source,
      expiresAt: entitlements.expiresAt,
    })
    .from(entitlements)
    .where(
      and(
        eq(entitlements.studentId, userId),
        isNull(entitlements.revokedAt),
        lte(entitlements.startsAt, now),
        // Includes entitlements that lapsed inside the grace window. Live ones
        // are preferred below, so a student holding both keeps full access.
        or(isNull(entitlements.expiresAt), gt(entitlements.expiresAt, graceCutoff(now))),
      ),
    );

  // `via` comes from the rule that MATCHED, not from the entitlement's kind.
  // A manual lifetime grant on a course flagged out of all-access matches only
  // the manual_grant rule, and reporting it as 'lifetime_all' would claim an
  // access route the student does not actually hold.
  const matched = active
    .map((e) => ({ entitlement: e, via: matchVia(e, row.courseId, row.isInAllAccess) }))
    .filter((m): m is { entitlement: (typeof active)[number]; via: AccessVia } => m.via !== null);

  // A still-live entitlement wins over one in grace: a student who renewed
  // early must not be told they are in a grace period.
  const live = matched.find((m) => !m.entitlement.expiresAt || m.entitlement.expiresAt > now);
  if (live) return { allowed: true, via: live.via };

  const lapsed = matched.find((m) => m.entitlement.expiresAt);
  if (lapsed?.entitlement.expiresAt) {
    return {
      allowed: true,
      via: lapsed.via,
      inGrace: true,
      graceEndsAt: graceEnd(lapsed.entitlement.expiresAt),
    };
  }

  // Distinguish "expired" from "never had it": the first shows a Renew CTA,
  // the second shows Choose a plan. Getting this wrong sends renewing students
  // through the full purchase flow and costs conversions.
  //
  // NOTE: the spec's snippet only checks this when the student holds zero
  // active entitlements. That misses a student who holds an unrelated active
  // single-course entitlement plus an expired subscription — the common case
  // for a lapsed subscriber. Checked unconditionally here.
  if (await hasExpiredEntitlementFor(userId, row.courseId, row.isInAllAccess)) {
    return { allowed: false, reason: 'expired' };
  }

  return { allowed: false, reason: 'no_entitlement' };
}

/** Did this student ever hold an entitlement that WOULD have covered this
 *  course, which has since lapsed? */
async function hasExpiredEntitlementFor(
  userId: string,
  courseId: string,
  isInAllAccess: boolean,
): Promise<boolean> {
  const db = getDb();
  const now = new Date();

  const rows = await db
    .select({ kind: entitlements.kind, courseId: entitlements.courseId })
    .from(entitlements)
    .where(
      and(
        eq(entitlements.studentId, userId),
        isNull(entitlements.revokedAt),
        isNotNull(entitlements.expiresAt),
        lte(entitlements.expiresAt, now),
      ),
    );

  return rows.some(
    (e) =>
      (e.kind === 'single_course' && e.courseId === courseId) ||
      (e.kind !== 'single_course' && isInAllAccess),
  );
}

/** Course-level variant for catalog and curriculum listings, where every
 *  lesson would otherwise trigger its own round trip. */
export async function checkCourseAccess(userId: string, courseId: string): Promise<AccessResult> {
  const db = getDb();

  const [course] = await db
    .select({
      id: courses.id,
      state: courses.state,
      teacherId: courses.teacherId,
      isInAllAccess: courses.isInAllAccess,
    })
    .from(courses)
    .where(eq(courses.id, courseId))
    .limit(1);

  if (!course || course.state !== 'published') {
    return { allowed: false, reason: 'unpublished' };
  }

  const profile = await db.query.profiles.findFirst({
    where: eq(profiles.id, userId),
    columns: { role: true },
  });

  if (profile?.role === 'admin') return { allowed: true, via: 'owner' };
  if (profile?.role === 'teacher' && course.teacherId === userId) {
    return { allowed: true, via: 'owner' };
  }

  const now = new Date();
  const active = await db
    .select({
      kind: entitlements.kind,
      courseId: entitlements.courseId,
      source: entitlements.source,
      expiresAt: entitlements.expiresAt,
    })
    .from(entitlements)
    .where(
      and(
        eq(entitlements.studentId, userId),
        isNull(entitlements.revokedAt),
        lte(entitlements.startsAt, now),
        or(isNull(entitlements.expiresAt), gt(entitlements.expiresAt, graceCutoff(now))),
      ),
    );

  // Same rule as the lesson gate, through the same helper: the two must agree,
  // or a course would list as open and every lesson in it would refuse.
  const matched = active
    .map((e) => ({ entitlement: e, via: matchVia(e, courseId, course.isInAllAccess) }))
    .filter((m): m is { entitlement: (typeof active)[number]; via: AccessVia } => m.via !== null);

  const live = matched.find((m) => !m.entitlement.expiresAt || m.entitlement.expiresAt > now);
  if (live) return { allowed: true, via: live.via };

  const lapsed = matched.find((m) => m.entitlement.expiresAt);
  if (lapsed?.entitlement.expiresAt) {
    return {
      allowed: true,
      via: lapsed.via,
      inGrace: true,
      graceEndsAt: graceEnd(lapsed.entitlement.expiresAt),
    };
  }

  if (await hasExpiredEntitlementFor(userId, courseId, course.isInAllAccess)) {
    return { allowed: false, reason: 'expired' };
  }

  return { allowed: false, reason: 'no_entitlement' };
}
