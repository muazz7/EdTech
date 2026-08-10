import { z } from 'zod';
import { uuidSchema } from './common.js';

/**
 * Doubt threads (Section 12).
 *
 * Public by default — the same question gets asked forty times, and one
 * searchable answered thread is worth more than forty private replies. The
 * private option exists for the questions a student would not ask in front of
 * the class.
 */

export const createThreadSchema = z.object({
  title: z.string().trim().min(5).max(200),
  body: z.string().trim().min(5).max(5000),
  isPublic: z.boolean().default(true),
});
export type CreateThreadInput = z.infer<typeof createThreadSchema>;

export const createReplySchema = z.object({
  body: z.string().trim().min(1).max(5000),
});
export type CreateReplyInput = z.infer<typeof createReplySchema>;

export const moderateThreadSchema = z.object({
  isResolved: z.boolean().optional(),
  isPinned: z.boolean().optional(),
});

/** A reason is required: the student will ask why, and "no reason recorded" is
 *  not an answer a teacher wants to give. */
export const hidePostSchema = z.object({
  threadId: uuidSchema.optional(),
  replyId: uuidSchema.optional(),
  reason: z.string().trim().min(3).max(300),
});

export const reportPostSchema = z
  .object({
    threadId: uuidSchema.optional(),
    replyId: uuidSchema.optional(),
    reason: z.string().trim().min(3).max(300),
  })
  .refine((value) => Boolean(value.threadId) !== Boolean(value.replyId), {
    message: 'Report either a thread or a reply.',
  });
