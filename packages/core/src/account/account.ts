import { and, desc, eq, gte, isNull } from 'drizzle-orm';
import { activeSessions, deviceSwitchLog, getDb } from '@edtech/db';
import { DEVICE_SWITCH_WINDOW_DAYS, MAX_DEVICE_SWITCHES_PER_30D } from '@edtech/shared';

/**
 * Account screen data (Section 2.3, Section 6.3).
 *
 * The device budget is the part students actually need to see. Discovering the
 * limit by being locked out on the morning of an exam is the worst possible
 * time to learn it exists, and every one of those turns into a support message.
 * Showing "3 of 4 devices used this month" turns a block into something the
 * student saw coming.
 *
 * Fingerprints are NEVER returned. They are internal hashes: useless to the
 * student, and handing one back tells anyone probing the account exactly what
 * value to replay.
 */

export type AccountSecurity = {
  session: {
    deviceLabel: string | null;
    platform: string;
    createdAt: Date;
    lastActiveAt: Date;
    /** True when this is the session making the request. Currently always true
     *  — Section 6.3 permits exactly one live session — but stated explicitly
     *  so the screen does not have to assume it. */
    isCurrent: boolean;
  } | null;
  devices: {
    used: number;
    limit: number;
    remaining: number;
    windowDays: number;
    /** Dates only. The switch log holds IP addresses, which are not something
     *  to render back into a page. */
    recent: Date[];
  };
};

function deviceLimit(): number {
  const raw = Number(process.env.MAX_DEVICE_SWITCHES_PER_30D);
  return Number.isFinite(raw) && raw > 0 ? raw : MAX_DEVICE_SWITCHES_PER_30D;
}

export async function getAccountSecurity(
  userId: string,
  currentSessionId: string,
): Promise<AccountSecurity> {
  const db = getDb();
  const windowStart = new Date(Date.now() - DEVICE_SWITCH_WINDOW_DAYS * 24 * 60 * 60 * 1000);

  const [live, switches] = await Promise.all([
    db
      .select({
        id: activeSessions.id,
        deviceLabel: activeSessions.deviceLabel,
        platform: activeSessions.platform,
        createdAt: activeSessions.createdAt,
        lastActiveAt: activeSessions.lastActiveAt,
      })
      .from(activeSessions)
      .where(and(eq(activeSessions.userId, userId), isNull(activeSessions.revokedAt)))
      .limit(1),
    db
      .select({
        to: deviceSwitchLog.toFingerprint,
        createdAt: deviceSwitchLog.createdAt,
      })
      .from(deviceSwitchLog)
      .where(and(eq(deviceSwitchLog.userId, userId), gte(deviceSwitchLog.createdAt, windowStart)))
      .orderBy(desc(deviceSwitchLog.createdAt)),
  ]);

  // Distinct fingerprints, matching evaluateDevicePolicy exactly. Counting rows
  // instead would show a student a number they cannot reconcile with the block
  // they hit — switching back to a known device is free and must not count.
  const used = new Set(switches.map((row) => row.to)).size;
  const limit = deviceLimit();

  const session = live[0];

  return {
    session: session
      ? {
          deviceLabel: session.deviceLabel,
          platform: session.platform,
          createdAt: session.createdAt,
          lastActiveAt: session.lastActiveAt,
          isCurrent: session.id === currentSessionId,
        }
      : null,
    devices: {
      used,
      limit,
      remaining: Math.max(0, limit - used),
      windowDays: DEVICE_SWITCH_WINDOW_DAYS,
      recent: switches.slice(0, 10).map((row) => row.createdAt),
    },
  };
}
