import { z } from 'zod';
import { uuidSchema } from './common.js';
import { poishaSchema } from './content.js';

/**
 * Plans and promo codes (Section 8, ADR 0002, ADR 0003).
 *
 * `single_course` is deliberately absent from the plan kinds: a course is
 * priced on the course itself by its own teacher. Plans exist only for the two
 * platform-wide models, which are the Owner's.
 */

export const PLAN_KINDS = ['subscription', 'lifetime_all'] as const;
export const planKindSchema = z.enum(PLAN_KINDS);

export const createPlanSchema = z
  .object({
    kind: planKindSchema,
    name: z.string().trim().min(3).max(120),
    description: z.string().trim().max(2000).optional(),
    pricePoisha: poishaSchema,
    /** Days. Only meaningful for a subscription; a lifetime plan never ends. */
    durationDays: z.number().int().min(1).max(3650).nullable().optional(),
    displayOrder: z.number().int().min(0).max(1000).default(0),
  })
  .refine(
    (value) => value.kind === 'subscription' || !value.durationDays,
    { message: 'A lifetime plan does not expire, so it cannot have a length.', path: ['durationDays'] },
  );
export type CreatePlanInput = z.infer<typeof createPlanSchema>;

export const updatePlanSchema = z.object({
  name: z.string().trim().min(3).max(120).optional(),
  description: z.string().trim().max(2000).optional(),
  pricePoisha: poishaSchema.optional(),
  durationDays: z.number().int().min(1).max(3650).nullable().optional(),
  displayOrder: z.number().int().min(0).max(1000).optional(),
  isActive: z.boolean().optional(),
});
export type UpdatePlanInput = z.infer<typeof updatePlanSchema>;

// ── Promo codes ─────────────────────────────────────────────────────────────

/** Uppercased on the way in. Students type these off a screenshot, and a code
 *  that is case-sensitive generates support messages for no benefit. */
export const promoCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .min(4)
  .max(32)
  .regex(/^[A-Z0-9-]+$/, 'Codes use letters, numbers and hyphens.');

export const createPromoCodeSchema = z.object({
  /** Optional: left empty, the server generates an unambiguous one. */
  code: promoCodeSchema.optional(),
  /** Null scopes the code to every course this teacher owns. */
  courseId: uuidSchema.nullable().optional(),
  /** 100 means free access. */
  discountPercent: z.number().int().min(1).max(100),
  /** The teacher's "quantity" — how many students may use it. */
  maxRedemptions: z.number().int().min(1).max(10_000),
  /** The teacher's "duration". Null never expires. */
  expiresAt: z.string().datetime().nullable().optional(),
  note: z.string().trim().max(300).optional(),
});
export type CreatePromoCodeInput = z.infer<typeof createPromoCodeSchema>;

export const validatePromoCodeSchema = z.object({
  code: promoCodeSchema,
  courseId: uuidSchema,
});
export type ValidatePromoCodeInput = z.infer<typeof validatePromoCodeSchema>;
