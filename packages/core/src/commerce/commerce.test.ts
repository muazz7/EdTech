import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { and, eq, sql } from 'drizzle-orm';
import { closeDb, entitlements, getDb, payments, plans, promoCodes } from '@edtech/db';
import { ApiError } from '@edtech/shared';
import {
  createPromoCode,
  deactivatePromoCode,
  listPromoCodes,
  validatePromoCode,
} from './promo.js';
import { createPlan, resolveAdmin, retirePlan, updatePlan } from './plans.js';
import { createPaymentIntent } from '../payments/intent.js';
import { createPaymentMethod } from '../payments/methods.js';
import type { Actor } from '../content/ownership.js';
import { cleanup, createCourse, createUser } from '../testing/fixtures.js';

/**
 * Plans and promo codes (ADR 0002, ADR 0003).
 *
 * The rules worth pressure: a code cannot cross into another teacher's catalog,
 * the quantity actually holds, and a 100% code settles without asking a student
 * to prove a payment of zero.
 */

let teacher: Actor;
let teacherId: string;
let course: Awaited<ReturnType<typeof createCourse>>;
const createdPromoIds: string[] = [];
const createdPlanIds: string[] = [];

async function newPromo(overrides: Partial<Parameters<typeof createPromoCode>[1]> = {}) {
  const promo = await createPromoCode(teacher, {
    discountPercent: 50,
    maxRedemptions: 5,
    courseId: course.courseId,
    ...overrides,
  });
  createdPromoIds.push(promo.id);
  return promo;
}

before(async () => {
  const user = await createUser('teacher', 'Commerce Teacher');
  teacherId = user.id;
  teacher = { userId: user.id, role: 'teacher' };
  course = await createCourse({ teacherId: user.id, isInAllAccess: true });

  // An intent refuses to mint a reference code for a teacher with no number to
  // send money to, so the fixture needs one.
  await createPaymentMethod(teacher, {
    channel: 'bkash',
    accountNumber: '01711223344',
  });
});

after(async () => {
  const db = getDb();
  // Payments reference promo codes, and entitlements reference payments.
  for (const id of createdPromoIds) {
    const rows = await db.select({ id: payments.id }).from(payments).where(eq(payments.promoCodeId, id));
    for (const row of rows) {
      await db.delete(entitlements).where(eq(entitlements.paymentId, row.id));
    }
    await db.delete(payments).where(eq(payments.promoCodeId, id));
    await db.delete(promoCodes).where(eq(promoCodes.id, id));
  }

  for (const id of createdPlanIds) {
    await db.delete(entitlements).where(eq(entitlements.planId, id));
    await db.delete(payments).where(eq(payments.planId, id));
    await db.delete(plans).where(eq(plans.id, id));
  }

  await cleanup();
  await closeDb();
});

describe('promo codes', () => {
  it('generates an unambiguous code when none is given', async () => {
    // Read off a screenshot and typed on a phone keypad: O/0 and I/1 confusion
    // costs a rejected payment and a support message.
    const promo = await newPromo();
    assert.match(promo.code, /^[A-HJ-NP-Z2-9]{8}$/);
  });

  it('prices a discount against the course', async () => {
    const promo = await newPromo({ discountPercent: 40 });
    const student = await createUser();

    const priced = await validatePromoCode(student.id, {
      code: promo.code,
      courseId: course.courseId,
    });

    // The fixture course is 50000 poisha.
    assert.equal(priced.originalPoisha, 50_000);
    assert.equal(priced.discountPoisha, 20_000);
    assert.equal(priced.finalPoisha, 30_000);
    assert.equal(priced.isFree, false);
  });

  it('rounds the discount down, never up', async () => {
    // A 33% code on an odd price must not charge a poisha more than shown.
    const db = getDb();
    await db.execute(sql`UPDATE courses SET price_poisha = 999 WHERE id = ${course.courseId}`);

    try {
      const promo = await newPromo({ discountPercent: 33 });
      const student = await createUser();

      const priced = await validatePromoCode(student.id, {
        code: promo.code,
        courseId: course.courseId,
      });
      assert.equal(priced.discountPoisha, 329, 'floor(999 * 33 / 100)');
      assert.equal(priced.finalPoisha, 670);
    } finally {
      // In a finally: a failure here must not leave the shared fixture course
      // priced at 999 and break every test after it.
      await db.execute(sql`UPDATE courses SET price_poisha = 50000 WHERE id = ${course.courseId}`);
    }
  });

  it('refuses a code from another teacher', async () => {
    // One teacher must not be able to discount another's revenue.
    const other = await createUser('teacher', 'Other Teacher');
    const otherCourse = await createCourse({ teacherId: other.id });
    const promo = await newPromo();
    const student = await createUser();

    await assert.rejects(
      () => validatePromoCode(student.id, { code: promo.code, courseId: otherCourse.courseId }),
      (err: unknown) => {
        assert.ok(err instanceof ApiError);
        assert.equal(err.status, 422);
        return true;
      },
    );
  });

  it('gives the same answer for an unknown code as for an ineligible one', async () => {
    // Otherwise the endpoint is an oracle: type codes until the message
    // changes, and you have enumerated the live ones.
    const student = await createUser();
    const expired = await newPromo({
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    await getDb()
      .update(promoCodes)
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(eq(promoCodes.id, expired.id));

    const messages: string[] = [];
    for (const code of ['NOSUCHCODE', expired.code]) {
      try {
        await validatePromoCode(student.id, { code, courseId: course.courseId });
        assert.fail(`${code} should not validate`);
      } catch (err) {
        assert.ok(err instanceof ApiError);
        messages.push(err.message);
      }
    }

    assert.equal(messages[0], messages[1], 'the refusals must be indistinguishable');
  });

  it('refuses a code that is switched off', async () => {
    const promo = await newPromo();
    await deactivatePromoCode(teacher, promo.id);
    const student = await createUser();

    await assert.rejects(() =>
      validatePromoCode(student.id, { code: promo.code, courseId: course.courseId }),
    );
  });

  it('keeps one teacher out of another teacher\'s codes', async () => {
    const promo = await newPromo();
    const otherUser = await createUser('teacher', 'Nosy Teacher');
    const outsider: Actor = { userId: otherUser.id, role: 'teacher' };

    await assert.rejects(
      () => deactivatePromoCode(outsider, promo.id),
      (err: unknown) => {
        assert.ok(err instanceof ApiError);
        assert.equal(err.status, 404);
        return true;
      },
    );

    const theirs = await listPromoCodes(outsider);
    assert.equal(theirs.some((row) => row.id === promo.id), false);
  });
});

describe('redemption', () => {
  it('applies the discount to the payment intent', async () => {
    const promo = await newPromo({ discountPercent: 20 });
    const student = await createUser();

    const intent = await createPaymentIntent(student.id, {
      courseId: course.courseId,
      promoCode: promo.code,
    });

    assert.equal(intent.originalPoisha, 50_000);
    assert.equal(intent.discountPoisha, 10_000);
    assert.equal(intent.amountPoisha, 40_000);
    assert.equal(intent.settled, false, 'there is still money to transfer');
  });

  it('grants access immediately when the code covers everything', async () => {
    // Nothing to pay and nothing to prove, so asking for a screenshot of a
    // zero-taka transfer would be theatre.
    const promo = await newPromo({ discountPercent: 100 });
    const student = await createUser();

    const intent = await createPaymentIntent(student.id, {
      courseId: course.courseId,
      promoCode: promo.code,
    });

    assert.equal(intent.amountPoisha, 0);
    assert.equal(intent.settled, true);

    const db = getDb();
    const granted = await db.query.entitlements.findFirst({
      where: and(
        eq(entitlements.studentId, student.id),
        eq(entitlements.courseId, course.courseId),
      ),
    });
    assert.ok(granted, 'the entitlement should exist');
    assert.equal(granted.source, 'promo');

    const payment = await db.query.payments.findFirst({
      where: eq(payments.id, intent.paymentId),
    });
    assert.equal(payment?.status, 'verified');
  });

  it('enforces the quantity the teacher set', async () => {
    const promo = await newPromo({ maxRedemptions: 2, discountPercent: 10 });

    for (let i = 0; i < 2; i++) {
      const student = await createUser();
      await createPaymentIntent(student.id, {
        courseId: course.courseId,
        promoCode: promo.code,
      });
    }

    const third = await createUser();
    await assert.rejects(
      () =>
        createPaymentIntent(third.id, { courseId: course.courseId, promoCode: promo.code }),
      (err: unknown) => {
        assert.ok(err instanceof ApiError);
        return true;
      },
    );
  });

  it('counts a pending payment against the quantity', async () => {
    // A "first 20 students" promo must not be oversold while proofs are being
    // checked.
    const promo = await newPromo({ maxRedemptions: 1, discountPercent: 10 });
    const first = await createUser();
    await createPaymentIntent(first.id, { courseId: course.courseId, promoCode: promo.code });

    const second = await createUser();
    await assert.rejects(() =>
      createPaymentIntent(second.id, { courseId: course.courseId, promoCode: promo.code }),
    );
  });

  it('refuses the same student twice', async () => {
    const promo = await newPromo({ maxRedemptions: 10, discountPercent: 10 });
    const student = await createUser();

    await createPaymentIntent(student.id, { courseId: course.courseId, promoCode: promo.code });

    await assert.rejects(
      () => validatePromoCode(student.id, { code: promo.code, courseId: course.courseId }),
      (err: unknown) => {
        assert.ok(err instanceof ApiError);
        assert.equal(err.status, 409);
        return true;
      },
    );
  });

  it('refuses a promo code on a platform-wide plan', async () => {
    // A teacher discounting a plan would be discounting every other teacher's
    // catalog.
    const promo = await newPromo();
    const student = await createUser();

    await assert.rejects(
      () =>
        createPaymentIntent(student.id, {
          planId: '00000000-0000-0000-0000-000000000000',
          promoCode: promo.code,
        }),
      (err: unknown) => {
        assert.ok(err instanceof ApiError);
        assert.equal(err.status, 422);
        return true;
      },
    );
  });
});

describe('plans', () => {
  it('refuses a teacher the owner console', async () => {
    await assert.rejects(
      () => resolveAdmin(teacherId),
      (err: unknown) => {
        assert.ok(err instanceof ApiError);
        assert.equal(err.status, 403);
        return true;
      },
    );
  });

  it('creates a plan switched off', async () => {
    // A plan goes in front of every student the moment it is active, so it is
    // never born that way.
    const owner = await createUser('admin', 'Platform Owner');
    const actor = await resolveAdmin(owner.id);

    const plan = await createPlan(actor, {
      kind: 'subscription',
      name: 'Monthly All-Access',
      pricePoisha: 50_000,
      durationDays: 30,
      displayOrder: 0,
    });
    createdPlanIds.push(plan.id);

    assert.equal(plan.isActive, false);
    assert.equal(plan.durationDays, 30);
  });

  it('refuses a length on a lifetime plan', async () => {
    const owner = await createUser('admin', 'Platform Owner');
    const actor = await resolveAdmin(owner.id);

    await assert.rejects(
      () =>
        createPlan(actor, {
          kind: 'lifetime_all',
          name: 'Lifetime',
          pricePoisha: 500_000,
          durationDays: 365,
          displayOrder: 0,
        }),
      (err: unknown) => {
        assert.ok(err instanceof ApiError);
        assert.equal(err.status, 422);
        return true;
      },
    );
  });

  it('refuses to publish a plan priced at zero', async () => {
    const owner = await createUser('admin', 'Platform Owner');
    const actor = await resolveAdmin(owner.id);

    const plan = await createPlan(actor, {
      kind: 'lifetime_all',
      name: 'Free forever',
      pricePoisha: 0,
      displayOrder: 0,
    });
    createdPlanIds.push(plan.id);

    await assert.rejects(
      () => updatePlan(actor, plan.id, { isActive: true }),
      (err: unknown) => {
        assert.ok(err instanceof ApiError);
        assert.equal(err.status, 409);
        return true;
      },
    );
  });

  it('retires rather than deletes', async () => {
    // A student who bought this must still be able to see what they paid for.
    const owner = await createUser('admin', 'Platform Owner');
    const actor = await resolveAdmin(owner.id);

    const plan = await createPlan(actor, {
      kind: 'subscription',
      name: 'Retiring plan',
      pricePoisha: 20_000,
      durationDays: 30,
      displayOrder: 0,
    });
    createdPlanIds.push(plan.id);

    await updatePlan(actor, plan.id, { isActive: true });
    const retired = await retirePlan(actor, plan.id);

    assert.equal(retired.plan?.isActive, false);

    const stillThere = await getDb().query.plans.findFirst({ where: eq(plans.id, plan.id) });
    assert.ok(stillThere, 'the row must survive so history stays readable');
  });
});
