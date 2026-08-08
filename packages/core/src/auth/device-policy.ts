import { and, desc, eq, gte } from 'drizzle-orm';
import { deviceSwitchLog, getDb } from '@edtech/db';
import {
  ApiError,
  DEVICE_SWITCH_WINDOW_DAYS,
  ERROR_CODES,
  MAX_DEVICE_SWITCHES_PER_30D,
} from '@edtech/shared';

export type DevicePolicyResult = {
  allowed: boolean;
  distinctDevices: number;
  limit: number;
  /** True when this fingerprint has been seen before in the window — switching
   *  back to an already-known device is always free. */
  isKnownDevice: boolean;
};

function windowStart(): Date {
  return new Date(Date.now() - DEVICE_SWITCH_WINDOW_DAYS * 24 * 60 * 60 * 1000);
}

function limit(): number {
  const raw = Number(process.env.MAX_DEVICE_SWITCHES_PER_30D);
  return Number.isFinite(raw) && raw > 0 ? raw : MAX_DEVICE_SWITCHES_PER_30D;
}

/**
 * Rolling device-switch budget (Section 6.3).
 *
 * Last-login-wins alone does not stop credential sharing — two students
 * sharing one account simply take turns, and both still get the whole course.
 * The countermeasure is switching *friction*, not another session check.
 *
 * A legitimate student has a phone, a laptop, maybe a college computer, and
 * hits this roughly never. Sharers hit it constantly.
 */
export async function evaluateDevicePolicy(
  userId: string,
  fingerprint: string,
): Promise<DevicePolicyResult> {
  const db = getDb();
  const max = limit();

  const rows = await db
    .select({ to: deviceSwitchLog.toFingerprint })
    .from(deviceSwitchLog)
    .where(and(eq(deviceSwitchLog.userId, userId), gte(deviceSwitchLog.createdAt, windowStart())));

  const seen = new Set(rows.map((r) => r.to));
  const isKnownDevice = seen.has(fingerprint);

  return {
    // A known device is always allowed. A new one is allowed only while the
    // distinct count is still under the cap.
    allowed: isKnownDevice || seen.size < max,
    distinctDevices: seen.size,
    limit: max,
    isKnownDevice,
  };
}

/** Throws the user-facing block. Admin unblocks manually after asking a
 *  question — deliberately a human step, because a false positive here costs a
 *  paying student. */
export function assertDeviceAllowed(result: DevicePolicyResult): void {
  if (result.allowed) return;
  throw new ApiError(403, ERROR_CODES.DEVICE_LIMIT_REACHED);
}

export async function recordDeviceSwitch(params: {
  id: string;
  userId: string;
  fromFingerprint: string | null;
  toFingerprint: string;
  ipAddress: string | null;
}): Promise<void> {
  const db = getDb();
  await db.insert(deviceSwitchLog).values({
    id: params.id,
    userId: params.userId,
    fromFingerprint: params.fromFingerprint,
    toFingerprint: params.toFingerprint,
    ipAddress: params.ipAddress,
  });
}

/** Most recent fingerprint for this user, used as `from` on the next switch. */
export async function lastFingerprint(userId: string): Promise<string | null> {
  const db = getDb();
  const [row] = await db
    .select({ to: deviceSwitchLog.toFingerprint })
    .from(deviceSwitchLog)
    .where(eq(deviceSwitchLog.userId, userId))
    .orderBy(desc(deviceSwitchLog.createdAt))
    .limit(1);
  return row?.to ?? null;
}
