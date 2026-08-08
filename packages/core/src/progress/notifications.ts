import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { getDb, notifications } from '@edtech/db';
import { ApiError, ERROR_CODES } from '@edtech/shared';

/**
 * In-app notifications (Section 15).
 *
 * SMS costs real money per message in Bangladesh, so Section 15 reserves it for
 * OTP, payment outcomes and expiry warnings — the three where failure costs
 * revenue. Everything else lands here and, once FCM credentials exist, as a
 * push.
 */

export async function listNotifications(userId: string, limit = 50) {
  const db = getDb();

  const rows = await db
    .select({
      id: notifications.id,
      type: notifications.type,
      title: notifications.title,
      body: notifications.body,
      link: notifications.link,
      readAt: notifications.readAt,
      createdAt: notifications.createdAt,
    })
    .from(notifications)
    .where(eq(notifications.userId, userId))
    .orderBy(desc(notifications.createdAt))
    .limit(limit);

  const unread = rows.filter((r) => !r.readAt).length;
  return { notifications: rows, unread };
}

export async function markNotificationRead(userId: string, notificationId: string) {
  const db = getDb();

  const [updated] = await db
    .update(notifications)
    .set({ readAt: sql`now()` })
    // Scoped to the owner: without the user_id predicate this would mark any
    // notification read by id, which is a (minor) cross-account write.
    .where(
      and(
        eq(notifications.id, notificationId),
        eq(notifications.userId, userId),
        isNull(notifications.readAt),
      ),
    )
    .returning({ id: notifications.id });

  if (!updated) {
    // Already read, or not theirs. Same answer either way — no way to probe
    // whether someone else's notification exists.
    throw new ApiError(404, ERROR_CODES.NOT_FOUND, 'Notification not found.');
  }

  return { read: true };
}

export async function markAllNotificationsRead(userId: string) {
  const db = getDb();
  const rows = await db
    .update(notifications)
    .set({ readAt: sql`now()` })
    .where(and(eq(notifications.userId, userId), isNull(notifications.readAt)))
    .returning({ id: notifications.id });

  return { read: rows.length };
}
