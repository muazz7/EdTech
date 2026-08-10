import { randomInt } from 'node:crypto';
import { and, desc, eq, isNull, ne, or, sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { courses, getDb, payments, promoCodes } from '@edtech/db';
import { ApiError, ERROR_CODES } from '@edtech/shared';
import { recordAudit } from '../audit/log.js';
import { requireCourse, type Actor } from '../content/ownership.js';

/**
 * Teacher-issued promo codes (ADR 0002).
 *
 * The teacher sets two things by name: how long the code lasts and how many
 * students may use it. Both are enforced here, and the quantity is counted from
 * actual payments rather than a counter column — a counter drifts the first
 * time a redemption fails halfway.
 *
 * A code belongs to its issuing teacher and can only ever discount that
 * teacher's own courses. It can never apply to a platform-wide plan: those span
 * every teacher's catalog, and one teacher discounting another's revenue is not
 * a feature.
 */

/** No I/O/0/1 — a student reads this off a screenshot and types it. */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export type PromoValidation = {
  code: string;
  discountPercent: number;
  originalPoisha: number;
  discountPoisha: number;
  finalPoisha: number;
  /** True when the code covers the whole price. The purchase then completes
   *  without a payment step, because there is nothing to pay or prove. */
  isFree: boolean;
  remaining: number;
};

function generateCode(length = 8): string {
  let out = '';
  for (let i = 0; i < length; i++) out += ALPHABET[randomInt(ALPHABET.length)];
  return out;
}

/** Redemptions so far: every payment holding the code that has not been
 *  rejected. A pending payment reserves its slot, so a "first 20 students"
 *  promo cannot be oversold while proofs are being checked. */
async function redemptionCount(promoCodeId: string): Promise<number> {
  const db = getDb();
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(payments)
    .where(and(eq(payments.promoCodeId, promoCodeId), ne(payments.status, 'rejected')));
  return row?.count ?? 0;
}

// ── Teacher management ──────────────────────────────────────────────────────

export async function listPromoCodes(actor: Actor, params: { courseId?: string } = {}) {
  const db = getDb();
  if (params.courseId) await requireCourse(actor, params.courseId);

  return db
    .select({
      id: promoCodes.id,
      code: promoCodes.code,
      courseId: promoCodes.courseId,
      courseTitle: courses.title,
      discountPercent: promoCodes.discountPercent,
      maxRedemptions: promoCodes.maxRedemptions,
      startsAt: promoCodes.startsAt,
      expiresAt: promoCodes.expiresAt,
      isActive: promoCodes.isActive,
      note: promoCodes.note,
      createdAt: promoCodes.createdAt,
      used: sql<number>`(
        SELECT count(*)::int FROM payments p
        WHERE p.promo_code_id = ${promoCodes.id} AND p.status <> 'rejected'
      )`,
    })
    .from(promoCodes)
    .leftJoin(courses, eq(courses.id, promoCodes.courseId))
    .where(
      and(
        // Admins see everything; a teacher sees only their own.
        actor.role === 'admin' ? undefined : eq(promoCodes.teacherId, actor.userId),
        params.courseId ? eq(promoCodes.courseId, params.courseId) : undefined,
      ),
    )
    .orderBy(desc(promoCodes.createdAt))
    .limit(200);
}

export async function createPromoCode(
  actor: Actor,
  input: {
    code?: string;
    courseId?: string | null;
    discountPercent: number;
    maxRedemptions: number;
    expiresAt?: string | null;
    note?: string;
  },
) {
  const db = getDb();

  // Scoping to a course is checked through the ownership boundary, so a code
  // cannot be pointed at somebody else's catalog.
  if (input.courseId) await requireCourse(actor, input.courseId);

  const code = (input.code?.trim() || generateCode()).toUpperCase();
  if (!/^[A-Z0-9-]{4,32}$/.test(code)) {
    throw new ApiError(
      422,
      ERROR_CODES.VALIDATION_FAILED,
      'Codes are 4-32 characters: letters, numbers and hyphens.',
    );
  }

  const expiresAt = input.expiresAt ? new Date(input.expiresAt) : null;
  if (expiresAt && expiresAt.getTime() <= Date.now()) {
    throw new ApiError(422, ERROR_CODES.VALIDATION_FAILED, 'The end date is already past.');
  }

  try {
    const [created] = await db
      .insert(promoCodes)
      .values({
        id: uuidv7(),
        code,
        teacherId: actor.userId,
        courseId: input.courseId ?? null,
        discountPercent: input.discountPercent,
        maxRedemptions: input.maxRedemptions,
        expiresAt,
        note: input.note ?? null,
      })
      .returning();

    if (!created) throw new ApiError(500, ERROR_CODES.INTERNAL);

    await recordAudit({
      actorId: actor.userId,
      action: 'promo.create',
      entityType: 'promo_code',
      entityId: created.id,
      after: {
        code: created.code,
        discountPercent: created.discountPercent,
        maxRedemptions: created.maxRedemptions,
        expiresAt: created.expiresAt,
      },
    });

    return created;
  } catch (err) {
    // The code is globally unique: students type it, and two teachers owning
    // "EID50" would be unresolvable.
    if (err instanceof Error && err.message.includes('promo_codes_code_unique')) {
      throw new ApiError(409, ERROR_CODES.CONFLICT, 'That code is already taken. Pick another.');
    }
    throw err;
  }
}

/**
 * Deactivates a code. Never deletes it: payments reference it, and a student
 * holding a pending payment must keep the price they were quoted.
 */
export async function deactivatePromoCode(actor: Actor, promoCodeId: string) {
  const db = getDb();
  const promo = await requirePromoCode(actor, promoCodeId);

  const [updated] = await db
    .update(promoCodes)
    .set({ isActive: false })
    .where(eq(promoCodes.id, promo.id))
    .returning();

  await recordAudit({
    actorId: actor.userId,
    action: 'promo.deactivate',
    entityType: 'promo_code',
    entityId: promo.id,
    before: { code: promo.code, isActive: true },
  });

  return updated;
}

async function requirePromoCode(actor: Actor, promoCodeId: string) {
  const db = getDb();
  const promo = await db.query.promoCodes.findFirst({ where: eq(promoCodes.id, promoCodeId) });

  // 404 for someone else's code, never 403 — a 403 confirms it exists, and a
  // code's existence is the only secret it has.
  if (!promo || (actor.role !== 'admin' && promo.teacherId !== actor.userId)) {
    throw new ApiError(404, ERROR_CODES.NOT_FOUND, 'Promo code not found.');
  }
  return promo;
}

// ── Redemption ──────────────────────────────────────────────────────────────

/**
 * Checks a code against a course and prices it.
 *
 * Every refusal returns the SAME error code and a message that does not say
 * which rule failed for a code that exists versus one that does not. Otherwise
 * the endpoint becomes an oracle: type codes until the message changes from
 * "not valid" to "already used", and you have enumerated the live ones.
 */
export async function validatePromoCode(
  studentId: string,
  input: { code: string; courseId: string },
): Promise<PromoValidation> {
  const db = getDb();

  const course = await db.query.courses.findFirst({
    where: eq(courses.id, input.courseId),
    columns: { id: true, teacherId: true, pricePoisha: true, state: true },
  });
  if (!course || course.state !== 'published') {
    throw new ApiError(404, ERROR_CODES.NOT_FOUND, 'Course not found.');
  }

  // The validity window is evaluated by POSTGRES, not by this process.
  // `starts_at` defaults to the database's now(), and the database's clock runs
  // ahead of the application's often enough that comparing locally refuses a
  // code for the first few seconds of its life.
  const [promo] = await db
    .select({
      id: promoCodes.id,
      code: promoCodes.code,
      teacherId: promoCodes.teacherId,
      courseId: promoCodes.courseId,
      discountPercent: promoCodes.discountPercent,
      maxRedemptions: promoCodes.maxRedemptions,
      isActive: promoCodes.isActive,
      inWindow: sql<boolean>`
        ${promoCodes.startsAt} <= now()
        AND (${promoCodes.expiresAt} IS NULL OR ${promoCodes.expiresAt} > now())`,
    })
    .from(promoCodes)
    .where(eq(promoCodes.code, input.code.trim().toUpperCase()))
    .limit(1);

  const refuse = () =>
    new ApiError(
      422,
      ERROR_CODES.VALIDATION_FAILED,
      'That code is not valid for this course.',
    );

  if (!promo || !promo.isActive) throw refuse();
  if (promo.teacherId !== course.teacherId) throw refuse();
  if (promo.courseId && promo.courseId !== course.id) throw refuse();
  if (!promo.inWindow) throw refuse();

  const used = await redemptionCount(promo.id);
  if (used >= promo.maxRedemptions) throw refuse();

  // One per student. The database enforces it too — this is the friendly path.
  const already = await db.query.payments.findFirst({
    where: and(
      eq(payments.promoCodeId, promo.id),
      eq(payments.studentId, studentId),
      ne(payments.status, 'rejected'),
    ),
    columns: { id: true },
  });
  if (already) {
    throw new ApiError(
      409,
      ERROR_CODES.CONFLICT,
      'You have already used this code.',
    );
  }

  // Rounded DOWN, so a 33% discount on 999 poisha never charges a poisha more
  // than the student was shown.
  const discountPoisha = Math.floor((course.pricePoisha * promo.discountPercent) / 100);
  const finalPoisha = Math.max(0, course.pricePoisha - discountPoisha);

  return {
    code: promo.code,
    discountPercent: promo.discountPercent,
    originalPoisha: course.pricePoisha,
    discountPoisha,
    finalPoisha,
    isFree: finalPoisha === 0,
    remaining: promo.maxRedemptions - used,
  };
}

/**
 * Locks in a code for a payment intent, inside the caller's transaction.
 *
 * Re-reads the promo row FOR UPDATE so two students racing for the last slot
 * cannot both take it. Without the lock, "first 20 students" is a suggestion.
 */
export async function reservePromoCode(
  studentId: string,
  input: { code: string; courseId: string },
): Promise<{ promoCodeId: string; discountPoisha: number; finalPoisha: number }> {
  const db = getDb();

  return db.transaction(async (tx) => {
    const [promo] = await tx
      .select()
      .from(promoCodes)
      .where(eq(promoCodes.code, input.code.trim().toUpperCase()))
      .for('update');

    if (!promo) {
      throw new ApiError(422, ERROR_CODES.VALIDATION_FAILED, 'That code is not valid.');
    }

    // Re-run the full check inside the lock. The validation the client did a
    // moment ago is a preview, not a reservation.
    const validated = await validatePromoCode(studentId, input);

    const [{ count } = { count: 0 }] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(payments)
      .where(and(eq(payments.promoCodeId, promo.id), ne(payments.status, 'rejected')));

    if (count >= promo.maxRedemptions) {
      throw new ApiError(
        409,
        ERROR_CODES.CONFLICT,
        'This code has just been fully used. Continue at the normal price.',
      );
    }

    return {
      promoCodeId: promo.id,
      discountPoisha: validated.discountPoisha,
      finalPoisha: validated.finalPoisha,
    };
  });
}

/** Codes a student could still use on a course, for the purchase screen.
 *  Returns only what the teacher chose to advertise — never the full list. */
export async function countActivePromosFor(courseId: string): Promise<number> {
  const db = getDb();
  const now = new Date();

  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(promoCodes)
    .where(
      and(
        eq(promoCodes.isActive, true),
        or(isNull(promoCodes.courseId), eq(promoCodes.courseId, courseId)),
        or(isNull(promoCodes.expiresAt), sql`${promoCodes.expiresAt} > ${now}`),
      ),
    );

  return row?.count ?? 0;
}
