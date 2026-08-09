'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { api } from '@/lib/client/api-client';
import { AuthProvider, useAuth } from '@/components/auth-provider';
import { SiteHeader } from '@/components/site-header';
import { Badge, Button, Card, EmptyState, ErrorNote, ProgressBar, Skeleton } from '@/components/ui';
import { BellIcon, CheckCircleIcon, DeviceIcon, KeyIcon } from '@/components/icons';

type AccountSecurity = {
  session: {
    deviceLabel: string | null;
    platform: string;
    createdAt: string;
    lastActiveAt: string;
    isCurrent: boolean;
  } | null;
  devices: { used: number; limit: number; remaining: number; windowDays: number; recent: string[] };
};

type Entitlement = {
  id: string;
  kind: 'single_course' | 'lifetime_all' | 'subscription';
  source: string;
  startsAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
  courseTitle: string | null;
  courseSlug: string | null;
};

const KIND_LABEL: Record<Entitlement['kind'], string> = {
  single_course: 'Course',
  lifetime_all: 'All courses, lifetime',
  subscription: 'Plan',
};

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

/** Active, expired or removed — the three states a student needs to tell apart
 *  before contacting anyone about missing access. */
function statusOf(row: Entitlement): { label: string; tone: 'success' | 'neutral' | 'danger' } {
  if (row.revokedAt) return { label: 'Removed', tone: 'danger' };
  if (row.expiresAt && new Date(row.expiresAt) <= new Date()) {
    return { label: 'Expired', tone: 'neutral' };
  }
  return { label: 'Active', tone: 'success' };
}

/**
 * Account screen (Section 2.3).
 *
 * The device budget is here rather than buried in an error message. Finding out
 * the limit exists by being locked out on the morning of an exam is the worst
 * possible time to learn it, and each one of those becomes a support message.
 */
function AccountScreen() {
  const { state, signOut } = useAuth();
  const [security, setSecurity] = useState<AccountSecurity | null>(null);
  const [entitlements, setEntitlements] = useState<Entitlement[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [sec, ents] = await Promise.all([
        api.get<AccountSecurity>('/me/account'),
        api.get<Entitlement[]>('/me/entitlements'),
      ]);
      setSecurity(sec);
      setEntitlements(ents);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load your account.');
    }
  }, []);

  useEffect(() => {
    if (state.status === 'signed-in') void load();
  }, [state.status, load]);

  if (state.status === 'signed-out') {
    return (
      <div className="mx-auto max-w-md px-4 py-16 sm:px-6">
        <EmptyState
          title="Sign in to see your account"
          body="Your courses, payments and devices are tied to your account."
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

  if (state.status === 'loading') {
    return (
      <div className="mx-auto flex max-w-2xl flex-col gap-4 px-4 py-8 sm:px-6">
        <Skeleton className="h-9 w-48" />
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-32 w-full" />
        <span className="sr-only" role="status">
          Loading your account
        </span>
      </div>
    );
  }

  const me = state.me;
  const devices = security?.devices;
  const budgetUsedPercent = devices ? Math.round((devices.used / devices.limit) * 100) : 0;

  return (
    <div className="mx-auto max-w-2xl px-4 py-8 sm:px-6">
      <h1 className="text-2xl font-semibold text-[var(--color-foreground)]">Account</h1>

      {error && (
        <div className="mt-4">
          <ErrorNote onRetry={() => void load()}>{error}</ErrorNote>
        </div>
      )}

      <Card className="mt-6 p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-lg font-semibold text-[var(--color-foreground)]">{me.fullName}</p>
            {me.phone && (
              <p className="tabular text-sm text-[var(--color-muted-foreground)]">{me.phone}</p>
            )}
            {me.institution && (
              <p className="text-sm text-[var(--color-muted-foreground)]">{me.institution}</p>
            )}
          </div>
          {me.role !== 'student' && <Badge tone="info">{me.role}</Badge>}
        </div>

        <div className="mt-4 flex flex-wrap gap-2">
          <Link
            href="/account/notifications"
            className="inline-flex min-h-11 items-center gap-2 rounded-[var(--radius-md)] border border-[var(--color-border-strong)] px-3 text-sm text-[var(--color-foreground)] hover:bg-[var(--color-muted)]"
          >
            <BellIcon className="size-4" />
            Notifications
          </Link>
          <Link
            href="/account/payments"
            className="inline-flex min-h-11 items-center gap-2 rounded-[var(--radius-md)] border border-[var(--color-border-strong)] px-3 text-sm text-[var(--color-foreground)] hover:bg-[var(--color-muted)]"
          >
            <KeyIcon className="size-4" />
            Payments
          </Link>
          <Link
            href="/account/certificates"
            className="inline-flex min-h-11 items-center gap-2 rounded-[var(--radius-md)] border border-[var(--color-border-strong)] px-3 text-sm text-[var(--color-foreground)] hover:bg-[var(--color-muted)]"
          >
            <CheckCircleIcon className="size-4" />
            Certificates
          </Link>
          {me.role === 'teacher' && (
            <Link
              href="/teacher"
              className="inline-flex min-h-11 items-center rounded-[var(--radius-md)] border border-[var(--color-border-strong)] px-3 text-sm text-[var(--color-foreground)] hover:bg-[var(--color-muted)]"
            >
              Teacher portal
            </Link>
          )}
        </div>
      </Card>

      <section className="mt-8">
        <h2 className="text-lg font-semibold text-[var(--color-foreground)]">This device</h2>

        {!security && !error && <Skeleton className="mt-3 h-32 w-full" />}

        {security && (
          <Card className="mt-3 p-5">
            <div className="flex items-start gap-3">
              <DeviceIcon className="mt-0.5 size-5 shrink-0 text-[var(--color-muted-foreground)]" />
              <div className="min-w-0 flex-1">
                <p className="font-medium text-[var(--color-foreground)]">
                  {security.session?.deviceLabel ?? 'This browser'}
                </p>
                <p className="text-sm text-[var(--color-muted-foreground)]">
                  {security.session
                    ? `Signed in since ${formatDate(security.session.createdAt)} · ${security.session.platform}`
                    : 'No active session found.'}
                </p>
              </div>
            </div>

            {/* Section 6.3 in plain words. You can only be signed in on one
                device at a time, and the budget is what makes account sharing
                expensive — but a student who does not know it exists just
                experiences it as a bug. */}
            <p className="prose-measure mt-4 text-sm text-[var(--color-muted-foreground)]">
              You can be signed in on one device at a time. Signing in somewhere else signs you out
              here.
            </p>

            {devices && (
              <div className="mt-4">
                <ProgressBar
                  value={budgetUsedPercent}
                  label={`Devices used in the last ${devices.windowDays} days`}
                />
                <p className="mt-1 text-sm text-[var(--color-muted-foreground)]">
                  <span className="tabular">{devices.used}</span> of{' '}
                  <span className="tabular">{devices.limit}</span> devices used in the last{' '}
                  <span className="tabular">{devices.windowDays}</span> days.{' '}
                  {devices.remaining === 0
                    ? 'Switching back to a device you have already used is still free.'
                    : `You can sign in on ${devices.remaining} more new device${devices.remaining === 1 ? '' : 's'}.`}
                </p>
              </div>
            )}

            <div className="mt-4">
              <Button size="sm" onClick={() => void signOut()}>
                Sign out
              </Button>
            </div>
          </Card>
        )}
      </section>

      <section className="mt-8">
        <h2 className="text-lg font-semibold text-[var(--color-foreground)]">Your access</h2>

        {!entitlements && !error && <Skeleton className="mt-3 h-24 w-full" />}

        {entitlements?.length === 0 && (
          <div className="mt-3">
            <EmptyState
              title="No course access yet"
              body="Courses you buy appear here, with the date your access ends if it is time-limited."
              action={
                <Link
                  href="/"
                  className="inline-flex min-h-11 items-center rounded-[var(--radius-md)] bg-[var(--color-primary)] px-4 text-sm font-medium text-[var(--color-on-primary)]"
                >
                  Browse courses
                </Link>
              }
            />
          </div>
        )}

        {entitlements && entitlements.length > 0 && (
          <ul className="mt-3 flex flex-col gap-3">
            {entitlements.map((row) => {
              const status = statusOf(row);
              return (
                <Card as="li" key={row.id} className="p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="font-medium text-[var(--color-foreground)]">
                        {row.courseTitle ?? KIND_LABEL[row.kind]}
                      </p>
                      <p className="text-sm text-[var(--color-muted-foreground)]">
                        {KIND_LABEL[row.kind]} · since {formatDate(row.startsAt)}
                      </p>
                    </div>
                    <Badge tone={status.tone}>{status.label}</Badge>
                  </div>

                  {row.expiresAt && !row.revokedAt && (
                    <p className="mt-2 text-sm text-[var(--color-muted-foreground)]">
                      {new Date(row.expiresAt) > new Date() ? 'Ends' : 'Ended'}{' '}
                      {formatDate(row.expiresAt)}
                    </p>
                  )}

                  {row.courseSlug && (
                    <Link
                      href={`/courses/${row.courseSlug}`}
                      className="mt-2 inline-flex min-h-9 items-center text-sm font-medium text-[var(--color-primary)] hover:underline"
                    >
                      Open course
                    </Link>
                  )}
                </Card>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}

export default function AccountPage() {
  return (
    <AuthProvider>
      <SiteHeader />
      <AccountScreen />
    </AuthProvider>
  );
}
