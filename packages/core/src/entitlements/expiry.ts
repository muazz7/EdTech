import { and, eq, gt, isNotNull, isNull, lte, ne, sql } from 'drizzle-orm';
import { entitlements, getDb, plans, profiles } from '@edtech/db';
import { PAYMENT_GRACE_PERIOD_DAYS } from '@edtech/shared';
import { notify } from '../notifications/notify.js';

/**
 * Expiry reminders and the grace period (Section 8.3).
 *
 * There is no auto-charge in this model, so every renewal is a fresh manual
 * cycle: the student has to be told, in advance, that they need to act. A
 * subscription that lapses silently is a churned student who thinks the product
 * broke.
 *
 * The grace period itself lives in checkLessonAccess — access continues for
 * three days past expiry. This module is only the telling.
 *
 * SMS is where Section 8.3 asks for it (T−3 and T−1) but is NOT wired here: SMS
 * costs real money per message in Bangladesh and there is no provider
 * configured. The in-app and push notifications go out regardless, so the
 * student is never uninformed — they simply do not get a text yet. Wiring SMS
 * is a matter of adding a sender to `notify`, not of changing this schedule.
 */

/**
 * Days before expiry at which to warn, then the lapse notice and the winback.
 *
 * Recorded on the entitlement as `reminder_stage`, so the daily sweep is
 * idempotent: running it twice in a day, or catching up after an outage, does
 * not send the same message again.
 */
const STAGES = [
  { stage: 7, offsetDays: 7 },
  { stage: 3, offsetDays: 3 },
  { stage: 1, offsetDays: 1 },
  { stage: 0, offsetDays: 0 },
  { stage: -30, offsetDays: -30 },
] as const;

function messageFor(
  stage: number,
  planName: string,
  expiresAt: Date,
): { title: string; body: string; link: string } {
  const when = expiresAt.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
  });

  if (stage > 0) {
    return {
      title: `Your access ends in ${stage} day${stage === 1 ? '' : 's'}`,
      // The date, not just the countdown: a student reading this three days
      // later needs to know whether it has already happened.
      body: `${planName} runs out on ${when}. Renew before then to keep going — your progress and certificates are kept either way.`,
      link: '/plans',
    };
  }

  if (stage === 0) {
    return {
      title: 'Your access has ended',
      body: `${planName} ran out on ${when}. You have ${PAYMENT_GRACE_PERIOD_DAYS} days of grace — courses still open until then.`,
      link: '/plans',
    };
  }

  return {
    title: 'Come back and finish your course',
    body: `Your access ended a month ago. Your progress is exactly where you left it.`,
    link: '/plans',
  };
}

/**
 * Sends whichever reminder is due for each expiring entitlement.
 *
 * Runs daily. Picks the MOST URGENT unsent stage for each entitlement rather
 * than iterating stages independently, so a student whose sweep was missed for
 * a week gets "your access has ended", not a backlog of four messages.
 */
export async function sweepExpiryReminders(params: { limit?: number } = {}) {
  const db = getDb();
  const now = new Date();

  const candidates = await db
    .select({
      id: entitlements.id,
      studentId: entitlements.studentId,
      expiresAt: entitlements.expiresAt,
      reminderStage: entitlements.reminderStage,
      planName: plans.name,
    })
    .from(entitlements)
    .leftJoin(plans, eq(plans.id, entitlements.planId))
    .where(
      and(
        isNull(entitlements.revokedAt),
        isNotNull(entitlements.expiresAt),
        // Anything from 7 days out to 31 days past. Outside that window there
        // is nothing left to say.
        gt(entitlements.expiresAt, sql`now() - interval '31 days'`),
        lte(entitlements.expiresAt, sql`now() + interval '7 days'`),
      ),
    )
    .limit(params.limit ?? 500);

  let sent = 0;

  for (const row of candidates) {
    if (!row.expiresAt) continue;

    const daysLeft = Math.floor(
      (row.expiresAt.getTime() - now.getTime()) / (24 * 60 * 60 * 1000),
    );

    // The most urgent stage this entitlement has reached. STAGES runs from
    // least to most urgent, so the last match wins.
    const due = STAGES.filter((s) => daysLeft <= s.offsetDays).at(-1);
    if (!due) continue;

    // Already told them this, or something more urgent. `reminder_stage`
    // decreases as urgency increases, so a smaller stored value means later.
    if (row.reminderStage !== null && row.reminderStage <= due.stage) continue;

    const message = messageFor(due.stage, row.planName ?? 'Your access', row.expiresAt);

    try {
      await notify({
        userId: row.studentId,
        type: due.stage > 0 ? 'access_expiring' : due.stage === 0 ? 'access_ended' : 'winback',
        title: message.title,
        body: message.body,
        link: message.link,
      });

      // Written after the send, so a failure retries tomorrow rather than
      // silently marking a message the student never got.
      await db
        .update(entitlements)
        .set({ reminderStage: due.stage })
        .where(eq(entitlements.id, row.id));

      sent++;
    } catch (err) {
      console.error(`[expiry] reminder failed for entitlement ${row.id}:`, err);
    }
  }

  return { considered: candidates.length, sent };
}

/**
 * Everything the student needs to see about their own expiry, for the banner.
 *
 * Returns the soonest deadline, whether it has already passed, and when grace
 * runs out — one call rather than making every screen work it out from a list
 * of entitlements.
 */
export async function getExpiryStatus(userId: string) {
  const db = getDb();

  const rows = await db
    .select({
      id: entitlements.id,
      kind: entitlements.kind,
      expiresAt: entitlements.expiresAt,
      planName: plans.name,
      // Counted by POSTGRES against its own clock. The application's clock runs
      // behind the database's often enough that a JavaScript subtraction here
      // rounds "5 days left" up to 6 — the same skew that made a freshly
      // created promo code look not-yet-started.
      daysLeft: sql<number>`ceil(extract(epoch from (${entitlements.expiresAt} - now())) / 86400)::int`,
      graceDaysLeft: sql<number>`greatest(0, ceil(extract(epoch from (
        ${entitlements.expiresAt} + interval '${sql.raw(String(PAYMENT_GRACE_PERIOD_DAYS))} days' - now()
      )) / 86400))::int`,
      expired: sql<boolean>`${entitlements.expiresAt} <= now()`,
    })
    .from(entitlements)
    .leftJoin(plans, eq(plans.id, entitlements.planId))
    .where(
      and(
        eq(entitlements.studentId, userId),
        isNull(entitlements.revokedAt),
        isNotNull(entitlements.expiresAt),
        ne(entitlements.kind, 'single_course'),
      ),
    );

  if (rows.length === 0) return null;

  // The one that matters is the LATEST deadline: a student holding two
  // subscriptions keeps access until the last one goes.
  const latest = rows
    .filter((row) => row.expiresAt)
    .sort((a, b) => (b.expiresAt as Date).getTime() - (a.expiresAt as Date).getTime())[0];

  if (!latest?.expiresAt) return null;

  const graceEndsAt = new Date(
    latest.expiresAt.getTime() + PAYMENT_GRACE_PERIOD_DAYS * 24 * 60 * 60 * 1000,
  );

  return {
    planName: latest.planName ?? 'Your access',
    expiresAt: latest.expiresAt,
    graceEndsAt,
    expired: latest.expired,
    /** Still usable: either not expired, or inside the grace window. */
    stillOpen: !latest.expired || latest.graceDaysLeft > 0,
    daysLeft: latest.daysLeft,
    graceDaysLeft: latest.expired ? latest.graceDaysLeft : null,
  };
}

/** Kept for the profile screen: how many students are lapsing this week. */
export async function countExpiringSoon(): Promise<number> {
  const db = getDb();
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(entitlements)
    .innerJoin(profiles, eq(profiles.id, entitlements.studentId))
    .where(
      and(
        isNull(entitlements.revokedAt),
        isNotNull(entitlements.expiresAt),
        gt(entitlements.expiresAt, sql`now()`),
        lte(entitlements.expiresAt, sql`now() + interval '7 days'`),
      ),
    );
  return row?.count ?? 0;
}
