/**
 * API error contract (Appendix B):
 *   { error: { code: 'SESSION_REVOKED', message: '…' } }
 *
 * `code` is machine-readable and stable — the Flutter app switches on `code`,
 * never on `message`. Adding a code is safe; renaming one is a breaking change
 * for every mobile client already in the wild.
 */

export const ERROR_CODES = {
  // auth & session
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  TOKEN_EXPIRED: 'TOKEN_EXPIRED',
  TOKEN_INVALID: 'TOKEN_INVALID',
  SESSION_MISSING: 'SESSION_MISSING',
  SESSION_REVOKED: 'SESSION_REVOKED',
  DEVICE_LIMIT_REACHED: 'DEVICE_LIMIT_REACHED',
  OTP_INVALID: 'OTP_INVALID',
  OTP_EXPIRED: 'OTP_EXPIRED',
  ACCOUNT_DEACTIVATED: 'ACCOUNT_DEACTIVATED',

  // authorization
  FORBIDDEN: 'FORBIDDEN',
  ROLE_REQUIRED: 'ROLE_REQUIRED',

  // entitlement (mirrors AccessResult.reason in Section 7)
  NO_ENTITLEMENT: 'NO_ENTITLEMENT',
  ENTITLEMENT_EXPIRED: 'ENTITLEMENT_EXPIRED',
  ENTITLEMENT_REVOKED: 'ENTITLEMENT_REVOKED',
  CONTENT_UNPUBLISHED: 'CONTENT_UNPUBLISHED',

  // payments
  DUPLICATE_TRANSACTION_ID: 'DUPLICATE_TRANSACTION_ID',
  PAYMENT_NOT_PENDING: 'PAYMENT_NOT_PENDING',
  PAYMENT_REFERENCE_UNKNOWN: 'PAYMENT_REFERENCE_UNKNOWN',

  // assessment
  ATTEMPT_LIMIT_REACHED: 'ATTEMPT_LIMIT_REACHED',
  ATTEMPT_TIME_EXPIRED: 'ATTEMPT_TIME_EXPIRED',
  ATTEMPT_ALREADY_SUBMITTED: 'ATTEMPT_ALREADY_SUBMITTED',
  SUBMISSION_LOCKED: 'SUBMISSION_LOCKED',

  // generic
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  NOT_FOUND: 'NOT_FOUND',
  RATE_LIMITED: 'RATE_LIMITED',
  CONFLICT: 'CONFLICT',
  UPSTREAM_FAILED: 'UPSTREAM_FAILED',
  INTERNAL: 'INTERNAL',
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

export class ApiError extends Error {
  readonly status: number;
  readonly code: ErrorCode;
  readonly details?: unknown;

  constructor(status: number, code: ErrorCode, message?: string, details?: unknown) {
    super(message ?? DEFAULT_MESSAGES[code] ?? code);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }

  toJSON() {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details === undefined ? {} : { details: this.details }),
      },
    };
  }
}

/**
 * Human-facing defaults. Every message states cause and recovery path — an
 * error that only says what failed forces a support message.
 */
const DEFAULT_MESSAGES: Partial<Record<ErrorCode, string>> = {
  UNAUTHENTICATED: 'You are not signed in. Please sign in and try again.',
  TOKEN_EXPIRED: 'Your session token expired. Refreshing automatically.',
  SESSION_MISSING: 'This request is missing a session. Please sign in again.',
  SESSION_REVOKED:
    'You were signed out because this account signed in on another device. Only one device can be active at a time.',
  DEVICE_LIMIT_REACHED:
    'This account has been used on too many new devices in the last 30 days. Contact support to unblock this device.',
  OTP_INVALID: 'That code is incorrect. Check the SMS and re-enter it.',
  OTP_EXPIRED: 'That code has expired. Request a new one.',
  ACCOUNT_DEACTIVATED: 'This account is deactivated. Contact support.',
  NO_ENTITLEMENT: 'You do not have access to this content yet. Choose a plan to unlock it.',
  ENTITLEMENT_EXPIRED: 'Your access has expired. Renew to continue where you left off.',
  ENTITLEMENT_REVOKED: 'Your access to this content was revoked. Contact support.',
  CONTENT_UNPUBLISHED: 'This content is not published yet.',
  DUPLICATE_TRANSACTION_ID:
    'This transaction ID has already been submitted. If this is your payment, contact support instead of resubmitting.',
  RATE_LIMITED: 'Too many requests. Wait a moment and try again.',
  VALIDATION_FAILED: 'Some fields need correcting.',
  NOT_FOUND: 'Not found.',
  INTERNAL: 'Something went wrong on our side. Try again shortly.',
};

// ── Convenience constructors ────────────────────────────────────────────────
export const unauthenticated = (m?: string) => new ApiError(401, ERROR_CODES.UNAUTHENTICATED, m);
export const sessionMissing = () => new ApiError(401, ERROR_CODES.SESSION_MISSING);
export const sessionRevoked = () => new ApiError(401, ERROR_CODES.SESSION_REVOKED);
export const forbidden = (m?: string) => new ApiError(403, ERROR_CODES.FORBIDDEN, m);
export const notFound = (m?: string) => new ApiError(404, ERROR_CODES.NOT_FOUND, m);
export const rateLimited = (m?: string) => new ApiError(429, ERROR_CODES.RATE_LIMITED, m);
export const internal = (m?: string) => new ApiError(500, ERROR_CODES.INTERNAL, m);

/** Maps an entitlement denial reason onto the wire error. */
export function entitlementError(
  reason: 'no_entitlement' | 'expired' | 'revoked' | 'unpublished',
): ApiError {
  switch (reason) {
    case 'expired':
      return new ApiError(403, ERROR_CODES.ENTITLEMENT_EXPIRED);
    case 'revoked':
      return new ApiError(403, ERROR_CODES.ENTITLEMENT_REVOKED);
    case 'unpublished':
      return new ApiError(404, ERROR_CODES.CONTENT_UNPUBLISHED);
    case 'no_entitlement':
      return new ApiError(403, ERROR_CODES.NO_ENTITLEMENT);
  }
}
