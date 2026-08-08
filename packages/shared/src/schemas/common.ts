import { z } from 'zod';
import { PLATFORMS, USER_ROLES, type Platform } from '../constants.js';

export const uuidSchema = z.string().uuid();

export const userRoleSchema = z.enum(USER_ROLES);
export const platformSchema = z.enum(PLATFORMS);

/**
 * Bangladeshi mobile numbers in E.164. Operator prefixes are 013–019 after the
 * leading 1, so the national significant number is 01[3-9]XXXXXXXX.
 * Stored and transmitted as +8801XXXXXXXXX; accept the local 01… form and the
 * 8801… form on input and normalise.
 */
export const phoneSchema = z
  .string()
  .trim()
  .transform((v) => v.replace(/[\s-]/g, ''))
  .refine((v) => /^(?:\+?880|0)1[3-9]\d{8}$/.test(v), {
    message: 'Enter a valid Bangladeshi mobile number, e.g. 01712345678.',
  })
  .transform((v) => {
    const digits = v.replace(/^\+?880/, '').replace(/^0/, '');
    return `+880${digits}`;
  });

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  perPage: z.coerce.number().int().min(1).max(100).default(20),
});
export type Pagination = z.infer<typeof paginationSchema>;

/**
 * Device descriptor sent on every login. Deliberately coarse (Section 6.3):
 * aggressive browser fingerprinting is fragile and produces false positives
 * that punish real students.
 *
 * `fingerprint` is REQUIRED on android/ios, where the app registers a stable
 * install ID, and OMITTED on web. Section 6.3 specifies the web fingerprint as
 * a random ID in an httpOnly cookie plus a UA hash — httpOnly means page
 * scripts cannot read it, so the server derives it and the client never sends
 * one. A web client that supplies a fingerprint is rejected rather than
 * trusted: accepting it would let a sharer rotate the value to evade the
 * device-switch budget.
 */
export const deviceSchema = z
  .object({
    fingerprint: z.string().min(8).max(200).optional(),
    label: z.string().max(120).optional(),
    platform: platformSchema,
  })
  .refine((d) => d.platform === 'web' || Boolean(d.fingerprint), {
    message: 'A device fingerprint is required on mobile.',
    path: ['fingerprint'],
  })
  .refine((d) => d.platform !== 'web' || !d.fingerprint, {
    message: 'Web clients must not supply a device fingerprint; the server derives it.',
    path: ['fingerprint'],
  });
export type DeviceInput = z.infer<typeof deviceSchema>;

/** Resolved server-side before reaching establishSession. */
export type ResolvedDevice = {
  fingerprint: string;
  label?: string;
  platform: Platform;
};

/** All responses are { data, error, meta }. */
export type ApiEnvelope<T> = {
  data: T | null;
  error: { code: string; message: string; details?: unknown } | null;
  meta?: Record<string, unknown>;
};
