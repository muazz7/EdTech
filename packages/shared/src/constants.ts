/**
 * Platform-wide constants. Appendix B conventions:
 * money is integer poisha, time is timestamptz UTC, IDs are UUID v7.
 */

// ── Money ───────────────────────────────────────────────────────────────────
// 1 BDT = 100 poisha. Never store BDT as a float or decimal.
export const POISHA_PER_BDT = 100;
export const CURRENCY = 'BDT' as const;

export function poishaToBdt(poisha: number): number {
  return poisha / POISHA_PER_BDT;
}

/** Formats poisha for display. Callers must render with tabular figures so
 *  price columns and timers do not shift width between values. */
export function formatPoisha(poisha: number, locale = 'en-BD'): string {
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: CURRENCY,
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(poishaToBdt(poisha));
}

// ── Roles ───────────────────────────────────────────────────────────────────
export const USER_ROLES = ['student', 'teacher', 'admin'] as const;
export type UserRole = (typeof USER_ROLES)[number];

export const PLATFORMS = ['web', 'android', 'ios'] as const;
export type Platform = (typeof PLATFORMS)[number];

// ── Session & device policy (Section 6.3) ───────────────────────────────────
/** Distinct device fingerprints permitted per rolling 30 days. A fifth new
 *  device blocks login and routes the student to support. Switching between
 *  already-seen devices is free. */
export const MAX_DEVICE_SWITCHES_PER_30D = 4;
export const DEVICE_SWITCH_WINDOW_DAYS = 30;

/** Session `last_active_at` is written at most once per this interval, not on
 *  every request. */
export const SESSION_TOUCH_INTERVAL_SECONDS = 60;

// ── Token lifetimes (Section 6.2) ───────────────────────────────────────────
export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
export const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;

// ── Media TTLs (Sections 9.1, 9.2) ──────────────────────────────────────────
export const VDOCIPHER_PLAYBACK_TTL_SECONDS = 300;
export const R2_SIGNED_URL_TTL_SECONDS = 900;

// ── Entitlement cache (Section 7) ───────────────────────────────────────────
/** Never longer. A revocation must bite within a minute. */
export const ENTITLEMENT_CACHE_TTL_SECONDS = 60;

// ── Progress (Section 14) ───────────────────────────────────────────────────
/** A video lesson completes at 90% watched, not 100% — students skip outros. */
export const VIDEO_COMPLETION_THRESHOLD = 0.9;
export const HEARTBEAT_INTERVAL_SECONDS = 15;
/** Heartbeats advancing faster than wall-clock x rate x this factor are
 *  discarded as seek-scrubbing, and doubled as a piracy signal. */
export const MAX_PLAYBACK_ADVANCE_FACTOR = 1.2;
export const DOCUMENT_DWELL_COMPLETE_SECONDS = 10;
/** The client batches two heartbeats into one request. */
export const PROGRESS_FLUSH_INTERVAL_SECONDS = HEARTBEAT_INTERVAL_SECONDS * 2;
/**
 * Longest gap between two reports that still counts as continuous watching.
 *
 * Without this cap the anti-gaming allowance grows with idle time: a student
 * could open a lesson, leave it overnight, and a single seek to the end would
 * be inside an allowance of 86400 seconds and credit the whole video. Time
 * away from the page is not watch time, so the gap is clamped.
 */
export const MAX_PROGRESS_GAP_SECONDS = 120;

// ── Assessment (Section 10, 11, 13) ─────────────────────────────────────────
/**
 * Slack on the server-side time limit.
 *
 * The countdown the student sees is decoration; the limit is enforced against
 * `started_at`. A submit that arrives a few seconds late is a slow connection,
 * not cheating, and failing it would be indistinguishable from losing the
 * attempt. Answers arriving after the grace window are marked unanswered
 * (Section 10) rather than the whole attempt being rejected.
 */
export const ATTEMPT_GRACE_SECONDS = 30;
/** Attempts left open past this are auto-submitted by the cron sweep, so an
 *  abandoned attempt does not sit forever holding the student's one try. */
export const ATTEMPT_ABANDON_HOURS = 24;
export const CERTIFICATE_PREFIX = 'CERT-';

// ── Payments (Section 8) ────────────────────────────────────────────────────
export const PAYMENT_REFERENCE_PREFIX = 'PAY-';
export const PAYMENT_VERIFICATION_SLA_HOURS = 6;
export const PAYMENT_GRACE_PERIOD_DAYS = 3;
export const PAYMENT_PENDING_EXPIRY_DAYS = 7;
export const PAYMENT_PROOF_MAX_BYTES = 5 * 1024 * 1024;
/** bKash transaction IDs are 10 alphanumeric characters. Validating this
 *  client-side saves a rejection cycle. */
export const BKASH_TRX_ID_PATTERN = /^[A-Z0-9]{10}$/;

// ── Rate limits (Section 6.4) ───────────────────────────────────────────────
export const RATE_LIMITS = {
  otpRequestPerPhone: { limit: 3, windowSeconds: 15 * 60 },
  otpRequestPerIp: { limit: 10, windowSeconds: 60 * 60 },
  loginPerIp: { limit: 10, windowSeconds: 15 * 60 },
  playbackOtpPerUser: { limit: 60, windowSeconds: 60 * 60 },
  signedAssetPerUser: { limit: 120, windowSeconds: 60 * 60 },
  paymentSubmissionPerUser: { limit: 5, windowSeconds: 24 * 60 * 60 },
  doubtPostPerUser: { limit: 10, windowSeconds: 24 * 60 * 60 },
  /** Exact-phone student lookup. Not in Section 6.4, added because the lookup
   *  is inherently an "is this number registered?" oracle — the limit is what
   *  stops it being walked across a range of numbers. */
  studentLookupPerUser: { limit: 40, windowSeconds: 60 * 60 },
  defaultPerUser: { limit: 300, windowSeconds: 60 },
} as const;

// ── Piracy signals (Section 17.5) ───────────────────────────────────────────
export const PIRACY_THRESHOLDS = {
  distinctIpsPer24h: 4,
  distinctDevicesPer30d: 4,
  impossibleTravelKm: 400,
  impossibleTravelWindowHours: 1,
  watchHoursPer24h: 20,
  signedUrlsPer10Min: 60,
} as const;

// ── Display ─────────────────────────────────────────────────────────────────
/** UTC in the database, Asia/Dhaka at render time only. */
export const DISPLAY_TIMEZONE = 'Asia/Dhaka';
