import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { lessonType, publishState } from './enums.js';
import { profiles } from './identity.js';

export const courses = pgTable(
  'courses',
  {
    id: uuid('id').primaryKey(),
    slug: text('slug').notNull().unique(),
    title: text('title').notNull(),
    subtitle: text('subtitle'),
    description: text('description'),
    thumbnailKey: text('thumbnail_key'), // R2 object key
    teacherId: uuid('teacher_id')
      .notNull()
      .references(() => profiles.id),
    subject: text('subject'),
    level: text('level'), // 'HSC', 'SSC', 'Admission', ...
    /** Single-course lifetime price, integer poisha. Never a float. */
    pricePoisha: integer('price_poisha').notNull().default(0),
    /** Included in subscription / lifetime-all access. */
    isInAllAccess: boolean('is_in_all_access').notNull().default(true),
    state: publishState('state').notNull().default('draft'),
    displayOrder: integer('display_order').notNull().default(0),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('courses_state_order_idx').on(t.state, t.displayOrder),
    index('courses_teacher_idx').on(t.teacherId),
  ],
);

export const modules = pgTable(
  'modules',
  {
    id: uuid('id').primaryKey(),
    courseId: uuid('course_id')
      .notNull()
      .references(() => courses.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    description: text('description'),
    displayOrder: integer('display_order').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('modules_course_order_idx').on(t.courseId, t.displayOrder)],
);

export const lessons = pgTable(
  'lessons',
  {
    id: uuid('id').primaryKey(),
    moduleId: uuid('module_id')
      .notNull()
      .references(() => modules.id, { onDelete: 'cascade' }),
    /** Denormalized from modules.course_id — every entitlement check needs it,
     *  and paying for a join on the hottest path in the product is not worth
     *  the normalisation. */
    courseId: uuid('course_id')
      .notNull()
      .references(() => courses.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    description: text('description'),
    type: lessonType('type').notNull(),
    displayOrder: integer('display_order').notNull(),
    /** Publicly readable without entitlement — the Free Resource Center. */
    isFree: boolean('is_free').notNull().default(false),
    isPublished: boolean('is_published').notNull().default(false),

    // video
    vdocipherVideoId: text('vdocipher_video_id'),
    durationSeconds: integer('duration_seconds'),
    videoStatus: text('video_status'), // 'uploading'|'transcoding'|'ready'|'failed'
    isShortForm: boolean('is_short_form').notNull().default(false),

    // document / image / note
    r2ObjectKey: text('r2_object_key'),
    pageCount: integer('page_count'),
    fileSizeBytes: bigint('file_size_bytes', { mode: 'number' }),
    mimeType: text('mime_type'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('lessons_module_order_idx').on(t.moduleId, t.displayOrder),
    index('lessons_course_published_idx').on(t.courseId).where(sql`is_published`),
    index('lessons_course_free_idx').on(t.courseId).where(sql`is_free AND is_published`),
  ],
);

/**
 * Ordered pages of an uploaded note.
 *
 * Notes are teacher-uploaded PDFs and phone photographs of handwritten pages —
 * NOT rendered from a rich-text editor. There is no Tiptap source, no Satori
 * render job, and nothing to re-edit; the uploaded file is the artifact.
 * A single-file PDF note uses lessons.r2_object_key alone. A photographed note
 * is N image rows here, ordered by page_number.
 *
 * Delivery is view-online-only: presigned GET (15 min), fetched into a
 * <canvas> with a watermark overlay, never handed to the browser as a file.
 * See the honesty note in Section 17.3 about what that does and does not stop.
 */
export const notePages = pgTable(
  'note_pages',
  {
    id: uuid('id').primaryKey(),
    lessonId: uuid('lesson_id')
      .notNull()
      .references(() => lessons.id, { onDelete: 'cascade' }),
    pageNumber: integer('page_number').notNull(),
    r2ObjectKey: text('r2_object_key').notNull(),
    /** Phone photos land as JPEG and get converted to WebP on upload; PDFs
     *  stay as-is and are paginated client-side by PDF.js. */
    mimeType: text('mime_type'),
    fileSizeBytes: bigint('file_size_bytes', { mode: 'number' }),
    width: integer('width'),
    height: integer('height'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique('note_pages_lesson_page_key').on(t.lessonId, t.pageNumber)],
);

export type Course = typeof courses.$inferSelect;
export type Module = typeof modules.$inferSelect;
export type Lesson = typeof lessons.$inferSelect;
export type NotePage = typeof notePages.$inferSelect;
