import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { and, eq } from 'drizzle-orm';
import { closeDb, entitlements, getDb, payments, plans } from '@edtech/db';
import { ApiError } from '@edtech/shared';
import { uuidv7 } from 'uuidv7';
import { createPaymentMethod } from './methods.js';
import { createPaymentIntent } from './intent.js';
import { approvePayment, listPaymentQueue, rejectPayment, submitPaymentProof } from './review.js';
import { grantAccess, revokeEntitlement } from './grant.js';
import { resolveActor, type Actor } from '../content/ownership.js';
import { createCourse, updateCourse } from '../content/courses.js';
import { checkLessonAccess } from '../entitlements/check-lesson-access.js';
import { createCourse as createCourseFixture, cleanup, createUser } from '../testing/fixtures.js';
import { __resetMemoryLimiter } from '../rate-limit/limiter.js';

/**
 * Section 19.4, test 2: "Payment approval — entitlement created correctly,
 * renewal stacking correct, duplicate transaction ID rejected."
 *
 * Extended for the teacher-collected money model: a teacher must be able to
 * verify payments for their own courses and only their own, and must not be
 * able to grant access that spans other teachers' catalogs.
 */

const DAY = 24 * 60 * 60 * 1000;

let alice: Actor;
let bob: Actor;
let admin: Actor;
let aliceCourse: Awaited<ReturnType<typeof createCourseFixture>>;
let bobCourse: Awaited<ReturnType<typeof createCourseFixture>>;
let monthlyPlanId: string;
/** Courses made via createCourse are not tracked by the fixture helper, so they
 *  must be removed before the teacher profiles they reference. */
const createdCourseIds: string[] = [];

async function actorFor(role: 'teacher' | 'admin', name: string): Promise<Actor> {
  const user = await createUser(role, name);
  return resolveActor(user.id);
}

/** Walks a student through intent -> proof, returning the payment row. */
async function submitFor(studentId: string, courseId: string, transactionId: string) {
  const intent = await createPaymentIntent(studentId, { courseId });
  return submitPaymentProof(studentId, {
    referenceCode: intent.referenceCode,
    channel: 'bkash',
    senderNumber: '01712345678',
    transactionId,
  });
}

before(async () => {
  alice = await actorFor('teacher', 'Alice Teacher');
  bob = await actorFor('teacher', 'Bob Teacher');
  admin = await actorFor('admin', 'Platform Owner');

  // Each teacher publishes their own receiving number — money never transits
  // the platform in this model.
  await createPaymentMethod(alice, { channel: 'bkash', accountNumber: '01712345678' });
  await createPaymentMethod(bob, { channel: 'nagad', accountNumber: '01812345678' });
  await createPaymentMethod(admin, { channel: 'bkash', accountNumber: '01912345678' });

  aliceCourse = await createCourseFixture({ teacherId: alice.userId, isInAllAccess: true });
  bobCourse = await createCourseFixture({ teacherId: bob.userId, isInAllAccess: true });

  const db = getDb();
  monthlyPlanId = uuidv7();
  await db.insert(plans).values({
    id: monthlyPlanId,
    kind: 'subscription',
    name: 'Monthly All-Access',
    pricePoisha: 100_000,
    durationDays: 30,
  });
});

after(async () => {
  const db = getDb();
  const { courses } = await import('@edtech/db');

  // Entitlements and payments reference plans and courses, so they go first.
  for (const courseId of createdCourseIds) {
    await db.delete(entitlements).where(eq(entitlements.courseId, courseId));
    await db.delete(payments).where(eq(payments.courseId, courseId));
    await db.delete(courses).where(eq(courses.id, courseId));
  }
  await db.delete(entitlements).where(eq(entitlements.planId, monthlyPlanId));
  await db.delete(payments).where(eq(payments.planId, monthlyPlanId));
  await db.delete(plans).where(eq(plans.id, monthlyPlanId));

  await cleanup();
  await closeDb();
});

describe('payment methods', () => {
  it('normalises a mobile number to the local form a wallet expects', async () => {
    const teacher = await actorFor('teacher', 'Number Normaliser');
    const created = await createPaymentMethod(teacher, {
      channel: 'bkash',
      accountNumber: '+8801711111111',
    });
    assert.equal(created.accountNumber, '01711111111');
  });

  it('rejects a number that is not a Bangladeshi mobile', async () => {
    const teacher = await actorFor('teacher', 'Bad Number');
    await assert.rejects(
      () => createPaymentMethod(teacher, { channel: 'bkash', accountNumber: '12345' }),
      (err: unknown) => {
        assert.ok(err instanceof ApiError);
        assert.equal(err.status, 422);
        return true;
      },
    );
  });

  it('refuses the same number twice on one channel', async () => {
    const teacher = await actorFor('teacher', 'Duplicate Number');
    await createPaymentMethod(teacher, { channel: 'bkash', accountNumber: '01722222222' });
    await assert.rejects(
      () => createPaymentMethod(teacher, { channel: 'bkash', accountNumber: '01722222222' }),
      (err: unknown) => {
        assert.ok(err instanceof ApiError);
        assert.equal(err.status, 409);
        return true;
      },
    );
  });
});

describe('payment intent', () => {
  it("routes a course payment to that course's teacher and shows their number", async () => {
    const student = await createUser();
    const intent = await createPaymentIntent(student.id, { courseId: aliceCourse.courseId });

    assert.match(intent.referenceCode, /^PAY-[A-Z0-9]{6}$/);
    assert.equal(intent.amountPoisha, 50_000);
    assert.deepEqual(
      intent.methods.map((m) => m.accountNumber),
      ['01712345678'],
      "student should see Alice's number, not Bob's",
    );

    const db = getDb();
    const row = await db.query.payments.findFirst({ where: eq(payments.id, intent.paymentId) });
    assert.equal(row?.reviewerId, alice.userId);
  });

  it('reuses a pending intent instead of minting a second code', async () => {
    // A student reloading the instructions page must not end up holding two
    // reference codes with no idea which one they wrote on the transfer.
    const student = await createUser();
    const first = await createPaymentIntent(student.id, { courseId: aliceCourse.courseId });
    const second = await createPaymentIntent(student.id, { courseId: aliceCourse.courseId });
    assert.equal(second.referenceCode, first.referenceCode);
    assert.equal(second.paymentId, first.paymentId);
  });

  it('locks the amount at intent time, so a later price change does not follow it', async () => {
    // Teachers change prices freely (ADR 0002). A student quoted 500 BDT who
    // transfers 500 BDT must be approved for 500 even if the price moved to 900
    // while they were walking to the shop.
    const student = await createUser();
    const course = await createCourse(alice, {
      title: 'Price Moves',
      slug: `price-moves-${Date.now()}`,
      pricePoisha: 50_000,
      isInAllAccess: true,
    });
    await updateCourse(alice, course.id, { state: 'published' });

    const intent = await createPaymentIntent(student.id, { courseId: course.id });
    assert.equal(intent.amountPoisha, 50_000);

    await updateCourse(alice, course.id, { pricePoisha: 90_000 });

    const db = getDb();
    const row = await db.query.payments.findFirst({ where: eq(payments.id, intent.paymentId) });
    assert.equal(row?.amountPoisha, 50_000, 'the locked amount must not follow the price');

    // And a fresh intent for a different student quotes the NEW price.
    const later = await createUser();
    const newIntent = await createPaymentIntent(later.id, { courseId: course.id });
    assert.equal(newIntent.amountPoisha, 90_000);

    createdCourseIds.push(course.id);
  });

  it('refuses a course the student already owns', async () => {
    const student = await createUser();
    await grantAccess(alice, { studentId: student.id, courseId: aliceCourse.courseId });
    await assert.rejects(
      () => createPaymentIntent(student.id, { courseId: aliceCourse.courseId }),
      (err: unknown) => {
        assert.ok(err instanceof ApiError);
        assert.equal(err.status, 409);
        return true;
      },
    );
  });
});

describe('proof submission', () => {
  it('rejects a duplicate transaction ID on the same channel', async () => {
    // Enforced by the uniq_channel_txid partial index, not application code.
    // It must surface as DUPLICATE_TRANSACTION_ID, never a 500 (Section 8.1).
    __resetMemoryLimiter();
    const first = await createUser();
    const second = await createUser();

    // Unique per run. A hardcoded id collides with rows left by an earlier run
    // — the tests share one real database, and the index is global.
    const txid = `TRXDUP${Date.now().toString().slice(-4)}`;

    await submitFor(first.id, aliceCourse.courseId, txid);

    await assert.rejects(
      () => submitFor(second.id, aliceCourse.courseId, txid),
      (err: unknown) => {
        assert.ok(err instanceof ApiError);
        assert.equal(err.status, 409);
        assert.equal(err.code, 'DUPLICATE_TRANSACTION_ID');
        return true;
      },
    );
  });

  it('keeps the screenshot and note when a student resubmits to fix a typo', async () => {
    // Regression guard. The first version nulled every optional field on each
    // submission, so a student correcting their transaction ID silently erased
    // the screenshot they had already uploaded — destroying the teacher's
    // evidence and the student's own proof in a dispute.
    __resetMemoryLimiter();
    const student = await createUser();
    const intent = await createPaymentIntent(student.id, { courseId: aliceCourse.courseId });

    await submitPaymentProof(student.id, {
      referenceCode: intent.referenceCode,
      channel: 'bkash',
      senderNumber: '01712345678',
      transactionId: `TRXTYPO${Date.now().toString().slice(-3)}`,
      proofKey: 'payments/abc/proof.jpg',
      studentNote: 'Sent at 9pm',
    });

    // Resubmission with only the corrected field.
    const corrected = await submitPaymentProof(student.id, {
      referenceCode: intent.referenceCode,
      channel: 'bkash',
      senderNumber: '01712345678',
      transactionId: `TRXFIXED${Date.now().toString().slice(-2)}`,
    });

    assert.equal(corrected.proofR2Key, 'payments/abc/proof.jpg');
    assert.equal(corrected.studentNote, 'Sent at 9pm');
    assert.match(corrected.transactionId ?? '', /^TRXFIXED/);
  });

  it("refuses another student's reference code", async () => {
    __resetMemoryLimiter();
    const owner = await createUser();
    const stranger = await createUser();
    const intent = await createPaymentIntent(owner.id, { courseId: aliceCourse.courseId });

    await assert.rejects(
      () =>
        submitPaymentProof(stranger.id, {
          referenceCode: intent.referenceCode,
          channel: 'bkash',
          senderNumber: '01700000000',
          transactionId: 'TRXSTRANGE',
        }),
      (err: unknown) => {
        assert.ok(err instanceof ApiError);
        assert.equal(err.code, 'PAYMENT_REFERENCE_UNKNOWN');
        return true;
      },
    );
  });
});

describe('verification queue isolation', () => {
  it("a teacher sees only payments for their own courses", async () => {
    __resetMemoryLimiter();
    const student = await createUser();
    const payment = await submitFor(student.id, aliceCourse.courseId, `TRXQ${Date.now()}`);

    const aliceQueue = await listPaymentQueue(alice);
    assert.ok(aliceQueue.some((p) => p.id === payment.id));

    const bobQueue = await listPaymentQueue(bob);
    assert.equal(
      bobQueue.some((p) => p.id === payment.id),
      false,
      "Bob must not see payments for Alice's course",
    );
  });

  it("a teacher cannot approve another teacher's payment", async () => {
    __resetMemoryLimiter();
    const student = await createUser();
    const payment = await submitFor(student.id, aliceCourse.courseId, `TRXX${Date.now()}`);

    await assert.rejects(
      () => approvePayment(bob, payment.id),
      (err: unknown) => {
        assert.ok(err instanceof ApiError);
        // 404, not 403: a 403 would confirm the payment exists and let one
        // teacher probe another's revenue.
        assert.equal(err.status, 404);
        return true;
      },
    );

    const db = getDb();
    const row = await db.query.payments.findFirst({ where: eq(payments.id, payment.id) });
    assert.equal(row?.status, 'pending', 'the payment must be untouched');
  });
});

describe('approval issues the entitlement', () => {
  it('creates a single_course entitlement that unlocks the lesson', async () => {
    __resetMemoryLimiter();
    const student = await createUser();

    const before = await checkLessonAccess(student.id, aliceCourse.paidLessonId);
    assert.deepEqual(before, { allowed: false, reason: 'no_entitlement' });

    const payment = await submitFor(student.id, aliceCourse.courseId, `TRXA${Date.now()}`);
    const result = await approvePayment(alice, payment.id);

    assert.equal(result.kind, 'single_course');
    assert.equal(result.expiresAt, null);

    const after = await checkLessonAccess(student.id, aliceCourse.paidLessonId);
    assert.deepEqual(after, { allowed: true, via: 'single_course' });
  });

  it('does not unlock a different teacher course', async () => {
    __resetMemoryLimiter();
    const student = await createUser();
    const payment = await submitFor(student.id, aliceCourse.courseId, `TRXB${Date.now()}`);
    await approvePayment(alice, payment.id);

    const other = await checkLessonAccess(student.id, bobCourse.paidLessonId);
    assert.equal(other.allowed, false);
  });

  it('refuses to approve twice', async () => {
    __resetMemoryLimiter();
    const student = await createUser();
    const payment = await submitFor(student.id, aliceCourse.courseId, `TRXC${Date.now()}`);
    await approvePayment(alice, payment.id);

    await assert.rejects(
      () => approvePayment(alice, payment.id),
      (err: unknown) => {
        assert.ok(err instanceof ApiError);
        assert.equal(err.code, 'PAYMENT_NOT_PENDING');
        return true;
      },
    );

    // One payment, one entitlement.
    const db = getDb();
    const issued = await db
      .select({ id: entitlements.id })
      .from(entitlements)
      .where(eq(entitlements.paymentId, payment.id));
    assert.equal(issued.length, 1);
  });

  it('writes an audit row naming the reviewer', async () => {
    __resetMemoryLimiter();
    const student = await createUser();
    const payment = await submitFor(student.id, aliceCourse.courseId, `TRXD${Date.now()}`);
    await approvePayment(alice, payment.id, '203.0.113.7');

    const db = getDb();
    const { auditLog } = await import('@edtech/db');
    const rows = await db
      .select({ action: auditLog.action, actorId: auditLog.actorId })
      .from(auditLog)
      .where(and(eq(auditLog.entityId, payment.id), eq(auditLog.action, 'payment.approve')));

    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.actorId, alice.userId);
  });
});

describe('renewal stacking', () => {
  it('adds to the remaining time instead of restarting the clock', async () => {
    // Section 8.2: renewing on day 25 of 30 must leave 35 days, not 30.
    // Getting this wrong is a support message every single month.
    __resetMemoryLimiter();
    const student = await createUser();

    const db = getDb();
    const existingExpiry = new Date(Date.now() + 5 * DAY);
    await db.insert(entitlements).values({
      id: uuidv7(),
      studentId: student.id,
      kind: 'subscription',
      planId: monthlyPlanId,
      source: 'purchase',
      startsAt: new Date(Date.now() - 25 * DAY),
      expiresAt: existingExpiry,
    });

    const intent = await createPaymentIntent(student.id, { planId: monthlyPlanId });
    await submitPaymentProof(student.id, {
      referenceCode: intent.referenceCode,
      channel: 'bkash',
      senderNumber: '01700000000',
      transactionId: `TRXR${Date.now()}`,
    });

    // A plan payment carries no reviewer, so it is the Owner's to approve.
    const result = await approvePayment(admin, intent.paymentId);

    assert.equal(result.kind, 'subscription');
    assert.equal(
      result.startsAt.getTime(),
      existingExpiry.getTime(),
      'the new period must begin where the old one ended',
    );

    const expected = existingExpiry.getTime() + 30 * DAY;
    assert.ok(
      Math.abs((result.expiresAt?.getTime() ?? 0) - expected) < 1000,
      `expected ~${new Date(expected).toISOString()}, got ${result.expiresAt?.toISOString()}`,
    );
  });

  it('starts from now when nothing is active', async () => {
    __resetMemoryLimiter();
    const student = await createUser();
    const intent = await createPaymentIntent(student.id, { planId: monthlyPlanId });
    await submitPaymentProof(student.id, {
      referenceCode: intent.referenceCode,
      channel: 'bkash',
      senderNumber: '01700000000',
      transactionId: `TRXN${Date.now()}`,
    });

    const result = await approvePayment(admin, intent.paymentId);
    assert.ok(Math.abs(result.startsAt.getTime() - Date.now()) < 5000);
  });
});

describe('rejection', () => {
  it('records the reason and issues nothing', async () => {
    __resetMemoryLimiter();
    const student = await createUser();
    const payment = await submitFor(student.id, aliceCourse.courseId, `TRXJ${Date.now()}`);

    await rejectPayment(alice, payment.id, 'wrong_amount');

    const db = getDb();
    const row = await db.query.payments.findFirst({ where: eq(payments.id, payment.id) });
    assert.equal(row?.status, 'rejected');
    assert.equal(row?.rejectionReason, 'wrong_amount');

    const issued = await db
      .select({ id: entitlements.id })
      .from(entitlements)
      .where(eq(entitlements.paymentId, payment.id));
    assert.equal(issued.length, 0);
  });

  it('requires a note when the reason is "other"', async () => {
    __resetMemoryLimiter();
    const student = await createUser();
    const payment = await submitFor(student.id, aliceCourse.courseId, `TRXK${Date.now()}`);

    await assert.rejects(
      () => rejectPayment(alice, payment.id, 'other'),
      (err: unknown) => {
        assert.ok(err instanceof ApiError);
        assert.equal(err.status, 422);
        return true;
      },
    );
  });
});

describe('manual grant boundaries', () => {
  it('lets a teacher grant access to their own course', async () => {
    const student = await createUser();
    const result = await grantAccess(alice, {
      studentId: student.id,
      courseId: aliceCourse.courseId,
      note: 'Paid in cash at the coaching centre',
    });

    assert.equal(result.kind, 'single_course');
    const access = await checkLessonAccess(student.id, aliceCourse.paidLessonId);
    assert.deepEqual(access, { allowed: true, via: 'single_course' });
  });

  it("refuses a teacher granting access to another teacher's course", async () => {
    const student = await createUser();
    await assert.rejects(
      () => grantAccess(alice, { studentId: student.id, courseId: bobCourse.courseId }),
      (err: unknown) => {
        assert.ok(err instanceof ApiError);
        assert.equal(err.status, 404);
        return true;
      },
    );
  });

  it('refuses a teacher granting all-access', async () => {
    // The boundary that matters most: lifetime_all resolves against
    // is_in_all_access, so a teacher able to issue one would be handing out
    // every other teacher's catalog for free.
    const student = await createUser();
    await assert.rejects(
      () => grantAccess(alice, { studentId: student.id, kind: 'lifetime_all' }),
      (err: unknown) => {
        assert.ok(err instanceof ApiError);
        // Specifically 403, not a 422 about a missing course: the refusal must
        // name the real reason, or a teacher reads it as "pick a course and
        // you'll get all-access".
        assert.equal(err.status, 403);
        assert.equal(err.code, 'FORBIDDEN');
        return true;
      },
    );

    const other = await checkLessonAccess(student.id, bobCourse.paidLessonId);
    assert.equal(other.allowed, false, "no access to another teacher's course may leak");
  });

  it('lets an admin grant all-access', async () => {
    const student = await createUser();
    await grantAccess(admin, { studentId: student.id, kind: 'lifetime_all' });

    const a = await checkLessonAccess(student.id, aliceCourse.paidLessonId);
    const b = await checkLessonAccess(student.id, bobCourse.paidLessonId);
    assert.equal(a.allowed, true);
    assert.equal(b.allowed, true);
  });

  it('refuses to grant the same course twice', async () => {
    const student = await createUser();
    await grantAccess(alice, { studentId: student.id, courseId: aliceCourse.courseId });
    await assert.rejects(
      () => grantAccess(alice, { studentId: student.id, courseId: aliceCourse.courseId }),
      (err: unknown) => {
        assert.ok(err instanceof ApiError);
        assert.equal(err.status, 409);
        return true;
      },
    );
  });
});

describe('revocation', () => {
  it('removes access immediately', async () => {
    const student = await createUser();
    const granted = await grantAccess(alice, {
      studentId: student.id,
      courseId: aliceCourse.courseId,
    });

    assert.equal((await checkLessonAccess(student.id, aliceCourse.paidLessonId)).allowed, true);

    await revokeEntitlement(alice, granted.entitlementId, 'refunded');

    const after = await checkLessonAccess(student.id, aliceCourse.paidLessonId);
    assert.equal(after.allowed, false);
  });

  it('refuses a teacher revoking a plan entitlement', async () => {
    const student = await createUser();
    const granted = await grantAccess(admin, { studentId: student.id, kind: 'lifetime_all' });

    await assert.rejects(
      () => revokeEntitlement(alice, granted.entitlementId, 'nope'),
      (err: unknown) => {
        assert.ok(err instanceof ApiError);
        assert.equal(err.status, 403);
        return true;
      },
    );
  });
});
