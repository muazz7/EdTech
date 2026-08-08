'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { formatPoisha } from '@edtech/shared';
import { api } from '@/lib/client/api-client';
import { AuthProvider, useAuth } from '@/components/auth-provider';
import { SiteHeader } from '@/components/site-header';
import { Badge, Card, EmptyState, ErrorNote, Skeleton } from '@/components/ui';

type PaymentRow = {
  id: string;
  referenceCode: string;
  amountPoisha: number;
  status: 'pending' | 'verified' | 'rejected' | 'expired';
  channel: string;
  transactionId: string | null;
  rejectionReason: string | null;
  submittedAt: string;
  reviewedAt: string | null;
  courseTitle: string | null;
  planName: string | null;
};

/**
 * Status copy is written to answer the student's actual question — "what do I
 * do now?" — rather than to name the database state. A rejected payment with no
 * next step is the one most likely to become a support message.
 */
const STATUS: Record<
  PaymentRow['status'],
  { tone: 'warning' | 'success' | 'danger' | 'neutral'; label: string; help: string }
> = {
  pending: {
    tone: 'warning',
    label: 'Being checked',
    help: 'Your teacher is checking this. You do not need to send anything again.',
  },
  verified: {
    tone: 'success',
    label: 'Approved',
    help: 'Your access is active. Open the course to start learning.',
  },
  rejected: {
    tone: 'danger',
    label: 'Not accepted',
    help: 'See the reason below. You can start a new payment once it is sorted.',
  },
  expired: {
    tone: 'neutral',
    label: 'Expired',
    help: 'This reference code timed out before a payment arrived. Start again if you still want the course.',
  },
};

function PaymentsScreen() {
  const { state } = useAuth();
  const [rows, setRows] = useState<PaymentRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setRows(await api.get<PaymentRow[]>('/payments'));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load your payments.');
    }
  }, []);

  useEffect(() => {
    if (state.status === 'signed-in') void load();
  }, [state.status, load]);

  if (state.status === 'signed-out') {
    return (
      <div className="mx-auto max-w-md px-4 py-16 sm:px-6">
        <EmptyState
          title="Sign in to see your payments"
          body="Your payment history is tied to your account."
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
      <h1 className="text-2xl font-semibold text-[var(--color-foreground)]">Your payments</h1>

      {error && (
        <div className="mt-4">
          <ErrorNote onRetry={() => void load()}>{error}</ErrorNote>
        </div>
      )}

      {(rows === null || state.status === 'loading') && !error && (
        <div className="mt-6 flex flex-col gap-3">
          <Skeleton className="h-28 w-full" />
          <Skeleton className="h-28 w-full" />
          <span className="sr-only" role="status">
            Loading payments
          </span>
        </div>
      )}

      {rows?.length === 0 && (
        <div className="mt-6">
          <EmptyState
            title="No payments yet"
            body="When you buy a course, its payment appears here with its status."
          />
        </div>
      )}

      {rows && rows.length > 0 && (
        <ul className="mt-6 flex flex-col gap-3">
          {rows.map((row) => {
            const status = STATUS[row.status];
            return (
              <Card as="li" key={row.id} className="p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-medium text-[var(--color-foreground)]">
                      {row.courseTitle ?? row.planName ?? 'Course'}
                    </p>
                    <p className="tabular text-sm text-[var(--color-muted-foreground)]">
                      {row.referenceCode}
                      {row.transactionId && <> · {row.transactionId}</>}
                    </p>
                  </div>

                  <div className="flex flex-col items-end gap-1">
                    <p className="tabular font-semibold text-[var(--color-foreground)]">
                      {formatPoisha(row.amountPoisha)}
                    </p>
                    <Badge tone={status.tone}>{status.label}</Badge>
                  </div>
                </div>

                <p className="mt-2 text-sm text-[var(--color-muted-foreground)]">{status.help}</p>

                {row.status === 'rejected' && row.rejectionReason && (
                  <p className="mt-2 rounded-[var(--radius-md)] bg-[var(--color-surface-sunken)] p-3 text-sm text-[var(--color-foreground)]">
                    {row.rejectionReason}
                  </p>
                )}
              </Card>
            );
          })}
        </ul>
      )}
    </div>
  );
}

export default function AccountPaymentsPage() {
  return (
    <AuthProvider>
      <SiteHeader />
      <PaymentsScreen />
    </AuthProvider>
  );
}
