import { SignJWT, importPKCS8 } from 'jose';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { deviceTokens, getDb } from '@edtech/db';

/**
 * Firebase Cloud Messaging, HTTP v1.
 *
 * The legacy server-key endpoint is dead; v1 needs an OAuth2 access token
 * minted from the service account. That is a signed JWT assertion exchanged at
 * Google's token endpoint — done here with jose rather than pulling in
 * google-auth-library for one call.
 *
 * Absent FCM_SERVICE_ACCOUNT_JSON this degrades to a no-op that logs. Push is
 * a latency optimisation, never a security control: Section 6.3's guarantee is
 * that the revoked device fails on its NEXT request. The push only makes that
 * happen immediately instead of whenever the user next taps something.
 */

type ServiceAccount = {
  project_id: string;
  client_email: string;
  private_key: string;
};

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';

function serviceAccount(): ServiceAccount | null {
  const raw = process.env.FCM_SERVICE_ACCOUNT_JSON;
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as ServiceAccount;
    if (!parsed.project_id || !parsed.client_email || !parsed.private_key) return null;
    // Env vars flatten newlines in the PEM.
    parsed.private_key = parsed.private_key.replace(/\\n/g, '\n');
    return parsed;
  } catch {
    return null;
  }
}

let cachedToken: { value: string; expiresAt: number } | undefined;

async function accessToken(sa: ServiceAccount): Promise<string> {
  // Google's tokens last an hour; re-minting one per push wastes a round trip
  // on the login path.
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) {
    return cachedToken.value;
  }

  const key = await importPKCS8(sa.private_key, 'RS256');
  const assertion = await new SignJWT({ scope: SCOPE })
    .setProtectedHeader({ alg: 'RS256' })
    .setIssuer(sa.client_email)
    .setSubject(sa.client_email)
    .setAudience(TOKEN_URL)
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(key);

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  });

  if (!res.ok) throw new Error(`FCM token exchange failed: ${res.status}`);
  const json = (await res.json()) as { access_token: string; expires_in: number };
  cachedToken = {
    value: json.access_token,
    expiresAt: Date.now() + json.expires_in * 1000,
  };
  return cachedToken.value;
}

export type PushMessage = {
  /** Data-only. A logout must not surface a notification the user has to
   *  dismiss — the app handles it silently. */
  data: Record<string, string>;
  title?: string;
  body?: string;
};

export type PushResult = { sent: number; disabled: number; skipped: boolean };

async function sendToToken(
  sa: ServiceAccount,
  token: string,
  message: PushMessage,
): Promise<'ok' | 'unregistered' | 'failed'> {
  const payload: Record<string, unknown> = {
    message: {
      token,
      data: message.data,
      android: { priority: 'HIGH' },
      apns: { headers: { 'apns-priority': '10' }, payload: { aps: { 'content-available': 1 } } },
      ...(message.title
        ? { notification: { title: message.title, body: message.body ?? '' } }
        : {}),
    },
  };

  const res = await fetch(
    `https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${await accessToken(sa)}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(payload),
    },
  );

  if (res.ok) return 'ok';
  // 404 UNREGISTERED / 400 INVALID_ARGUMENT mean the token is dead. Keeping it
  // means retrying a doomed send on every future push.
  if (res.status === 404 || res.status === 400) return 'unregistered';
  return 'failed';
}

async function sendToUserTokens(
  userId: string,
  message: PushMessage,
  filterSessionId?: string,
): Promise<PushResult> {
  const sa = serviceAccount();
  const db = getDb();

  const rows = await db
    .select({ id: deviceTokens.id, fcmToken: deviceTokens.fcmToken })
    .from(deviceTokens)
    .where(
      and(
        eq(deviceTokens.userId, userId),
        isNull(deviceTokens.disabledAt),
        ...(filterSessionId ? [eq(deviceTokens.sessionId, filterSessionId)] : []),
      ),
    );

  if (!sa) {
    // Loud enough to notice in dev, quiet enough not to be an error.
    console.warn(
      `[push] FCM_SERVICE_ACCOUNT_JSON not set — skipped ${rows.length} message(s) for ${userId}`,
    );
    return { sent: 0, disabled: 0, skipped: true };
  }

  let sent = 0;
  let disabled = 0;

  for (const row of rows) {
    let outcome: 'ok' | 'unregistered' | 'failed';
    try {
      outcome = await sendToToken(sa, row.fcmToken, message);
    } catch {
      outcome = 'failed';
    }

    if (outcome === 'ok') sent++;
    if (outcome === 'unregistered') {
      disabled++;
      await db
        .update(deviceTokens)
        .set({ disabledAt: sql`now()` })
        .where(eq(deviceTokens.id, row.id));
    }
  }

  return { sent, disabled, skipped: false };
}

/**
 * Push a logout to the device whose session was just revoked (Section 15).
 *
 * Scoped to that session's tokens only — pushing to every device the user owns
 * would log out the device that just legitimately signed in.
 */
export async function notifySessionRevoked(params: {
  userId: string;
  revokedSessionId: string;
  reason: string;
}): Promise<PushResult> {
  return sendToUserTokens(
    params.userId,
    {
      data: {
        type: 'session_revoked',
        reason: params.reason,
        sessionId: params.revokedSessionId,
      },
    },
    params.revokedSessionId,
  );
}

/** General-purpose push for the Section 15 notification matrix. */
export async function pushToUser(userId: string, message: PushMessage): Promise<PushResult> {
  return sendToUserTokens(userId, message);
}

export async function registerDeviceToken(params: {
  id: string;
  userId: string;
  sessionId: string;
  fcmToken: string;
  platform: string;
  deviceFingerprint?: string | null;
}): Promise<void> {
  const db = getDb();
  await db
    .insert(deviceTokens)
    .values({
      id: params.id,
      userId: params.userId,
      sessionId: params.sessionId,
      fcmToken: params.fcmToken,
      platform: params.platform,
      deviceFingerprint: params.deviceFingerprint ?? null,
    })
    .onConflictDoUpdate({
      target: [deviceTokens.userId, deviceTokens.fcmToken],
      set: {
        sessionId: params.sessionId,
        platform: params.platform,
        deviceFingerprint: params.deviceFingerprint ?? null,
        lastSeenAt: sql`now()`,
        disabledAt: null,
      },
    });
}
