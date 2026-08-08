import { randomBytes } from 'node:crypto';
import { and, eq, gte, isNull, sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import {
  assignments,
  certificates,
  courseCompletionRules,
  courses,
  getDb,
  lessonProgress,
  lessons,
  profiles,
  quizAttempts,
  quizzes,
} from '@edtech/db';
import {
  ApiError,
  CERTIFICATE_PREFIX,
  ERROR_CODES,
  parseMarks,
  percentOf,
  type CompletionRulesInput,
} from '@edtech/shared';
import { recordAudit } from '../audit/log.js';
import { notify } from '../notifications/notify.js';
import { requireCourse, type Actor } from '../content/ownership.js';

/**
 * Certificates (Section 13).
 *
 * The verification page is public and unauthenticated — that is the entire
 * point of a certificate, and it shapes two decisions here:
 *
 *  - The number's suffix is RANDOM, not sequential. CERT-2026-000418 can be
 *    walked to 000419; CERT-2026-4F8A2C91 cannot. Without this the public page
 *    becomes an enumeration endpoint that leaks every student's name and course.
 *  - Revocation shows the certificate as revoked rather than 404ing. An
 *    employer checking a revoked certificate must be told it was revoked, not
 *    that it never existed.
 *
 * Student name, course title and teacher name are SNAPSHOTS taken at issue.
 * A teacher leaving or a course being retitled must not rewrite history on a
 * document someone is holding.
 */

export type CompletionState = {
  courseId: string;
  eligible: boolean;
  issuesCertificate: boolean;
  lessons: { completed: number; total: number; percent: number; required: number };
  quizzes: { attempted: number; total: number; averagePercent: number; required: number };
  assignments: { graded: number; total: number; required: boolean };
  /** The specific unmet conditions, so the student sees what is left rather
   *  than a bare "not eligible". */
  missing: string[];
};

const DEFAULT_RULES = {
  minLessonsPercent: 90,
  requireAllQuizzes: true,
  minQuizAverage: 40,
  requireAssignments: false,
  issuesCertificate: true,
};

// ── Rules ───────────────────────────────────────────────────────────────────

export async function getCompletionRules(courseId: string) {
  const db = getDb();
  const row = await db.query.courseCompletionRules.findFirst({
    where: eq(courseCompletionRules.courseId, courseId),
  });
  return row ?? { courseId, ...DEFAULT_RULES };
}

export async function setCompletionRules(
  actor: Actor,
  courseId: string,
  input: CompletionRulesInput,
) {
  await requireCourse(actor, courseId);
  const db = getDb();

  const [saved] = await db
    .insert(courseCompletionRules)
    .values({ courseId, ...input })
    .onConflictDoUpdate({ target: courseCompletionRules.courseId, set: { ...input } })
    .returning();

  if (!saved) throw new ApiError(500, ERROR_CODES.INTERNAL);

  await recordAudit({
    actorId: actor.userId,
    action: 'course.completion_rules_change',
    entityType: 'course',
    entityId: courseId,
    after: { ...input },
  });

  return saved;
}

// ── Evaluation ──────────────────────────────────────────────────────────────

/**
 * Evaluates Section 13's rule for one student against one course.
 *
 * Read-only and safe to call from a student-facing screen: it answers "what is
 * left" without issuing anything.
 */
export async function evaluateCompletion(
  studentId: string,
  courseId: string,
): Promise<CompletionState> {
  const db = getDb();
  const rules = await getCompletionRules(courseId);

  const [lessonStats] = await db
    .select({
      total: sql<number>`count(*)::int`,
      completed: sql<number>`count(*) FILTER (WHERE p.is_complete)::int`,
    })
    .from(lessons)
    .leftJoin(
      sql`lesson_progress p`,
      sql`p.lesson_id = ${lessons.id} AND p.student_id = ${studentId}`,
    )
    .where(and(eq(lessons.courseId, courseId), eq(lessons.isPublished, true)));

  const totalLessons = lessonStats?.total ?? 0;
  const completedLessons = lessonStats?.completed ?? 0;
  const lessonPercent = totalLessons === 0 ? 0 : Math.round((completedLessons / totalLessons) * 100);

  const publishedQuizzes = await db
    .select({ id: quizzes.id })
    .from(quizzes)
    .where(and(eq(quizzes.courseId, courseId), eq(quizzes.isPublished, true)));

  // Best attempt per quiz — Section 10 says the best attempt counts. Done in
  // SQL so a course with twenty quizzes is one round trip, not twenty.
  const bestAttempts = publishedQuizzes.length
    ? await db
        .select({
          quizId: quizAttempts.quizId,
          bestPercent: sql<number>`max(
            round(coalesce(total_score, 0) * 100 / greatest(coalesce(max_score, 1), 1))
          )::int`,
        })
        .from(quizAttempts)
        .innerJoin(quizzes, eq(quizzes.id, quizAttempts.quizId))
        .where(
          and(
            eq(quizzes.courseId, courseId),
            eq(quizAttempts.studentId, studentId),
            eq(quizzes.isPublished, true),
            sql`${quizAttempts.submittedAt} IS NOT NULL`,
            // An attempt still waiting on a teacher has no final score, so it
            // must not drag the average down or count as "attempted".
            eq(quizAttempts.gradingStatus, 'complete'),
          ),
        )
        .groupBy(quizAttempts.quizId)
    : [];

  const attemptedQuizzes = bestAttempts.length;
  const quizAverage =
    attemptedQuizzes === 0
      ? 0
      : Math.round(
          bestAttempts.reduce((sum, row) => sum + row.bestPercent, 0) / attemptedQuizzes,
        );

  const [assignmentStats] = await db
    .select({
      total: sql<number>`count(*)::int`,
      graded: sql<number>`count(*) FILTER (WHERE s.graded_at IS NOT NULL)::int`,
    })
    .from(assignments)
    .leftJoin(
      sql`assignment_submissions s`,
      sql`s.assignment_id = ${assignments.id} AND s.student_id = ${studentId}`,
    )
    .where(and(eq(assignments.courseId, courseId), eq(assignments.isPublished, true)));

  const totalAssignments = assignmentStats?.total ?? 0;
  const gradedAssignments = assignmentStats?.graded ?? 0;

  const missing: string[] = [];

  if (lessonPercent < rules.minLessonsPercent) {
    missing.push(
      `Complete ${rules.minLessonsPercent}% of lessons (you are at ${lessonPercent}%).`,
    );
  }
  if (rules.requireAllQuizzes && attemptedQuizzes < publishedQuizzes.length) {
    missing.push(
      `Finish all ${publishedQuizzes.length} quizzes (${attemptedQuizzes} done and graded).`,
    );
  }
  if (publishedQuizzes.length > 0 && quizAverage < rules.minQuizAverage) {
    missing.push(`Reach a ${rules.minQuizAverage}% quiz average (you are at ${quizAverage}%).`);
  }
  if (rules.requireAssignments && gradedAssignments < totalAssignments) {
    missing.push(
      `Have all ${totalAssignments} assignments graded (${gradedAssignments} done).`,
    );
  }

  return {
    courseId,
    eligible: missing.length === 0 && totalLessons > 0,
    issuesCertificate: rules.issuesCertificate,
    lessons: {
      completed: completedLessons,
      total: totalLessons,
      percent: lessonPercent,
      required: rules.minLessonsPercent,
    },
    quizzes: {
      attempted: attemptedQuizzes,
      total: publishedQuizzes.length,
      averagePercent: quizAverage,
      required: rules.minQuizAverage,
    },
    assignments: {
      graded: gradedAssignments,
      total: totalAssignments,
      required: rules.requireAssignments,
    },
    missing,
  };
}

// ── Issuing ─────────────────────────────────────────────────────────────────

/**
 * Issues a certificate if the student qualifies. Idempotent: a student who
 * already holds one for this course gets the existing record back rather than a
 * second number.
 */
export async function issueCertificateIfEarned(studentId: string, courseId: string) {
  const db = getDb();

  const existing = await db.query.certificates.findFirst({
    where: and(eq(certificates.studentId, studentId), eq(certificates.courseId, courseId)),
  });
  if (existing) return { issued: false, certificate: existing };

  const state = await evaluateCompletion(studentId, courseId);
  if (!state.eligible || !state.issuesCertificate) {
    return { issued: false, certificate: null, state };
  }

  const [course] = await db
    .select({
      title: courses.title,
      teacherName: profiles.fullName,
    })
    .from(courses)
    .innerJoin(profiles, eq(profiles.id, courses.teacherId))
    .where(eq(courses.id, courseId))
    .limit(1);

  const student = await db.query.profiles.findFirst({
    where: eq(profiles.id, studentId),
    columns: { fullName: true },
  });

  if (!course || !student) throw new ApiError(404, ERROR_CODES.NOT_FOUND);

  const [created] = await db
    .insert(certificates)
    .values({
      id: uuidv7(),
      certificateNo: generateCertificateNo(),
      studentId,
      courseId,
      // Snapshots. See the module comment — these must not follow later edits.
      studentName: student.fullName,
      courseTitle: course.title,
      teacherName: course.teacherName,
      finalScore: state.quizzes.total > 0 ? String(state.quizzes.averagePercent) : null,
    })
    // Two concurrent evaluations for the same student would otherwise race past
    // the existence check above and one would fail on the unique index.
    .onConflictDoNothing({
      target: [certificates.studentId, certificates.courseId],
    })
    .returning();

  if (!created) {
    const raced = await db.query.certificates.findFirst({
      where: and(eq(certificates.studentId, studentId), eq(certificates.courseId, courseId)),
    });
    return { issued: false, certificate: raced ?? null };
  }

  await recordAudit({
    actorId: studentId,
    action: 'certificate.issue',
    entityType: 'certificate',
    entityId: created.id,
    after: { certificateNo: created.certificateNo, courseId },
  });

  await notify({
    userId: studentId,
    type: 'certificate_issued',
    title: `Your certificate for ${course.title} is ready`,
    body: `Certificate number ${created.certificateNo}.`,
    link: '/account/certificates',
  }).catch((err) => console.error('[certificate] notify failed:', err));

  return { issued: true, certificate: created, state };
}

/**
 * `CERT-2026-4F8A2C91`.
 *
 * 32 bits of randomness from a CSPRNG, not a counter and not Math.random. The
 * verification page is public: a guessable number is a data leak, and a
 * sequential one is a crawler's index.
 */
export function generateCertificateNo(): string {
  const year = new Date().getUTCFullYear();
  const suffix = randomBytes(4).toString('hex').toUpperCase();
  return `${CERTIFICATE_PREFIX}${year}-${suffix}`;
}

// ── Cron sweep ──────────────────────────────────────────────────────────────

/**
 * Evaluates students whose progress moved recently (Section 13).
 *
 * Scoped by recent activity rather than sweeping every enrolment: the whole
 * point of the hourly window is that the work stays proportional to how much
 * studying happened, not to how many students have ever signed up.
 */
export async function sweepCertificates(params: { sinceMinutes?: number; limit?: number } = {}) {
  const db = getDb();
  const since = new Date(Date.now() - (params.sinceMinutes ?? 90) * 60 * 1000);

  const candidates = await db
    .selectDistinct({
      studentId: lessonProgress.studentId,
      courseId: lessonProgress.courseId,
    })
    .from(lessonProgress)
    .where(gte(lessonProgress.updatedAt, since))
    .limit(params.limit ?? 200);

  let issued = 0;
  let evaluated = 0;

  for (const candidate of candidates) {
    evaluated++;
    try {
      const result = await issueCertificateIfEarned(candidate.studentId, candidate.courseId);
      if (result.issued) issued++;
    } catch (err) {
      // One bad course must not stop the sweep for everyone else.
      console.error(
        `[certificate] evaluation failed for ${candidate.studentId}/${candidate.courseId}:`,
        err,
      );
    }
  }

  return { evaluated, issued };
}

// ── Reading ─────────────────────────────────────────────────────────────────

export async function listMyCertificates(studentId: string) {
  const db = getDb();
  return db
    .select({
      id: certificates.id,
      certificateNo: certificates.certificateNo,
      courseId: certificates.courseId,
      courseTitle: certificates.courseTitle,
      teacherName: certificates.teacherName,
      finalScore: certificates.finalScore,
      issuedAt: certificates.issuedAt,
      revokedAt: certificates.revokedAt,
      hasPdf: sql<boolean>`${certificates.pdfR2Key} IS NOT NULL`,
    })
    .from(certificates)
    .where(eq(certificates.studentId, studentId))
    .orderBy(sql`${certificates.issuedAt} DESC`);
}

/**
 * The PUBLIC verification lookup (Section 13).
 *
 * Returns the minimum an employer needs and nothing more: number, name, course,
 * issue date, validity. No student id, no course id, no contact details, no
 * scores. This response is readable by anyone on the internet who has a
 * certificate number.
 */
export async function verifyCertificate(certificateNo: string) {
  const db = getDb();

  const row = await db.query.certificates.findFirst({
    where: eq(certificates.certificateNo, certificateNo.trim().toUpperCase()),
    columns: {
      certificateNo: true,
      studentName: true,
      courseTitle: true,
      teacherName: true,
      issuedAt: true,
      revokedAt: true,
    },
  });

  if (!row) return null;

  return {
    certificateNo: row.certificateNo,
    studentName: row.studentName,
    courseTitle: row.courseTitle,
    teacherName: row.teacherName,
    issuedAt: row.issuedAt,
    // Revoked, not missing. An employer checking a revoked certificate must be
    // told it was revoked rather than that it never existed.
    status: row.revokedAt ? ('revoked' as const) : ('valid' as const),
    revokedAt: row.revokedAt,
  };
}

export async function revokeCertificate(actor: Actor, certificateId: string, reason: string) {
  const db = getDb();

  const certificate = await db.query.certificates.findFirst({
    where: eq(certificates.id, certificateId),
  });
  if (!certificate) throw new ApiError(404, ERROR_CODES.NOT_FOUND, 'Certificate not found.');

  await requireCourse(actor, certificate.courseId);

  const [revoked] = await db
    .update(certificates)
    .set({ revokedAt: sql`now()` })
    .where(and(eq(certificates.id, certificateId), isNull(certificates.revokedAt)))
    .returning();

  if (!revoked) {
    throw new ApiError(409, ERROR_CODES.CONFLICT, 'This certificate is already revoked.');
  }

  await recordAudit({
    actorId: actor.userId,
    action: 'certificate.revoke',
    entityType: 'certificate',
    entityId: certificateId,
    before: { certificateNo: certificate.certificateNo },
    after: { reason },
  });

  return revoked;
}

/** Course-level view for the teacher: who has earned one. */
export async function listCourseCertificates(actor: Actor, courseId: string) {
  await requireCourse(actor, courseId);
  const db = getDb();

  return db
    .select({
      id: certificates.id,
      certificateNo: certificates.certificateNo,
      studentName: certificates.studentName,
      finalScore: certificates.finalScore,
      issuedAt: certificates.issuedAt,
      revokedAt: certificates.revokedAt,
    })
    .from(certificates)
    .where(eq(certificates.courseId, courseId))
    .orderBy(sql`${certificates.issuedAt} DESC`);
}

/** Marks per-assignment weighting for a future report card. Kept here so the
 *  scoring rules live in one file. */
export function assignmentPercent(marks: string | null, maxMarks: string): number {
  return percentOf(parseMarks(marks), parseMarks(maxMarks));
}
