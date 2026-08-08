'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { api } from '@/lib/client/api-client';
import { AuthProvider, useAuth } from '@/components/auth-provider';
import { SiteHeader } from '@/components/site-header';
import { Badge, Button, Card, EmptyState, ErrorNote, Skeleton } from '@/components/ui';

type Notification = {
  id: string;
  type: string;
  title: string;
  body: string | null;
  link: string | null;
  readAt: string | null;
  createdAt: string;
};

/** Relative for anything recent, absolute once it stops being "the other day".
 *  "3 days ago" is more useful than a date; "12 Mar" is more useful than
 *  "87 days ago". */
function when(iso: string): string {
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  if (days <= 7) return `${days} day${days === 1 ? '' : 's'} ago`;
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

/** Payment outcomes are the ones a student is actually waiting on, so they
 *  carry a tone. Everything else is neutral rather than competing for
 *  attention. */
function toneFor(type: string): 'success' | 'danger' | 'warning' | 'neutral' {
  if (type.includes('approved') || type.includes('verified')) return 'success';
  if (type.includes('rejected')) return 'danger';
  if (type.includes('expir')) return 'warning';
  return 'neutral';
}

function NotificationsScreen() {
  const { state } = useAuth();
  const [rows, setRows] = useState<Notification[] | null>(null);
  const [unread, setUnread] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const data = await api.get<{ notifications: Notification[]; unread: number }>(
        '/me/notifications',
      );
      setRows(data.notifications);
      setUnread(data.unread);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load your notifications.');
    }
  }, []);

  useEffect(() => {
    if (state.status === 'signed-in') void load();
  }, [state.status, load]);

  const markRead = useCallback(async (id: string) => {
    // Optimistic: the read flag is not worth a spinner, and a failure here
    // costs nothing worse than a badge that reappears on the next load.
    setRows((current) =>
      current?.map((row) => (row.id === id ? { ...row, readAt: new Date().toISOString() } : row)) ??
      null,
    );
    setUnread((n) => Math.max(0, n - 1));
    try {
      await api.post(`/me/notifications/${id}/read`);
    } catch {
      // Already read, or gone. Either way the row is correct as shown.
    }
  }, []);

  const markAllRead = useCallback(async () => {
    setBusy(true);
    try {
      await api.post('/me/notifications');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not mark them read.');
    } finally {
      setBusy(false);
    }
  }, [load]);

  if (state.status === 'signed-out') {
    return (
      <div className="mx-auto max-w-md px-4 py-16 sm:px-6">
        <EmptyState
          title="Sign in to see your notifications"
          body="Payment updates and course announcements arrive here."
          action={
            <Link
              href="/login"
              className="inline-flex min-h-11 items-center rounded-[var(--radius-md)] bg-[var(--color-primary)] px-4 text-sm font-medium text-[var(--color-on-primary)]"
            >
              Sign in
            </Link>
          }
        />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl px-4 py-8 sm:px-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold text-[var(--color-foreground)]">Notifications</h1>
        {unread > 0 && (
          <Button size="sm" loading={busy} onClick={() => void markAllRead()}>
            Mark all read
          </Button>
        )}
      </div>

      {error && (
        <div className="mt-4">
          <ErrorNote onRetry={() => void load()}>{error}</ErrorNote>
        </div>
      )}

      {(rows === null || state.status === 'loading') && !error && (
        <div className="mt-6 flex flex-col gap-3">
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-20 w-full" />
          <span className="sr-only" role="status">
            Loading notifications
          </span>
        </div>
      )}

      {rows?.length === 0 && (
        <div className="mt-6">
          <EmptyState
            title="Nothing yet"
            body="Payment updates and messages from your teachers will appear here."
          />
        </div>
      )}

      {rows && rows.length > 0 && (
        <ul className="mt-6 flex flex-col gap-3">
          {rows.map((row) => {
            const isUnread = row.readAt === null;
            return (
              <Card
                as="li"
                key={row.id}
                className={`p-4 ${isUnread ? 'border-[var(--color-primary)]' : ''}`}
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="font-medium text-[var(--color-foreground)]">
                      {row.title}
                      {/* Unread is marked with a word, not only a border
                          colour — a border alone is not perceivable to
                          everyone (WCAG 1.4.1). */}
                      {isUnread && (
                        <>
                          {' '}
                          <Badge tone={toneFor(row.type)}>New</Badge>
                        </>
                      )}
                    </p>
                    {row.body && (
                      <p className="prose-measure mt-1 text-sm text-[var(--color-muted-foreground)]">
                        {row.body}
                      </p>
                    )}
                  </div>
                  <time
                    dateTime={row.createdAt}
                    className="shrink-0 text-xs text-[var(--color-muted-foreground)]"
                  >
                    {when(row.createdAt)}
                  </time>
                </div>

                <div className="mt-3 flex flex-wrap items-center gap-2">
                  {row.link && (
                    <Link
                      href={row.link}
                      onClick={() => void markRead(row.id)}
                      className="inline-flex min-h-9 items-center rounded-[var(--radius-md)] px-3 text-sm font-medium text-[var(--color-primary)] hover:bg-[var(--color-cyan-tint)]"
                    >
                      Open
                    </Link>
                  )}
                  {isUnread && (
                    <Button size="sm" onClick={() => void markRead(row.id)}>
                      Mark read
                    </Button>
                  )}
                </div>
              </Card>
            );
          })}
        </ul>
      )}
    </div>
  );
}

export default function NotificationsPage() {
  return (
    <AuthProvider>
      <SiteHeader />
      <NotificationsScreen />
    </AuthProvider>
  );
}
