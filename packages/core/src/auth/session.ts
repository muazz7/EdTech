import { and, eq, isNull, sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { activeSessions, getDb, type ActiveSession } from '@edtech/db';
import type { Platform, ResolvedDevice } from '@edtech/shared';
import {
  assertDeviceAllowed,
  evaluateDevicePolicy,
  lastFingerprint,
  recordDeviceSwitch,
} from './device-policy.js';
import { revokeTokensForSession } from './refresh.js';

export type EstablishSessionInput = {
  userId: string;
  /** Already resolved: web fingerprints are derived server-side (Section 6.3). */
  device: ResolvedDevice;
  ipAddress: string | null;
  userAgent: string | null;
};

export type EstablishSessionResult = {
  session: ActiveSession;
  /** The session that was kicked, if any. Caller pushes an FCM message to it
   *  so the old device logs out immediately rather than on its next request. */
  revokedSessionId: string | null;
};

/**
 * Login. Runs in one transaction (Section 6.3):
 *   1. Check the rolling device-switch budget.
 *   2. Revoke any existing live session with reason 'new_device'.
 *   3. Insert the new session.
 *   4. Log the switch.
 *
 * Steps 2 and 3 must be in the same transaction. The partial unique index
 * `one_live_session_per_user` will reject the insert otherwise — and that
 * rejection is the database correctly catching an application bug, not
 * something to work around by dropping the index.
 */
export async function establishSession(
  input: EstablishSessionInput,
): Promise<EstablishSessionResult> {
  const policy = await evaluateDevicePolicy(input.userId, input.device.fingerprint);
  assertDeviceAllowed(policy);

  const previousFingerprint = await lastFingerprint(input.userId);
  const db = getDb();

  const result = await db.transaction(async (tx) => {
    const [revoked] = await tx
      .update(activeSessions)
      .set({ revokedAt: sql`now()`, revokedReason: 'new_device' })
      .where(and(eq(activeSessions.userId, input.userId), isNull(activeSessions.revokedAt)))
      .returning({ id: activeSessions.id });

    const [session] = await tx
      .insert(activeSessions)
      .values({
        id: uuidv7(),
        userId: input.userId,
        deviceFingerprint: input.device.fingerprint,
        deviceLabel: input.device.label ?? null,
        platform: input.device.platform satisfies Platform,
        ipAddress: input.ipAddress,
        userAgent: input.userAgent,
      })
      .returning();

    if (!session) throw new Error('Session insert returned no row.');

    // Only log an actual switch. Re-authenticating on the same device is not
    // a switch and must not consume budget.
    if (!policy.isKnownDevice || previousFingerprint !== input.device.fingerprint) {
      await recordDeviceSwitch({
        id: uuidv7(),
        userId: input.userId,
        fromFingerprint: previousFingerprint,
        toFingerprint: input.device.fingerprint,
        ipAddress: input.ipAddress,
      });
    }

    return { session, revokedSessionId: revoked?.id ?? null };
  });

  // Outside the transaction: the kicked session's refresh tokens must die with
  // it, or the old device refreshes its way back in.
  if (result.revokedSessionId) {
    await revokeTokensForSession(result.revokedSessionId, 'new_device');
  }

  return result;
}

/**
 * Logout, and the admin "force-logout" action.
 *
 * Revoking the session without revoking its refresh tokens would leave a
 * 30-day credential that mints fresh access tokens for a session that is
 * supposed to be dead.
 */
export async function revokeSession(sessionId: string, reason: string): Promise<void> {
  const db = getDb();
  await db
    .update(activeSessions)
    .set({ revokedAt: sql`now()`, revokedReason: reason })
    .where(and(eq(activeSessions.id, sessionId), isNull(activeSessions.revokedAt)));
  await revokeTokensForSession(sessionId, reason);
}

export async function revokeAllSessionsForUser(userId: string, reason: string): Promise<number> {
  const db = getDb();
  const rows = await db
    .update(activeSessions)
    .set({ revokedAt: sql`now()`, revokedReason: reason })
    .where(and(eq(activeSessions.userId, userId), isNull(activeSessions.revokedAt)))
    .returning({ id: activeSessions.id });

  for (const row of rows) await revokeTokensForSession(row.id, reason);
  return rows.length;
}
