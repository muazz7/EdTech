import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { uuidv7 } from 'uuidv7';
import { closeDb, getDb, lessonProgress } from '@edtech/db';
import { ApiError, certificateNoSchema } from '@edtech/shared';
import {
  evaluateCompletion,
  generateCertificateNo,
  issueCertificateIfEarned,
  revokeCertificate,
  verifyCertificate,
} from './certificates.js';
import type { Actor } from '../content/ownership.js';
import { cleanup, createCourse, createUser } from '../testing/fixtures.js';

/**
 * Certificates (Section 13).
 *
 * The verification page is public and unauthenticated, which is what makes the
 * number format and the response shape security-relevant rather than cosmetic.
 */

let teacher: Actor;
let course: Awaited<ReturnType<typeof createCourse>>;

/** Marks every published lesson of the fixture course complete for a student. */
async function completeCourse(studentId: string) {
  const db = getDb();
  for (const lessonId of [course.paidLessonId, course.freeLessonId]) {
    await db
      .insert(lessonProgress)
      .values({
        studentId,
        lessonId,
        courseId: course.courseId,
        secondsWatched: 600,
        lastPosition: 600,
        isComplete: true,
        completedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [lessonProgress.studentId, lessonProgress.lessonId],
        set: { isComplete: true, completedAt: new Date() },
      });
  }
}

before(async () => {
  const user = await createUser('teacher', 'Certificate Teacher');
  teacher = { userId: user.id, role: 'teacher' };
  course = await createCourse({ teacherId: user.id, isInAllAccess: true });
});

after(async () => {
  await cleanup();
  await closeDb();
});

describe('certificate numbers', () => {
  it('is not sequential', async () => {
    // The verification page is public. CERT-2026-000418 can be walked to
    // 000419; a random suffix cannot. Without this the page is an enumeration
    // endpoint that leaks every student's name and course.
    const numbers = new Set(Array.from({ length: 200 }, () => generateCertificateNo()));
    assert.equal(numbers.size, 200, 'generated numbers collided or repeated');

    for (const number of numbers) {
      assert.doesNotThrow(() => certificateNoSchema.parse(number));
    }
  });

  it('carries enough randomness to be unguessable', async () => {
    const [first, second] = [generateCertificateNo(), generateCertificateNo()];
    const suffixOf = (value: string) => value.split('-')[2] as string;
    assert.notEqual(suffixOf(first), suffixOf(second));
    assert.equal(suffixOf(first).length, 8, '32 bits of suffix');
  });
});

describe('completion rules', () => {
  it('explains what is left rather than just refusing', async () => {
    const student = await createUser();
    const state = await evaluateCompletion(student.id, course.courseId);

    assert.equal(state.eligible, false);
    assert.ok(state.missing.length > 0, 'a bare "not eligible" is a support message');
    assert.ok(state.missing[0]?.includes('%'), 'the student should see the target');
  });

  it('becomes eligible once the lessons are done', async () => {
    const student = await createUser();
    await completeCourse(student.id);

    const state = await evaluateCompletion(student.id, course.courseId);
    assert.equal(state.lessons.completed, 2);
    assert.equal(state.lessons.percent, 100);
    assert.deepEqual(state.missing, []);
    assert.equal(state.eligible, true);
  });
});

describe('issuing', () => {
  it('issues once and only once', async () => {
    const student = await createUser('student', 'Rahim Uddin');
    await completeCourse(student.id);

    const first = await issueCertificateIfEarned(student.id, course.courseId);
    assert.equal(first.issued, true);
    assert.ok(first.certificate);

    // Idempotent: the sweep runs hourly and must not mint a second number for
    // the same course.
    const second = await issueCertificateIfEarned(student.id, course.courseId);
    assert.equal(second.issued, false);
    assert.equal(second.certificate?.certificateNo, first.certificate.certificateNo);
  });

  it('does not issue to a student who has not finished', async () => {
    const student = await createUser();
    const result = await issueCertificateIfEarned(student.id, course.courseId);
    assert.equal(result.issued, false);
    assert.equal(result.certificate, null);
  });

  it('snapshots the names at issue time', async () => {
    // A teacher leaving or a course being retitled must not rewrite a document
    // someone is already holding.
    const student = await createUser('student', 'Karim Ahmed');
    await completeCourse(student.id);

    const { certificate } = await issueCertificateIfEarned(student.id, course.courseId);
    assert.equal(certificate?.studentName, 'Karim Ahmed');
    assert.equal(certificate?.courseTitle, 'Test Course');
    assert.equal(certificate?.teacherName, 'Certificate Teacher');
  });
});

describe('public verification', () => {
  it('returns only what an employer needs', async () => {
    const student = await createUser('student', 'Nusrat Jahan');
    await completeCourse(student.id);
    const { certificate } = await issueCertificateIfEarned(student.id, course.courseId);

    const verified = await verifyCertificate(certificate!.certificateNo);
    assert.ok(verified);
    assert.equal(verified.status, 'valid');
    assert.equal(verified.studentName, 'Nusrat Jahan');

    // Anyone on the internet can make this call, so nothing that identifies the
    // account or the course record may be in the response.
    const keys = Object.keys(verified).sort();
    assert.deepEqual(keys, [
      'certificateNo',
      'courseTitle',
      'issuedAt',
      'revokedAt',
      'status',
      'studentName',
      'teacherName',
    ]);
    const serialised = JSON.stringify(verified);
    assert.equal(serialised.includes(student.id), false, 'leaks the student id');
    assert.equal(serialised.includes(course.courseId), false, 'leaks the course id');
  });

  it('is case-insensitive about the number', async () => {
    const student = await createUser();
    await completeCourse(student.id);
    const { certificate } = await issueCertificateIfEarned(student.id, course.courseId);

    const verified = await verifyCertificate(certificate!.certificateNo.toLowerCase());
    assert.equal(verified?.certificateNo, certificate!.certificateNo);
  });

  it('returns nothing for a number that does not exist', async () => {
    assert.equal(await verifyCertificate('CERT-2026-DEADBEEF'), null);
  });

  it('shows a revoked certificate as revoked, not missing', async () => {
    // An employer checking a revoked certificate must be told it was revoked.
    // A 404 reads as "this was never issued", which is a different claim.
    const student = await createUser();
    await completeCourse(student.id);
    const { certificate } = await issueCertificateIfEarned(student.id, course.courseId);

    await revokeCertificate(teacher, certificate!.id, 'Academic misconduct');

    const verified = await verifyCertificate(certificate!.certificateNo);
    assert.equal(verified?.status, 'revoked');
    assert.ok(verified?.revokedAt);
  });

  it('refuses a second revocation', async () => {
    const student = await createUser();
    await completeCourse(student.id);
    const { certificate } = await issueCertificateIfEarned(student.id, course.courseId);

    await revokeCertificate(teacher, certificate!.id, 'First');
    await assert.rejects(
      () => revokeCertificate(teacher, certificate!.id, 'Second'),
      (err: unknown) => {
        assert.ok(err instanceof ApiError);
        assert.equal(err.status, 409);
        return true;
      },
    );
  });

  it('keeps one teacher out of another teacher\'s certificates', async () => {
    const student = await createUser();
    await completeCourse(student.id);
    const { certificate } = await issueCertificateIfEarned(student.id, course.courseId);

    const outsiderUser = await createUser('teacher', 'Other Teacher');
    const outsider: Actor = { userId: outsiderUser.id, role: 'teacher' };

    await assert.rejects(
      () => revokeCertificate(outsider, certificate!.id, 'Not mine to revoke'),
      (err: unknown) => {
        assert.ok(err instanceof ApiError);
        assert.equal(err.status, 404);
        return true;
      },
    );
  });

  it('is not confused by a well-formed number for a missing certificate', async () => {
    assert.equal(await verifyCertificate(generateCertificateNo()), null);
    assert.equal(await verifyCertificate(uuidv7()), null);
  });
});
