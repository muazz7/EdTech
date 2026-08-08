'use client';

import type { ApiEnvelope } from '@edtech/shared';

/**
 * Browser API client.
 *
 * The access token lives in a module-scoped variable and NOWHERE else. Section
 * 6.2 is explicit: never localStorage — an XSS bug there hands an attacker a
 * working session. The refresh token and session id are httpOnly cookies the
 * page cannot read, which is why every call sets credentials: 'include'.
 *
 * A reload therefore starts with no access token. That is correct: `bootstrap()`
 * exchanges the refresh cookie for a fresh one.
 */

let accessToken: string | null = null;
let sessionId: string | null = null;

/** Single in-flight refresh, so a burst of 401s does not fire five rotations —
 *  each would burn the previous token and the last would look like a replay,
 *  which revokes the whole family and logs the user out. */
let refreshInFlight: Promise<boolean> | null = null;

type Listener = (reason: 'revoked' | 'expired') => void;
const signOutListeners = new Set<Listener>();

export function onForcedSignOut(listener: Listener): () => void {
  signOutListeners.add(listener);
  return () => signOutListeners.delete(listener);
}

function forceSignOut(reason: 'revoked' | 'expired') {
  accessToken = null;
  sessionId = null;
  for (const listener of signOutListeners) listener(reason);
}

export function setCredentials(token: string, session: string) {
  accessToken = token;
  sessionId = session;
}

export function hasCredentials(): boolean {
  return accessToken !== null && sessionId !== null;
}

export class ApiClientError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiClientError';
  }
}

type RequestOptions = {
  method?: string;
  body?: unknown;
  /** Set internally to stop a refresh loop. */
  skipRefresh?: boolean;
  /**
   * Lets the request outlive the page (fetch keepalive). Used for the final
   * progress flush when a student closes the tab mid-lesson.
   *
   * sendBeacon cannot do this job: it sends cookies but no custom headers, and
   * every endpoint here requires Authorization and X-Session-Id. keepalive
   * keeps the headers. Bodies are capped at 64KB by the browser, which the
   * batched progress payload is nowhere near.
   */
  keepalive?: boolean;
};

async function raw<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = {};
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (accessToken) headers.authorization = `Bearer ${accessToken}`;
  if (sessionId) headers['x-session-id'] = sessionId;

  const res = await fetch(`/api/v1${path}`, {
    method: options.method ?? 'GET',
    headers,
    credentials: 'include',
    ...(options.keepalive ? { keepalive: true } : {}),
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });

  let envelope: ApiEnvelope<T> | null = null;
  try {
    envelope = (await res.json()) as ApiEnvelope<T>;
  } catch {
    // A non-JSON body means something upstream failed before our handler.
  }

  if (res.ok) return envelope?.data as T;

  const code = envelope?.error?.code ?? 'INTERNAL';
  const message = envelope?.error?.message ?? 'Something went wrong. Try again.';

  // An expired 15-minute access token is normal, not an error worth showing.
  if (res.status === 401 && code === 'TOKEN_EXPIRED' && !options.skipRefresh) {
    if (await refresh()) {
      return raw<T>(path, { ...options, skipRefresh: true });
    }
    forceSignOut('expired');
  }

  // SESSION_REVOKED means another device signed in, or a refresh token was
  // replayed. Not recoverable here — the user must sign in again.
  if (res.status === 401 && code === 'SESSION_REVOKED') {
    forceSignOut('revoked');
  }

  throw new ApiClientError(res.status, code, message, envelope?.error?.details);
}

async function refresh(): Promise<boolean> {
  refreshInFlight ??= (async () => {
    try {
      const data = await raw<{ accessToken: string; sessionId: string }>('/auth/refresh', {
        method: 'POST',
        body: {},
        skipRefresh: true,
      });
      setCredentials(data.accessToken, data.sessionId);
      return true;
    } catch {
      return false;
    } finally {
      refreshInFlight = null;
    }
  })();

  return refreshInFlight;
}

/** Called once on mount: turns the httpOnly refresh cookie into a live session,
 *  or reports that there is none. */
export async function bootstrap(): Promise<boolean> {
  if (hasCredentials()) return true;
  return refresh();
}

export const api = {
  get: <T>(path: string) => raw<T>(path),
  post: <T>(path: string, body?: unknown) => raw<T>(path, { method: 'POST', body: body ?? {} }),
  /** POST that survives the page being closed. Best-effort by definition: a
   *  keepalive request cannot be retried, so a 401 here is simply lost. */
  postKeepalive: <T>(path: string, body: unknown) =>
    raw<T>(path, { method: 'POST', body, keepalive: true, skipRefresh: true }),
  patch: <T>(path: string, body: unknown) => raw<T>(path, { method: 'PATCH', body }),
  put: <T>(path: string, body: unknown) => raw<T>(path, { method: 'PUT', body }),
  del: <T>(path: string) => raw<T>(path, { method: 'DELETE' }),
};
