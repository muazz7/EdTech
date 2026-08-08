/**
 * Shared Sentry options. Section 17.6 requires PII scrubbing.
 *
 * This platform's PII is unusually sensitive: a student's phone number is their
 * login identity, and the watermark payload embeds name plus phone into every
 * video frame. An unscrubbed error report can leak both, plus the VdoCipher
 * secret or an R2 signed URL — and a signed URL in a Sentry event is a working
 * link to paid content for anyone with dashboard access.
 */
/**
 * SERVER AND EDGE ONLY. There is deliberately no browser Sentry entry point.
 *
 * @sentry/nextjs costs ~82 kB of first-load JS in the browser, and importing it
 * from an instrumentation-client file bundles it whether or not a DSN is set —
 * omitting the DSN disables reporting but does not reclaim the bytes. Section
 * 1.4 names uneven Bangladeshi bandwidth as a constraint that shaped this
 * build, so the file was removed rather than merely disabled. Server and API
 * faults are still captured, which is where the failures that cost money live.
 *
 * If browser error reporting is ever wanted, recreate
 * apps/web/instrumentation-client.ts and re-measure the bundle before merging.
 */
export const sentryShared = {
  dsn: process.env.SENTRY_DSN,

  // Never send cookies, headers, or request bodies automatically. The refresh
  // token and session id both live in cookies.
  sendDefaultPii: false,

  environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? 'development',

  // 10% in production: Sentry's free tier is small and Section 20 has no line
  // item for tracing overage.
  tracesSampleRate: process.env.NODE_ENV === 'production' ? 0.1 : 0,

  // Nothing is sent from a dev machine unless SENTRY_DEBUG is on, so local
  // noise never eats the quota.
  enabled: Boolean(
    process.env.SENTRY_DSN &&
      (process.env.NODE_ENV === 'production' || process.env.SENTRY_DEBUG === '1'),
  ),
};

const SECRET_KEYS = [
  'authorization',
  'cookie',
  'set-cookie',
  'x-session-id',
  'refresh_token',
  'refreshtoken',
  'accesstoken',
  'access_token',
  'password',
  'token',
  'otp',
  'code',
  'jwt_secret',
  'service_role',
  'supabase_service_role_key',
  'vdocipher_api_secret',
  'r2_secret_access_key',
  'r2_access_key_id',
  'upstash_redis_rest_token',
];

const PHONE = /\+?880\d{10}|\b01[3-9]\d{8}\b/g;
const BEARER = /Bearer\s+[A-Za-z0-9._~+/-]+=*/gi;
const JWT = /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g;
// Presigned R2/S3 URLs. The signature is the whole credential.
const SIGNED_URL = /([?&])(X-Amz-Signature|X-Amz-Credential|Signature)=[^&\s"']+/gi;

function scrubString(value: string): string {
  return value
    .replace(BEARER, 'Bearer [redacted]')
    .replace(JWT, '[jwt-redacted]')
    .replace(SIGNED_URL, '$1$2=[redacted]')
    .replace(PHONE, '[phone-redacted]');
}

/** Walks an event and redacts secrets by key name and by value pattern. */
function scrub(value: unknown, depth = 0): unknown {
  if (depth > 8 || value == null) return value;
  if (typeof value === 'string') return scrubString(value);
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => scrub(v, depth + 1));

  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SECRET_KEYS.includes(key.toLowerCase()) ? '[redacted]' : scrub(v, depth + 1);
  }
  return out;
}

/**
 * beforeSend runs on every event, client and server. Scrubbing here rather
 * than at each capture site means a new throw site cannot forget to do it.
 */
export function beforeSend<T>(event: T): T {
  return scrub(event) as T;
}
