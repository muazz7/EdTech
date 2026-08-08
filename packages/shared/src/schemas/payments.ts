import { z } from 'zod';
import { uuidSchema } from './common.js';

export const PAYMENT_CHANNELS = ['bkash', 'nagad', 'rocket', 'bank', 'cash', 'other'] as const;
export const paymentChannelSchema = z.enum(PAYMENT_CHANNELS);

export const REJECTION_REASONS = [
  'wrong_amount',
  'unreadable_proof',
  'duplicate',
  'not_received',
  'other',
] as const;
export const rejectionReasonSchema = z.enum(REJECTION_REASONS);

// ── Teacher payment methods ─────────────────────────────────────────────────

export const paymentMethodSchema = z.object({
  channel: paymentChannelSchema,
  accountNumber: z.string().trim().min(4).max(40),
  /** bKash charges differ between Personal and Merchant, and the student needs
   *  to pick the right send option. */
  accountType: z.string().trim().max(40).optional(),
  accountLabel: z.string().trim().max(120).optional(),
  instructions: z.string().trim().max(1000).optional(),
});

export const updatePaymentMethodSchema = paymentMethodSchema.partial().extend({
  isActive: z.boolean().optional(),
});

// ── Student purchase ────────────────────────────────────────────────────────

export const paymentIntentSchema = z
  .object({
    courseId: uuidSchema.optional(),
    planId: uuidSchema.optional(),
  })
  .refine((v) => Boolean(v.courseId) !== Boolean(v.planId), {
    message: 'Choose either a course or a plan.',
  });

/**
 * bKash transaction IDs are 10 alphanumeric characters. Validating the shape
 * client-side catches a typo before submission and saves a whole rejection
 * cycle (Section 8.1) — but the format is not identical across wallets, so the
 * rule is loose enough to accept Nagad and Rocket too.
 */
export const submitProofSchema = z.object({
  referenceCode: z.string().trim().min(6).max(20),
  channel: paymentChannelSchema,
  senderNumber: z
    .string()
    .trim()
    .regex(/^(?:\+?880|0)1[3-9]\d{8}$/, 'Enter the number you sent from, e.g. 01712345678.'),
  transactionId: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9]{6,20}$/, 'Transaction IDs are 6-20 letters and numbers.'),
  proofKey: z.string().max(500).optional(),
  paymentMethodId: uuidSchema.optional(),
  studentNote: z.string().trim().max(500).optional(),
});

export const proofUploadUrlSchema = z.object({
  mime: z.enum(['image/jpeg', 'image/png', 'image/webp']),
  /** Section 8.1 caps the proof screenshot at 5 MB. */
  size: z.number().int().positive().max(5 * 1024 * 1024),
});

// ── Review ──────────────────────────────────────────────────────────────────

export const rejectPaymentSchema = z.object({
  reason: rejectionReasonSchema,
  note: z.string().trim().max(500).optional(),
});

// ── Manual access ───────────────────────────────────────────────────────────

export const grantAccessSchema = z.object({
  studentId: uuidSchema,
  courseId: uuidSchema.optional(),
  /** Admin only. A teacher's grants are forced to single_course server-side. */
  kind: z.enum(['subscription', 'lifetime_all', 'single_course']).optional(),
  planId: uuidSchema.optional(),
  expiresAt: z.coerce.date().optional(),
  note: z.string().trim().max(500).optional(),
});

export const revokeAccessSchema = z.object({
  reason: z.string().trim().min(3).max(200),
});
