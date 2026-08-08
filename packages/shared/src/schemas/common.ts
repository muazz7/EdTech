import { z } from 'zod';
import { PLATFORMS, USER_ROLES } from '../constants.js';

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
 * Device descriptor sent on every login. `fingerprint` is deliberately coarse
 * (Section 6.3): mobile sends a stable install ID, web sends a random ID held
 * in an httpOnly cookie plus a UA hash. Aggressive browser fingerprinting is
 * fragile and produces false positives that punish real students.
 */
export const deviceSchema = z.object({
  fingerprint: z.string().min(8).max(200),
  label: z.string().max(120).optional(),
  platform: platformSchema,
});
export type DeviceInput = z.infer<typeof deviceSchema>;

/** All responses are { data, error, meta }. */
export type ApiEnvelope<T> = {
  data: T | null;
  error: { code: string; message: string; details?: unknown } | null;
  meta?: Record<string, unknown>;
};
