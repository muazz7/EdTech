import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { entitlements, getDb, payments, plans, profiles } from '@edtech/db';
import { ApiError, ERROR_CODES } from '@edtech/shared';
import { recordAudit } from '../audit/log.js';

/**
 * Platform plan administration (Section 8, ADR 0003).
 *
 * Plans are the Owner's alone. A `subscription` or `lifetime_all` plan grants
 * access across every teacher's catalog, so no single teacher can create one,
 * price one, or collect for one — the same reason `grantEntitlement` refuses a
 * teacher those kinds.
 */

export type AdminActor = { userId: string; role: 'admin' };

/**
 * Resolves an admin from the live database role, not from a JWT claim.
 *
 * A teacher who was briefly promoted and then demoted still holds a valid
 * 15-minute token; reading the claim would let them keep administering the
 * platform until it expired.
 */
export async function resolveAdmin(userId: string): Promise<AdminActor> {
  const db = getDb();
  const profile = await db.query.profiles.findFirst({
    where: eq(profiles.id, userId),
    columns: { role: true, isActive: true },
  });

  if (!profile) throw new ApiError(401, ERROR_CODES.UNAUTHENTICATED);
  if (!profile.isActive) throw new ApiError(403, ERROR_CODES.ACCOUNT_DEACTIVATED);
  if (profile.role !== 'admin') {
    throw new ApiError(403, ERROR_CODES.ROLE_REQUIRED, 'This area is for the platform owner.');
  }

  return { userId, role: 'admin' };
}

export async function listPlansForAdmin(_actor: AdminActor) {
  const db = getDb();

  return db
    .select({
      id: plans.id,
      kind: plans.kind,
      name: plans.name,
      description: plans.description,
      pricePoisha: plans.pricePoisha,
      durationDays: plans.durationDays,
      isActive: plans.isActive,
      displayOrder: plans.displayOrder,
      createdAt: plans.createdAt,
      /** What the plan is actually doing, so "should I retire this?" is
       *  answerable on the same screen. */
      liveSubscribers: sql<number>`(
        SELECT count(*)::int FROM entitlements e
        WHERE e.plan_id = ${plans.id}
          AND e.revoked_at IS NULL
          AND (e.expires_at IS NULL OR e.expires_at > now())
      )`,
      pendingPayments: sql<number>`(
        SELECT count(*)::int FROM payments p
        WHERE p.plan_id = ${plans.id} AND p.status = 'pending'
      )`,
    })
    .from(plans)
    .orderBy(asc(plans.displayOrder), asc(plans.createdAt));
}

export async function createPlan(
  actor: AdminActor,
  input: {
    kind: 'subscription' | 'lifetime_all';
    name: string;
    description?: string;
    pricePoisha: number;
    durationDays?: number | null;
    displayOrder?: number;
  },
) {
  assertDurationMatchesKind(input.kind, input.durationDays ?? null);

  const db = getDb();
  const [created] = await db
    .insert(plans)
    .values({
      id: uuidv7(),
      kind: input.kind,
      name: input.name,
      description: input.description ?? null,
      pricePoisha: input.pricePoisha,
      durationDays: input.kind === 'subscription' ? (input.durationDays ?? 30) : null,
      displayOrder: input.displayOrder ?? 0,
      isActive: false,
    })
    .returning();

  if (!created) throw new ApiError(500, ERROR_CODES.INTERNAL);

  await recordAudit({
    actorId: actor.userId,
    action: 'plan.create',
    entityType: 'plan',
    entityId: created.id,
    after: { name: created.name, kind: created.kind, pricePoisha: created.pricePoisha },
  });

  return created;
}

export async function updatePlan(
  actor: AdminActor,
  planId: string,
  input: {
    name?: string;
    description?: string;
    pricePoisha?: number;
    durationDays?: number | null;
    displayOrder?: number;
    isActive?: boolean;
  },
) {
  const db = getDb();
  const plan = await db.query.plans.findFirst({ where: eq(plans.id, planId) });
  if (!plan) throw new ApiError(404, ERROR_CODES.NOT_FOUND, 'Plan not found.');

  if (input.durationDays !== undefined) {
    assertDurationMatchesKind(plan.kind, input.durationDays);
  }

  const patch: Record<string, unknown> = {};
  for (const key of [
    'name',
    'description',
    'pricePoisha',
    'durationDays',
    'displayOrder',
    'isActive',
  ] as const) {
    if (input[key] !== undefined) patch[key] = input[key];
  }
  if (Object.keys(patch).length === 0) {
    throw new ApiError(422, ERROR_CODES.VALIDATION_FAILED, 'Nothing to update.');
  }

  // Activating a plan puts it in front of every student, and the price is what
  // they will be quoted. Refuse the state where that is meaningless.
  if (input.isActive === true) {
    const price = input.pricePoisha ?? plan.pricePoisha;
    if (price <= 0) {
      throw new ApiError(
        409,
        ERROR_CODES.CONFLICT,
        'Set a price above zero before making this plan available.',
      );
    }
  }

  const [updated] = await db.update(plans).set(patch).where(eq(plans.id, planId)).returning();
  if (!updated) throw new ApiError(500, ERROR_CODES.INTERNAL);

  // Price and availability are audited: a student quoted 1500 who later sees
  // 1200 will ask, and the answer has to be on the record.
  if (
    input.pricePoisha !== undefined ||
    input.isActive !== undefined ||
    input.durationDays !== undefined
  ) {
    await recordAudit({
      actorId: actor.userId,
      action: 'plan.change',
      entityType: 'plan',
      entityId: planId,
      before: {
        pricePoisha: plan.pricePoisha,
        isActive: plan.isActive,
        durationDays: plan.durationDays,
      },
      after: {
        pricePoisha: updated.pricePoisha,
        isActive: updated.isActive,
        durationDays: updated.durationDays,
      },
    });
  }

  return updated;
}

/**
 * Retiring a plan deactivates it. There is no delete.
 *
 * Entitlements and payments reference the plan, and a student who paid for
 * "Monthly All-Access" must still be able to see what they bought a year later.
 * Deactivating removes it from the catalog and leaves history intact.
 */
export async function retirePlan(actor: AdminActor, planId: string) {
  const db = getDb();
  const plan = await db.query.plans.findFirst({ where: eq(plans.id, planId) });
  if (!plan) throw new ApiError(404, ERROR_CODES.NOT_FOUND, 'Plan not found.');

  const [{ pending } = { pending: 0 }] = await db
    .select({ pending: sql<number>`count(*)::int` })
    .from(payments)
    .where(and(eq(payments.planId, planId), eq(payments.status, 'pending')));

  const [updated] = await db
    .update(plans)
    .set({ isActive: false })
    .where(eq(plans.id, planId))
    .returning();

  await recordAudit({
    actorId: actor.userId,
    action: 'plan.retire',
    entityType: 'plan',
    entityId: planId,
    before: { name: plan.name, isActive: plan.isActive },
    after: { pendingPaymentsLeftOpen: pending },
  });

  // Surfaced rather than blocked: those students already paid, and their
  // payments still need reviewing.
  return { plan: updated, pendingPaymentsLeftOpen: pending };
}

/** Live subscribers on a plan, for the retire confirmation. */
export async function countPlanSubscribers(planId: string): Promise<number> {
  const db = getDb();
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(entitlements)
    .where(
      and(
        eq(entitlements.planId, planId),
        isNull(entitlements.revokedAt),
        sql`(${entitlements.expiresAt} IS NULL OR ${entitlements.expiresAt} > now())`,
      ),
    );
  return row?.count ?? 0;
}

/**
 * `lifetime_has_no_expiry` in the schema already forbids an expiring
 * non-subscription entitlement. Caught here too so the message names the field
 * rather than surfacing a constraint violation.
 */
function assertDurationMatchesKind(kind: string, durationDays: number | null): void {
  if (kind === 'subscription') {
    if (durationDays !== null && durationDays <= 0) {
      throw new ApiError(
        422,
        ERROR_CODES.VALIDATION_FAILED,
        'A subscription needs a length in days.',
      );
    }
    return;
  }

  if (durationDays !== null) {
    throw new ApiError(
      422,
      ERROR_CODES.VALIDATION_FAILED,
      'A lifetime plan does not expire, so it cannot have a length.',
    );
  }
}
