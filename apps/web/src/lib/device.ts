import { createHash, randomUUID } from 'node:crypto';
import { cookies } from 'next/headers';
import type { DeviceInput, ResolvedDevice } from '@edtech/shared';

const COOKIE = 'device_fp';
/** Outlives the 30-day refresh token, so a returning student is recognised as
 *  the same device rather than spending device-switch budget (Section 6.3). */
const COOKIE_MAX_AGE = 400 * 24 * 60 * 60;

/**
 * Resolves the device fingerprint server-side for web clients.
 *
 * Section 6.3 specifies a random ID in an httpOnly cookie plus a UA hash. Both
 * halves matter: the cookie alone is clearable, and the UA alone is shared by
 * thousands of identical phones. Together they are coarse enough to avoid
 * punishing real students and stable enough that a sharer burns budget.
 *
 * Mobile passes its own stable install ID straight through.
 */
export async function resolveDevice(
  device: DeviceInput,
  userAgent: string | null,
): Promise<{ resolved: ResolvedDevice; setCookie?: { value: string; maxAge: number } }> {
  if (device.platform !== 'web') {
    // Schema guarantees a fingerprint on mobile.
    return { resolved: { ...device, fingerprint: device.fingerprint! } };
  }

  const jar = await cookies();
  const existing = jar.get(COOKIE)?.value;
  const seed = existing ?? randomUUID();

  const fingerprint = createHash('sha256')
    .update(`${seed}|${userAgent ?? 'unknown'}`)
    .digest('hex')
    .slice(0, 32);

  return {
    resolved: {
      fingerprint,
      label: device.label ?? browserLabel(userAgent),
      platform: 'web',
    },
    ...(existing ? {} : { setCookie: { value: seed, maxAge: COOKIE_MAX_AGE } }),
  };
}

export const DEVICE_COOKIE = COOKIE;

/**
 * Human-readable label for the account's device list, so a student recognises
 * which session they are ending. Coarse on purpose — this is a display string,
 * never an identity signal.
 */
function browserLabel(userAgent: string | null): string {
  if (!userAgent) return 'Unknown browser';

  const browser = /Edg\//.test(userAgent)
    ? 'Edge'
    : /OPR\//.test(userAgent)
      ? 'Opera'
      : /Firefox\//.test(userAgent)
        ? 'Firefox'
        : /Chrome\//.test(userAgent)
          ? 'Chrome'
          : /Safari\//.test(userAgent)
            ? 'Safari'
            : 'Browser';

  const os = /Windows/.test(userAgent)
    ? 'Windows'
    : /Android/.test(userAgent)
      ? 'Android'
      : /iPhone|iPad/.test(userAgent)
        ? 'iOS'
        : /Mac OS X/.test(userAgent)
          ? 'macOS'
          : /Linux/.test(userAgent)
            ? 'Linux'
            : 'device';

  return `${browser} on ${os}`;
}
