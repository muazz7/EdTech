import { z } from 'zod';
import { uuidSchema } from './common.js';

export const LESSON_TYPES = ['video', 'pdf', 'note', 'image', 'quiz', 'assignment'] as const;
export const PUBLISH_STATES = ['draft', 'published', 'archived'] as const;

export const lessonTypeSchema = z.enum(LESSON_TYPES);
export const publishStateSchema = z.enum(PUBLISH_STATES);

/** Lowercase, hyphenated, URL-safe. Slugs are permanent public identifiers, so
 *  they are set once at creation and not editable — changing one breaks every
 *  shared link and deep link (Section 9 / Section 18 catalog routes). */
export const slugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(3)
  .max(120)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Use lowercase letters, numbers and hyphens only.');

/** Integer poisha. A float here would silently lose money (Appendix B). */
export const poishaSchema = z
  .number()
  .int('Price must be a whole number of poisha.')
  .min(0)
  .max(100_000_000);

// ── Courses ─────────────────────────────────────────────────────────────────

export const createCourseSchema = z.object({
  title: z.string().trim().min(3).max(200),
  slug: slugSchema,
  subtitle: z.string().trim().max(300).optional(),
  description: z.string().trim().max(10_000).optional(),
  subject: z.string().trim().max(100).optional(),
  level: z.string().trim().max(50).optional(),
  /** Teachers set their own prices (ADR 0002). Every change is audited. */
  pricePoisha: poishaSchema.default(0),
  isInAllAccess: z.boolean().default(true),
});
export type CreateCourseInput = z.infer<typeof createCourseSchema>;

export const updateCourseSchema = createCourseSchema
  .omit({ slug: true })
  .partial()
  .extend({
    state: publishStateSchema.optional(),
  });
export type UpdateCourseInput = z.infer<typeof updateCourseSchema>;

// ── Modules ─────────────────────────────────────────────────────────────────

export const createModuleSchema = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000).optional(),
});

export const updateModuleSchema = createModuleSchema.partial();

// ── Lessons ─────────────────────────────────────────────────────────────────

export const createLessonSchema = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().max(5000).optional(),
  type: lessonTypeSchema,
  isFree: z.boolean().default(false),
  isShortForm: z.boolean().default(false),
});
export type CreateLessonInput = z.infer<typeof createLessonSchema>;

export const updateLessonSchema = createLessonSchema.partial().extend({
  isPublished: z.boolean().optional(),
});
export type UpdateLessonInput = z.infer<typeof updateLessonSchema>;

// ── Reordering ──────────────────────────────────────────────────────────────

/**
 * Drag-and-drop reorder (Section 2.2, both levels).
 *
 * The full ordered set is sent, not a single moved item. The server rejects any
 * list that is not exactly the current children — see reorder.ts for why that
 * check is a security boundary, not a convenience.
 */
export const reorderSchema = z.object({
  orderedIds: z.array(uuidSchema).min(1).max(500),
});
export type ReorderInput = z.infer<typeof reorderSchema>;

// ── Uploads ─────────────────────────────────────────────────────────────────

/** Section 11 and 9.2: validated server-side, never trusting the file picker. */
export const DOCUMENT_MIME_TYPES = [
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
] as const;

export const IMAGE_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;

export const MAX_DOCUMENT_BYTES = 25 * 1024 * 1024;
/** Phone photos of handwritten notes (ADR 0001) are large before conversion. */
export const MAX_NOTE_PAGE_BYTES = 15 * 1024 * 1024;

export const assetUploadUrlSchema = z.object({
  filename: z.string().trim().min(1).max(200),
  mime: z.enum(DOCUMENT_MIME_TYPES),
  size: z.number().int().positive().max(MAX_DOCUMENT_BYTES),
});
export type AssetUploadUrlInput = z.infer<typeof assetUploadUrlSchema>;

export const notePageUploadUrlSchema = z.object({
  pages: z
    .array(
      z.object({
        pageNumber: z.number().int().min(1).max(500),
        mime: z.enum(IMAGE_MIME_TYPES),
        size: z.number().int().positive().max(MAX_NOTE_PAGE_BYTES),
      }),
    )
    .min(1)
    .max(100),
});

export const notePageCommitSchema = z.object({
  pages: z
    .array(
      z.object({
        pageNumber: z.number().int().min(1).max(500),
        key: z.string().min(1).max(500),
        mime: z.enum(IMAGE_MIME_TYPES),
        size: z.number().int().positive().max(MAX_NOTE_PAGE_BYTES),
        width: z.number().int().positive().max(20_000).optional(),
        height: z.number().int().positive().max(20_000).optional(),
      }),
    )
    .min(1)
    .max(100),
});
export type NotePageCommitInput = z.infer<typeof notePageCommitSchema>;

export const videoCompleteSchema = z.object({
  videoId: z.string().trim().min(1).max(200),
});
