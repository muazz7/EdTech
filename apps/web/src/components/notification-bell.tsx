'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { api } from '@/lib/client/api-client';
import { useAuth } from './auth-provider';
import { BellIcon } from './icons';

/**
 * Unread count in the header.
 *
 * Fetched once per page load and again when the tab regains focus, not on a
 * timer. A poll every few seconds would be a request per student per few
 * seconds for a number that changes a handful of times a day, and Section 1.4
 * names bandwidth as a real constraint here. Push (Section 15) is the eventual
 * answer for anything more immediate.
 */
export function NotificationBell() {
  const { state } = useAuth();
  const [unread, setUnread] = useState(0);
  const signedIn = state.status === 'signed-in';

  const load = useCallback(() => {
    if (!signedIn) return;
    void api
      .get<{ unread: number }>('/me/notifications')
      .then((data) => setUnread(data.unread))
      // A failed count is not worth an error state in the header.
      .catch(() => undefined);
  }, [signedIn]);

  useEffect(() => {
    load();
    const onVisible = () => {
      if (document.visibilityState === 'visible') load();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [load]);

  if (!signedIn) return null;

  return (
    <Link
      href="/account/notifications"
      // The count is in the accessible name, not only in the badge — a screen
      // reader user gets "Notifications, 3 unread", not "Notifications".
      aria-label={unread > 0 ? `Notifications, ${unread} unread` : 'Notifications'}
      className="relative inline-flex size-11 items-center justify-center rounded-[var(--radius-md)] text-[var(--color-muted-foreground)] transition-colors duration-150 hover:bg-[var(--color-muted)] hover:text-[var(--color-foreground)]"
    >
      <BellIcon className="size-5" />
      {unread > 0 && (
        <span
          aria-hidden="true"
          className="tabular absolute right-1 top-1 min-w-4 rounded-full bg-[var(--color-destructive)] px-1 text-center text-[10px] font-semibold leading-4 text-[var(--color-on-destructive)]"
        >
          {unread > 9 ? '9+' : unread}
        </span>
      )}
    </Link>
  );
}
