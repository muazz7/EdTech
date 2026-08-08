import { pgEnum } from 'drizzle-orm/pg-core';

export const userRole = pgEnum('user_role', ['student', 'teacher', 'admin']);

export const lessonType = pgEnum('lesson_type', [
  'video',
  'pdf',
  'note',
  'image',
  'quiz',
  'assignment',
]);

export const publishState = pgEnum('publish_state', ['draft', 'published', 'archived']);

export const planKind = pgEnum('plan_kind', ['subscription', 'lifetime_all', 'single_course']);

export const entitlementSource = pgEnum('entitlement_source', [
  'purchase',
  'manual_grant',
  'promo',
  'migration',
]);

export const paymentChannel = pgEnum('payment_channel', [
  'bkash',
  'nagad',
  'rocket',
  'bank',
  'cash',
  'other',
]);

export const paymentStatus = pgEnum('payment_status', [
  'pending',
  'verified',
  'rejected',
  'expired',
]);

export const questionType = pgEnum('question_type', [
  'mcq_single',
  'mcq_multi',
  'true_false',
  'short_answer',
  'long_answer',
]);
