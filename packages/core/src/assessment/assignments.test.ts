import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { closeDb } from '@edtech/db';
import { ApiError } from '@edtech/shared';
import {
  createAssignment,
  getAssignmentForStudent,
  gradeSubmission,
  listSubmissions,
  presignAssignmentUpload,
  submitAssignment,
  updateAssignment,
} from './assignments.js';
import type { Actor } from '../content/ownership.js';
import { cleanup, createCourse, createUser, grantEntitlement } from '../testing/fixtures.js';

/**
 * Assignments (Section 11).
 *
 * The presign is the only gate a client cannot skip, so it is where the MIME
 * and size rules have to hold. A file picker's accept attribute is a hint.
 */

let teacher: Actor;
let course: Awaited<ReturnType<typeof createCourse>>;

function assignmentInput(overrides: Partial<Parameters<typeof createAssignment>[2]> = {}) {
  return {
    title: 'Practice set 1',
    instructions: 'Solve every problem and upload a photo of your work.',
    maxMarks: '100',
    maxFileMb: 10,
    allowLate: true,
    ...overrides,
  };
}

async function publishedAssignment(overrides: Parameters<typeof assignmentInput>[0] = {}) {
  const created = await createAssignment(teacher, course.courseId, assignmentInput(overrides));
  await updateAssignment(teacher, created.id, { isPublished: true });
  return created;
}

/** A key of the shape presignAssignmentUpload would have minted. */
function keyFor(assignmentId: string, studentId: string, name = 'work.pdf') {
  return `assignments/${assignmentId}/${studentId}/abc-${name}`;
}

before(async () => {
  const user = await createUser('teacher', 'Assignment Teacher');
  teacher = { userId: user.id, role: 'teacher' };
  course = await createCourse({ teacherId: user.id, isInAllAccess: true });
});

after(async () => {
  await cleanup();
  await closeDb();
});

describe('upload gating', () => {
  it('refuses a disallowed MIME before it ever reaches storage', async () => {
    const assignment = await publishedAssignment({ allowedMime: ['application/pdf'] });
    const student = await createUser();
    await grantEntitlement({ studentId: student.id, kind: 'lifetime_all' });

    await assert.rejects(
      () =>
        presignAssignmentUpload(student.id, assignment.id, {
          filename: 'answers.exe',
          mime: 'application/x-msdownload',
          size: 1000,
        }),
      (err: unknown) => {
        assert.ok(err instanceof ApiError);
        assert.equal(err.status, 422);
        return true;
      },
    );
  });

  it('refuses a file over the assignment limit', async () => {
    // A signed PUT with no size ceiling is an open bucket.
    const assignment = await publishedAssignment({ maxFileMb: 1 });
    const student = await createUser();
    await grantEntitlement({ studentId: student.id, kind: 'lifetime_all' });

    await assert.rejects(
      () =>
        presignAssignmentUpload(student.id, assignment.id, {
          filename: 'huge.pdf',
          mime: 'application/pdf',
          size: 5 * 1024 * 1024,
        }),
      (err: unknown) => {
        assert.ok(err instanceof ApiError);
        assert.equal(err.status, 422);
        return true;
      },
    );
  });

  it('refuses a student with no entitlement', async () => {
    const assignment = await publishedAssignment();
    const student = await createUser();

    await assert.rejects(
      () => getAssignmentForStudent(student.id, assignment.id),
      (err: unknown) => {
        assert.ok(err instanceof ApiError);
        assert.equal(err.status, 403);
        return true;
      },
    );
  });

  it('hides an unpublished assignment as a 404', async () => {
    const assignment = await createAssignment(teacher, course.courseId, assignmentInput());
    const student = await createUser();
    await grantEntitlement({ studentId: student.id, kind: 'lifetime_all' });

    await assert.rejects(
      () => getAssignmentForStudent(student.id, assignment.id),
      (err: unknown) => {
        assert.ok(err instanceof ApiError);
        assert.equal(err.status, 404);
        return true;
      },
    );
  });
});

describe('submitting', () => {
  it('refuses a key that belongs to another student', async () => {
    // Keys are minted per student. Accepting an arbitrary one would let a
    // student submit somebody else's file, or any object in the bucket.
    const assignment = await publishedAssignment();
    const student = await createUser();
    const victim = await createUser();
    await grantEntitlement({ studentId: student.id, kind: 'lifetime_all' });

    await assert.rejects(
      () =>
        submitAssignment(student.id, assignment.id, {
          files: [
            {
              key: keyFor(assignment.id, victim.id),
              name: 'work.pdf',
              size: 1000,
              mime: 'application/pdf',
            },
          ],
        }),
      (err: unknown) => {
        assert.ok(err instanceof ApiError);
        assert.equal(err.status, 422);
        return true;
      },
    );
  });

  it('re-checks the MIME at submit, not only at presign', async () => {
    // The presign response is a URL a client could hold while the teacher
    // tightens the rules.
    const assignment = await publishedAssignment({ allowedMime: ['application/pdf'] });
    const student = await createUser();
    await grantEntitlement({ studentId: student.id, kind: 'lifetime_all' });

    await assert.rejects(
      () =>
        submitAssignment(student.id, assignment.id, {
          files: [
            {
              key: keyFor(assignment.id, student.id, 'sneaky.png'),
              name: 'sneaky.png',
              size: 1000,
              mime: 'image/png',
            },
          ],
        }),
      (err: unknown) => {
        assert.ok(err instanceof ApiError);
        assert.equal(err.status, 422);
        return true;
      },
    );
  });

  it('flags a late submission against the due date', async () => {
    const assignment = await publishedAssignment({
      dueAt: new Date(Date.now() - 60_000).toISOString(),
      allowLate: true,
    });
    const student = await createUser();
    await grantEntitlement({ studentId: student.id, kind: 'lifetime_all' });

    const saved = await submitAssignment(student.id, assignment.id, {
      files: [
        {
          key: keyFor(assignment.id, student.id),
          name: 'work.pdf',
          size: 1000,
          mime: 'application/pdf',
        },
      ],
    });

    assert.equal(saved.isLate, true);
  });

  it('refuses a late submission when the teacher disallowed it', async () => {
    const assignment = await publishedAssignment({
      dueAt: new Date(Date.now() - 60_000).toISOString(),
      allowLate: false,
    });
    const student = await createUser();
    await grantEntitlement({ studentId: student.id, kind: 'lifetime_all' });

    await assert.rejects(
      () =>
        submitAssignment(student.id, assignment.id, {
          files: [
            {
              key: keyFor(assignment.id, student.id),
              name: 'work.pdf',
              size: 1000,
              mime: 'application/pdf',
            },
          ],
        }),
      (err: unknown) => {
        assert.ok(err instanceof ApiError);
        assert.equal(err.code, 'SUBMISSION_LOCKED');
        return true;
      },
    );
  });
});

describe('resubmission (ADR 0004)', () => {
  it('allows replacing work until it is graded', async () => {
    const assignment = await publishedAssignment();
    const student = await createUser();
    await grantEntitlement({ studentId: student.id, kind: 'lifetime_all' });

    const first = await submitAssignment(student.id, assignment.id, {
      files: [
        {
          key: keyFor(assignment.id, student.id, 'first.pdf'),
          name: 'first.pdf',
          size: 1000,
          mime: 'application/pdf',
        },
      ],
    });
    assert.equal(first.resubmitted, false);

    const second = await submitAssignment(student.id, assignment.id, {
      files: [
        {
          key: keyFor(assignment.id, student.id, 'second.pdf'),
          name: 'second.pdf',
          size: 1000,
          mime: 'application/pdf',
        },
      ],
    });
    assert.equal(second.resubmitted, true);

    const view = await getAssignmentForStudent(student.id, assignment.id);
    assert.equal(view.submission?.files[0]?.name, 'second.pdf');
    assert.equal(view.submission?.locked, false);
  });

  it('locks the submission once a mark has been awarded', async () => {
    // Unlimited resubmission would let a student replace the work the mark was
    // awarded against, which makes the mark meaningless.
    const assignment = await publishedAssignment();
    const student = await createUser();
    await grantEntitlement({ studentId: student.id, kind: 'lifetime_all' });

    await submitAssignment(student.id, assignment.id, {
      files: [
        {
          key: keyFor(assignment.id, student.id),
          name: 'work.pdf',
          size: 1000,
          mime: 'application/pdf',
        },
      ],
    });

    const [submission] = await listSubmissions(teacher, assignment.id);
    await gradeSubmission(teacher, submission!.id, { marks: '80', teacherFeedback: 'Good.' });

    await assert.rejects(
      () =>
        submitAssignment(student.id, assignment.id, {
          files: [
            {
              key: keyFor(assignment.id, student.id, 'redo.pdf'),
              name: 'redo.pdf',
              size: 1000,
              mime: 'application/pdf',
            },
          ],
        }),
      (err: unknown) => {
        assert.ok(err instanceof ApiError);
        assert.equal(err.code, 'SUBMISSION_LOCKED');
        return true;
      },
    );

    const view = await getAssignmentForStudent(student.id, assignment.id);
    assert.equal(view.submission?.locked, true);
    assert.equal(view.submission?.marks, '80.00');
    assert.equal(view.submission?.teacherFeedback, 'Good.');
  });
});

describe('grading', () => {
  it('refuses marks above the maximum', async () => {
    const assignment = await publishedAssignment({ maxMarks: '50' });
    const student = await createUser();
    await grantEntitlement({ studentId: student.id, kind: 'lifetime_all' });

    await submitAssignment(student.id, assignment.id, {
      files: [
        {
          key: keyFor(assignment.id, student.id),
          name: 'work.pdf',
          size: 1000,
          mime: 'application/pdf',
        },
      ],
    });

    const [submission] = await listSubmissions(teacher, assignment.id);
    await assert.rejects(
      () => gradeSubmission(teacher, submission!.id, { marks: '80' }),
      (err: unknown) => {
        assert.ok(err instanceof ApiError);
        assert.equal(err.status, 422);
        return true;
      },
    );
  });

  it('keeps one teacher out of another teacher\'s submissions', async () => {
    const assignment = await publishedAssignment();
    const student = await createUser();
    await grantEntitlement({ studentId: student.id, kind: 'lifetime_all' });

    await submitAssignment(student.id, assignment.id, {
      files: [
        {
          key: keyFor(assignment.id, student.id),
          name: 'work.pdf',
          size: 1000,
          mime: 'application/pdf',
        },
      ],
    });

    const outsiderUser = await createUser('teacher', 'Other Teacher');
    const outsider: Actor = { userId: outsiderUser.id, role: 'teacher' };

    await assert.rejects(
      () => listSubmissions(outsider, assignment.id),
      (err: unknown) => {
        assert.ok(err instanceof ApiError);
        assert.equal(err.status, 404);
        return true;
      },
    );
  });

  it('does not hand the student the R2 keys of their own files', async () => {
    // The key is internal. A signed URL is a separate, rate-limited call.
    const assignment = await publishedAssignment();
    const student = await createUser();
    await grantEntitlement({ studentId: student.id, kind: 'lifetime_all' });

    await submitAssignment(student.id, assignment.id, {
      files: [
        {
          key: keyFor(assignment.id, student.id),
          name: 'work.pdf',
          size: 1000,
          mime: 'application/pdf',
        },
      ],
    });

    const view = await getAssignmentForStudent(student.id, assignment.id);
    assert.equal(JSON.stringify(view).includes('assignments/'), false);
  });
});
