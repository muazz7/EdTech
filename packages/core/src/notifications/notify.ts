import { uuidv7 } from 'uuidv7';
import { getDb, notifications } from '@edtech/db';
import { pushToUser } from './push.js';

/**
 * One place that raises a notification (Section 15).
 *
 * Writes the in-app row first, then attempts a push. That order matters: the
 * row is the durable record the student will find in their inbox, and push is
 * a delivery optimisation that may be skipped entirely (no FCM credentials in
 * development). A push failure must never lose the notification.
 *
 * SMS is deliberately NOT wired in here. Section 15 reserves it for OTP,
 * payment outcomes and expiry warnings, because SMS costs real money per
 * message in Bangladesh and a chatty default would be a running bill.
 */

export type NotifyInput = {
  userId: string;
  type: string;
  title: string;
  body?: string | null;
  link?: string | null;
  /** Set false for high-volume or low-value events that belong in the inbox but
   *  are not worth waking a phone for. */
  push?: boolean;
};

export async function notify(input: NotifyInput): Promise<{ id: string }> {
  const db = getDb();
  const id = uuidv7();

  await db.insert(notifications).values({
    id,
    userId: input.userId,
    type: input.type,
    title: input.title,
    body: input.body ?? null,
    link: input.link ?? null,
  });

  if (input.push !== false) {
    // Swallowed: the notification already exists, and a vendor outage must not
    // fail the action that raised it.
    await pushToUser(input.userId, {
      data: { type: input.type, ...(input.link ? { link: input.link } : {}) },
      title: input.title,
      ...(input.body ? { body: input.body } : {}),
    }).catch((err) => console.error('[notify] push failed:', err));
  }

  return { id };
}
