import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import {
  assignmentSubmissions,
  assignments,
  courses,
  getDb,
  profiles,
} from '@edtech/db';
import {
  ApiError,
  ERROR_CODES,
  entitlementError,
  formatMarks,
  parseMarks,
  type CreateAssignmentInput,
  type GradeSubmissionInput,
  type SubmitAssignmentInput,
  type UpdateAssignmentInput,
} from '@edtech/shared';
import { recordAudit } from '../audit/log.js';
import { notify } from '../notifications/notify.js';
import { requireCourse, requireLesson, type Actor } from '../content/ownership.js';
import { checkCourseAccess } from '../entitlements/check-lesson-access.js';
import { presignDownload, presignUpload } from '../media/r2.js';

/**
 * Assignments (Section 11).
 *
 * Two rules carry the weight here:
 *
 *  1. MIME and size are validated SERVER-SIDE on the presign request, against
 *     the assignment's own `allowed_mime`. A file picker's accept attribute is
 *     a hint the client can ignore; the presign is the only place a rejection
 *     actually holds.
 *  2. Resubmission is allowed until a teacher grades it, then locked (ADR 0004).
 *     Unlimited resubmission would let a student replace the work a mark was
 *     awarded against, which makes the mark meaningless.
 */

type StoredFile = { key: string; name: string; size: number; mime: string };

// ── Teacher authoring ───────────────────────────────────────────────────────

export async function createAssignment(
  actor: Actor,
  courseId: string,
  input: CreateAssignmentInput,
) {
  const course = await requireCourse(actor, courseId);
  const db = getDb();

  if (input.lessonId) {
    const owned = await requireLesson(actor, input.lessonId);
    if (owned.course.courseId !== course.courseId) {
      throw new ApiError(404, ERROR_CODES.NOT_FOUND, 'Lesson not found.');
    }
    if (owned.type !== 'assignment') {
      throw new ApiError(
        422,
        ERROR_CODES.VALIDATION_FAILED,
        'That lesson is not an assignment lesson. Change its type first.',
      );
    }
  }

  const [created] = await db
    .insert(assignments)
    .values({
      id: uuidv7(),
      courseId: course.courseId,
      lessonId: input.lessonId ?? null,
      title: input.title,
      instructions: input.instructions,
      dueAt: input.dueAt ? new Date(input.dueAt) : null,
      maxMarks: input.maxMarks,
      ...(input.allowedMime ? { allowedMime: [...input.allowedMime] } : {}),
      maxFileMb: input.maxFileMb,
      allowLate: input.allowLate,
      isPublished: false,
    })
    .returning();

  if (!created) throw new ApiError(500, ERROR_CODES.INTERNAL);
  return created;
}

export async function updateAssignment(
  actor: Actor,
  assignmentId: string,
  input: UpdateAssignmentInput,
) {
  await requireAssignment(actor, assignmentId);
  const db = getDb();

  const patch: Record<string, unknown> = {};
  for (const key of [
    'title',
    'instructions',
    'maxMarks',
    'maxFileMb',
    'allowLate',
    'isPublished',
  ] as const) {
    if (input[key] !== undefined) patch[key] = input[key];
  }
  if (input.dueAt !== undefined) patch.dueAt = input.dueAt ? new Date(input.dueAt) : null;
  if (input.allowedMime !== undefined) patch.allowedMime = [...input.allowedMime];

  if (Object.keys(patch).length === 0) {
    throw new ApiError(422, ERROR_CODES.VALIDATION_FAILED, 'Nothing to update.');
  }

  const [updated] = await db
    .update(assignments)
    .set(patch)
    .where(eq(assignments.id, assignmentId))
    .returning();

  if (!updated) throw new ApiError(500, ERROR_CODES.INTERNAL);
  return updated;
}

export async function deleteAssignment(actor: Actor, assignmentId: string) {
  await requireAssignment(actor, assignmentId);
  const db = getDb();

  const [{ count } = { count: 0 }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(assignmentSubmissions)
    .where(eq(assignmentSubmissions.assignmentId, assignmentId));

  await db.delete(assignments).where(eq(assignments.id, assignmentId));

  await recordAudit({
    actorId: actor.userId,
    action: 'assignment.delete',
    entityType: 'assignment',
    entityId: assignmentId,
    before: { submissionsDestroyed: count },
  });

  return { deleted: true, submissionsDestroyed: count };
}

export async function listAssignmentsForCourse(actor: Actor, courseId: string) {
  await requireCourse(actor, courseId);
  const db = getDb();

  return db
    .select({
      id: assignments.id,
      lessonId: assignments.lessonId,
      title: assignments.title,
      dueAt: assignments.dueAt,
      maxMarks: assignments.maxMarks,
      isPublished: assignments.isPublished,
      submissionCount: sql<number>`(
        SELECT count(*)::int FROM assignment_submissions s
        WHERE s.assignment_id = ${assignments.id}
      )`,
      ungradedCount: sql<number>`(
        SELECT count(*)::int FROM assignment_submissions s
        WHERE s.assignment_id = ${assignments.id} AND s.graded_at IS NULL
      )`,
    })
    .from(assignments)
    .where(eq(assignments.courseId, courseId))
    .orderBy(asc(assignments.createdAt));
}

// ── Student submission ──────────────────────────────────────────────────────

/** The assignment as a student sees it, plus their own submission if any. */
export async function getAssignmentForStudent(userId: string, assignmentId: string) {
  const db = getDb();
  const assignment = await requirePublishedAssignment(userId, assignmentId);

  const submission = await db.query.assignmentSubmissions.findFirst({
    where: and(
      eq(assignmentSubmissions.assignmentId, assignmentId),
      eq(assignmentSubmissions.studentId, userId),
    ),
  });

  return {
    id: assignment.id,
    title: assignment.title,
    instructions: assignment.instructions,
    dueAt: assignment.dueAt,
    maxMarks: assignment.maxMarks,
    allowedMime: assignment.allowedMime,
    maxFileMb: assignment.maxFileMb,
    allowLate: assignment.allowLate,
    submission: submission
      ? {
          id: submission.id,
          submittedAt: submission.submittedAt,
          isLate: submission.isLate,
          studentNote: submission.studentNote,
          // File names only. The R2 keys are internal and a signed URL is a
          // separate, rate-limited call.
          files: (submission.files as StoredFile[]).map((file) => ({
            name: file.name,
            size: file.size,
            mime: file.mime,
          })),
          marks: submission.marks,
          teacherFeedback: submission.teacherFeedback,
          gradedAt: submission.gradedAt,
          locked: submission.gradedAt !== null,
        }
      : null,
  };
}

/**
 * Presigns one upload slot.
 *
 * The MIME check happens here, against the assignment's own list, because this
 * is the only gate a client cannot skip — it has to come back for a URL. The
 * same applies to size: a signed PUT with no size ceiling is an open bucket.
 */
export async function presignAssignmentUpload(
  userId: string,
  assignmentId: string,
  input: { filename: string; mime: string; size: number },
) {
  const assignment = await requirePublishedAssignment(userId, assignmentId);
  await assertSubmissionOpen(userId, assignment);

  if (!assignment.allowedMime.includes(input.mime)) {
    throw new ApiError(
      422,
      ERROR_CODES.VALIDATION_FAILED,
      `This assignment accepts ${assignment.allowedMime.join(', ')}.`,
    );
  }

  const maxBytes = assignment.maxFileMb * 1024 * 1024;
  if (input.size > maxBytes) {
    throw new ApiError(
      422,
      ERROR_CODES.VALIDATION_FAILED,
      `Files must be ${assignment.maxFileMb}MB or smaller.`,
    );
  }

  // Keyed by student so one student's submission can never overwrite another's,
  // even if they upload identically named files.
  const key = `assignments/${assignmentId}/${userId}/${uuidv7()}-${safeName(input.filename)}`;

  return presignUpload({ key, contentType: input.mime, contentLength: input.size });
}

export async function submitAssignment(
  userId: string,
  assignmentId: string,
  input: SubmitAssignmentInput,
) {
  const db = getDb();
  const assignment = await requirePublishedAssignment(userId, assignmentId);
  const existing = await assertSubmissionOpen(userId, assignment);

  // Re-checked at submit, not only at presign: the presign response is a URL a
  // client could hold while the teacher tightens the rules.
  for (const file of input.files) {
    if (!assignment.allowedMime.includes(file.mime)) {
      throw new ApiError(422, ERROR_CODES.VALIDATION_FAILED, `${file.name} is not an accepted type.`);
    }
    if (file.size > assignment.maxFileMb * 1024 * 1024) {
      throw new ApiError(422, ERROR_CODES.VALIDATION_FAILED, `${file.name} is too large.`);
    }
    // Keys are minted by presignAssignmentUpload above and carry the student's
    // id. Accepting an arbitrary key would let one student submit another's
    // file — or any object in the bucket.
    if (!file.key.startsWith(`assignments/${assignmentId}/${userId}/`)) {
      throw new ApiError(422, ERROR_CODES.VALIDATION_FAILED, 'Upload the file again.');
    }
  }

  const isLate = assignment.dueAt ? new Date() > assignment.dueAt : false;
  if (isLate && !assignment.allowLate) {
    throw new ApiError(
      409,
      ERROR_CODES.SUBMISSION_LOCKED,
      'The due date has passed and late submissions are not accepted.',
    );
  }

  const files: StoredFile[] = input.files.map((file) => ({
    key: file.key,
    name: file.name,
    size: file.size,
    mime: file.mime,
  }));

  const [saved] = await db
    .insert(assignmentSubmissions)
    .values({
      id: uuidv7(),
      assignmentId,
      studentId: userId,
      files,
      studentNote: input.studentNote ?? null,
      isLate,
    })
    .onConflictDoUpdate({
      target: [assignmentSubmissions.assignmentId, assignmentSubmissions.studentId],
      set: {
        files,
        studentNote: input.studentNote ?? null,
        isLate,
        submittedAt: sql`now()`,
      },
    })
    .returning();

  if (!saved) throw new ApiError(500, ERROR_CODES.INTERNAL);

  // Only on the first submission: a resubmission is the same task, and pinging
  // the teacher on every re-upload trains them to ignore the notification.
  if (!existing) {
    const course = await db.query.courses.findFirst({
      where: eq(courses.id, assignment.courseId),
      columns: { teacherId: true, title: true },
    });
    if (course) {
      await notify({
        userId: course.teacherId,
        type: 'assignment_submitted',
        title: `New submission for ${assignment.title}`,
        body: isLate ? 'Submitted after the due date.' : null,
        link: `/teacher/assignments/${assignmentId}`,
        push: false,
      }).catch((err) => console.error('[assignment] notify failed:', err));
    }
  }

  return {
    id: saved.id,
    submittedAt: saved.submittedAt,
    isLate: saved.isLate,
    resubmitted: Boolean(existing),
  };
}

// ── Teacher grading ─────────────────────────────────────────────────────────

export async function listSubmissions(actor: Actor, assignmentId: string) {
  const db = getDb();
  await requireAssignment(actor, assignmentId);

  return db
    .select({
      id: assignmentSubmissions.id,
      studentId: profiles.id,
      studentName: profiles.fullName,
      submittedAt: assignmentSubmissions.submittedAt,
      isLate: assignmentSubmissions.isLate,
      studentNote: assignmentSubmissions.studentNote,
      files: assignmentSubmissions.files,
      marks: assignmentSubmissions.marks,
      teacherFeedback: assignmentSubmissions.teacherFeedback,
      gradedAt: assignmentSubmissions.gradedAt,
    })
    .from(assignmentSubmissions)
    .innerJoin(profiles, eq(profiles.id, assignmentSubmissions.studentId))
    .where(eq(assignmentSubmissions.assignmentId, assignmentId))
    // Ungraded first, then oldest — the queue order a teacher actually works in.
    .orderBy(asc(assignmentSubmissions.gradedAt), asc(assignmentSubmissions.submittedAt));
}

/** Short-lived signed URL for one submitted file (Section 11). */
export async function presignSubmissionDownload(
  actor: Actor,
  submissionId: string,
  fileKey: string,
) {
  const db = getDb();

  const submission = await db.query.assignmentSubmissions.findFirst({
    where: eq(assignmentSubmissions.id, submissionId),
  });
  if (!submission) throw new ApiError(404, ERROR_CODES.NOT_FOUND, 'Submission not found.');

  await requireAssignment(actor, submission.assignmentId);

  // The key must be one this submission actually holds. Signing whatever the
  // caller sends turns this endpoint into a read primitive for the bucket.
  const files = submission.files as StoredFile[];
  const file = files.find((candidate) => candidate.key === fileKey);
  if (!file) throw new ApiError(404, ERROR_CODES.NOT_FOUND, 'File not found.');

  const signed = await presignDownload({
    key: file.key,
    filename: file.name,
    contentType: file.mime,
  });

  return { ...signed, name: file.name, mime: file.mime };
}

export async function gradeSubmission(
  actor: Actor,
  submissionId: string,
  input: GradeSubmissionInput,
) {
  const db = getDb();

  const submission = await db.query.assignmentSubmissions.findFirst({
    where: eq(assignmentSubmissions.id, submissionId),
  });
  if (!submission) throw new ApiError(404, ERROR_CODES.NOT_FOUND, 'Submission not found.');

  const assignment = await requireAssignment(actor, submission.assignmentId);

  const marks = parseMarks(input.marks);
  const maximum = parseMarks(assignment.maxMarks);
  if (marks < 0 || marks > maximum) {
    throw new ApiError(
      422,
      ERROR_CODES.VALIDATION_FAILED,
      `Marks must be between 0 and ${assignment.maxMarks}.`,
    );
  }

  const [graded] = await db
    .update(assignmentSubmissions)
    .set({
      marks: formatMarks(marks),
      teacherFeedback: input.teacherFeedback ?? null,
      gradedBy: actor.userId,
      gradedAt: sql`now()`,
    })
    .where(eq(assignmentSubmissions.id, submissionId))
    .returning();

  if (!graded) throw new ApiError(500, ERROR_CODES.INTERNAL);

  await notify({
    userId: submission.studentId,
    type: 'assignment_graded',
    title: `${assignment.title} has been graded`,
    body: `You scored ${graded.marks} out of ${assignment.maxMarks}.`,
    link: assignment.lessonId ? `/learn/lessons/${assignment.lessonId}` : '/my-courses',
  }).catch((err) => console.error('[assignment] grade notify failed:', err));

  return graded;
}

// ── Internals ───────────────────────────────────────────────────────────────

export async function requireAssignment(actor: Actor, assignmentId: string) {
  const db = getDb();
  const assignment = await db.query.assignments.findFirst({
    where: eq(assignments.id, assignmentId),
  });
  if (!assignment) throw new ApiError(404, ERROR_CODES.NOT_FOUND, 'Assignment not found.');

  await requireCourse(actor, assignment.courseId);
  return assignment;
}

async function requirePublishedAssignment(userId: string, assignmentId: string) {
  const db = getDb();
  const assignment = await db.query.assignments.findFirst({
    where: eq(assignments.id, assignmentId),
  });

  if (!assignment || !assignment.isPublished) {
    throw new ApiError(404, ERROR_CODES.NOT_FOUND, 'Assignment not found.');
  }

  const access = await checkCourseAccess(userId, assignment.courseId);
  if (!access.allowed) throw entitlementError(access.reason);

  return assignment;
}

/**
 * Resubmission is open until a teacher grades it, then locked (ADR 0004).
 *
 * Returns the existing submission when there is one, so the caller can tell a
 * first submission from a replacement.
 */
async function assertSubmissionOpen(
  userId: string,
  assignment: typeof assignments.$inferSelect,
) {
  const db = getDb();

  const existing = await db.query.assignmentSubmissions.findFirst({
    where: and(
      eq(assignmentSubmissions.assignmentId, assignment.id),
      eq(assignmentSubmissions.studentId, userId),
    ),
  });

  if (existing?.gradedAt) {
    throw new ApiError(
      409,
      ERROR_CODES.SUBMISSION_LOCKED,
      'This assignment has been graded and can no longer be changed.',
    );
  }

  return existing ?? null;
}

/** Strips anything that could confuse an object key or a Content-Disposition
 *  header downstream. */
function safeName(filename: string): string {
  return filename.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80);
}

/** Submissions still waiting for a mark, for the teacher dashboard badge. */
export async function countUngradedSubmissions(actor: Actor, courseId: string) {
  await requireCourse(actor, courseId);
  const db = getDb();

  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(assignmentSubmissions)
    .innerJoin(assignments, eq(assignments.id, assignmentSubmissions.assignmentId))
    .where(and(eq(assignments.courseId, courseId), isNull(assignmentSubmissions.gradedAt)));

  return row?.count ?? 0;
}

/** Most recent submissions across a teacher's courses, for the grading queue. */
export async function listRecentSubmissions(actor: Actor, limit = 50) {
  const db = getDb();

  return db
    .select({
      id: assignmentSubmissions.id,
      assignmentId: assignments.id,
      assignmentTitle: assignments.title,
      courseTitle: courses.title,
      studentName: profiles.fullName,
      submittedAt: assignmentSubmissions.submittedAt,
      isLate: assignmentSubmissions.isLate,
      gradedAt: assignmentSubmissions.gradedAt,
      marks: assignmentSubmissions.marks,
      maxMarks: assignments.maxMarks,
    })
    .from(assignmentSubmissions)
    .innerJoin(assignments, eq(assignments.id, assignmentSubmissions.assignmentId))
    .innerJoin(courses, eq(courses.id, assignments.courseId))
    .innerJoin(profiles, eq(profiles.id, assignmentSubmissions.studentId))
    .where(actor.role === 'admin' ? undefined : eq(courses.teacherId, actor.userId))
    .orderBy(asc(assignmentSubmissions.gradedAt), desc(assignmentSubmissions.submittedAt))
    .limit(limit);
}
