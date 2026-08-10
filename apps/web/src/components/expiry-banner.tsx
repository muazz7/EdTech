'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { api } from '@/lib/client/api-client';
import { useAuth } from './auth-provider';

type ExpiryStatus = {
  planName: string;
  expiresAt: string;
  graceEndsAt: string;
  expired: boolean;
  stillOpen: boolean;
  daysLeft: number;
  graceDaysLeft: number | null;
};

/**
 * Renewal banner (Section 8.3).
 *
 * There is no auto-charge, so a student who does nothing simply loses access.
 * The banner is the in-product half of the reminder schedule — it sits above
 * every student page rather than only on My Courses, because the moment that
 * matters is when they are trying to open a lesson.
 *
 * Shown only inside the last week, and loudest during the grace period: that is
 * the window where the student still has everything and can fix it in a minute.
 */
export function ExpiryBanner() {
  const { state } = useAuth();
  const [status, setStatus] = useState<ExpiryStatus | null>(null);

  useEffect(() => {
    if (state.status !== 'signed-in') return;
    void api
      .get<ExpiryStatus | null>('/me/expiry')
      .then(setStatus)
      // A missing banner is better than an error where a banner would go.
      .catch(() => setStatus(null));
  }, [state.status]);

  if (!status) return null;

  const inGrace = status.expired && status.stillOpen;
  const warning = !status.expired && status.daysLeft <= 7;
  if (!inGrace && !warning) return null;

  return (
    <div
      role="status"
      className={`px-4 py-2 text-sm sm:px-6 ${
        inGrace
          ? 'bg-[var(--color-coral-tint)] text-[var(--color-foreground)]'
          : 'bg-[var(--color-yellow-tint)] text-[var(--color-foreground)]'
      }`}
    >
      <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-2">
        <p className="prose-measure">
          {inGrace ? (
            <>
              <span className="font-medium">{status.planName} has ended.</span> You can still open
              your courses for{' '}
              <span className="tabular">{status.graceDaysLeft}</span> more day
              {status.graceDaysLeft === 1 ? '' : 's'} while you renew.
            </>
          ) : (
            <>
              <span className="font-medium">
                {status.planName} ends in <span className="tabular">{status.daysLeft}</span> day
                {status.daysLeft === 1 ? '' : 's'}.
              </span>{' '}
              {/* Said before they ask: the fear is losing the work, not the
                  access. */}
              Your progress and certificates are kept either way.
            </>
          )}
        </p>

        <Link
          href="/plans"
          className="inline-flex min-h-9 shrink-0 items-center rounded-[var(--radius-md)] bg-[var(--color-primary)] px-4 text-sm font-medium text-[var(--color-on-primary)]"
        >
          Renew now
        </Link>
      </div>
    </div>
  );
}
