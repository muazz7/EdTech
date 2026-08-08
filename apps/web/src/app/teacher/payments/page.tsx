'use client';

import { useCallback, useEffect, useState } from 'react';
import { formatPoisha } from '@edtech/shared';
import { ApiClientError, api } from '@/lib/client/api-client';
import {
  Button,
  Card,
  EmptyState,
  ErrorNote,
  Field,
  Select,
  Skeleton,
  Textarea,
} from '@/components/ui';

type Status = 'pending' | 'verified' | 'rejected' | 'expired';

type QueueRow = {
  id: string;
  referenceCode: string;
  amountPoisha: number;
  channel: string;
  senderNumber: string | null;
  transactionId: string | null;
  proofR2Key: string | null;
  studentNote: string | null;
  submittedAt: string;
  status: Status;
  rejectionReason: string | null;
  studentName: string;
  studentPhone: string | null;
  courseTitle: string | null;
  planName: string | null;
  methodNumber: string | null;
};

const CHANNEL_LABELS: Record<string, string> = {
  bkash: 'bKash',
  nagad: 'Nagad',
  rocket: 'Rocket',
  bank: 'Bank',
  cash: 'Cash',
  other: 'Other',
};

const REJECTION_REASONS = [
  { value: 'wrong_amount', label: 'Wrong amount sent' },
  { value: 'unreadable_proof', label: 'Screenshot unreadable' },
  { value: 'duplicate', label: 'Duplicate submission' },
  { value: 'not_received', label: 'Money not received' },
  { value: 'other', label: 'Other (explain below)' },
] as const;

/** "3 hours ago" beats a timestamp when the question is "who has waited longest". */
function waitedFor(iso: string): string {
  const minutes = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} hr ago`;
  return `${Math.round(hours / 24)} days ago`;
}

/**
 * The payment verification queue (Section 8.2).
 *
 * Built for a phone first, because the spec is blunt about when this actually
 * gets used: at 11pm, from bed. That drives every layout choice here — cards
 * rather than a table, the amount and reference code large enough to check at a
 * glance, and Approve separated from Reject so a half-awake thumb cannot
 * confuse them.
 */
export default function PaymentQueuePage() {
  const [status, setStatus] = useState<Status>('pending');
  const [rows, setRows] = useState<QueueRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState('');

  const load = useCallback(async () => {
    setRows(null);
    setError(null);
    try {
      setRows(await api.get<QueueRow[]>(`/teacher/payments?status=${status}`));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load payments.');
    }
  }, [status]);

  useEffect(() => {
    void load();
  }, [load]);

  function removeRow(id: string, message: string) {
    setRows((current) => current?.filter((r) => r.id !== id) ?? null);
    setAnnouncement(message);
  }

  return (
    <div className="mx-auto max-w-3xl px-4 py-8 sm:px-6">
      <h1 className="text-2xl font-semibold text-[var(--color-foreground)]">Payments</h1>
      <p className="prose-measure mt-2 text-sm text-[var(--color-muted-foreground)]">
        Payments for your own courses. Approving gives the student access immediately.
      </p>

      {/* Announced rather than relying on the row silently vanishing. */}
      <p aria-live="polite" className="sr-only">
        {announcement}
      </p>

      <div className="mt-5 flex gap-1 overflow-x-auto" role="tablist" aria-label="Payment status">
        {(['pending', 'verified', 'rejected'] as const).map((value) => (
          <button
            key={value}
            role="tab"
            aria-selected={status === value}
            onClick={() => setStatus(value)}
            className={`min-h-11 shrink-0 rounded-[var(--radius-md)] px-4 text-sm capitalize transition-colors duration-150 ${
              status === value
                ? 'bg-[var(--color-primary)] font-medium text-[var(--color-on-primary)]'
                : 'text-[var(--color-foreground)] hover:bg-[var(--color-muted)]'
            }`}
          >
            {value}
          </button>
        ))}
      </div>

      {error && (
        <div className="mt-4">
          <ErrorNote onRetry={() => void load()}>{error}</ErrorNote>
        </div>
      )}

      {rows === null && !error && (
        <div className="mt-6 flex flex-col gap-3">
          <Skeleton className="h-48 w-full" />
          <Skeleton className="h-48 w-full" />
          <span className="sr-only" role="status">
            Loading payments
          </span>
        </div>
      )}

      {rows?.length === 0 && (
        <div className="mt-6">
          <EmptyState
            title={status === 'pending' ? 'Nothing waiting' : `No ${status} payments`}
            body={
              status === 'pending'
                ? 'New payments appear here as students submit them. Oldest first, so the student who has waited longest is at the top.'
                : 'Nothing to show for this status yet.'
            }
          />
        </div>
      )}

      {rows && rows.length > 0 && (
        <ul className="mt-6 flex flex-col gap-4">
          {rows.map((row) => (
            <PaymentCard key={row.id} row={row} onResolved={removeRow} />
          ))}
        </ul>
      )}
    </div>
  );
}

function PaymentCard({
  row,
  onResolved,
}: {
  row: QueueRow;
  onResolved: (id: string, message: string) => void;
}) {
  const [busy, setBusy] = useState<'approve' | 'reject' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState<string>('wrong_amount');
  const [note, setNote] = useState('');

  async function approve() {
    setBusy('approve');
    setError(null);
    try {
      await api.post(`/teacher/payments/${row.id}/approve`);
      onResolved(row.id, `Approved ${row.referenceCode}. ${row.studentName} now has access.`);
    } catch (err) {
      setError(
        err instanceof ApiClientError && err.code === 'PAYMENT_NOT_PENDING'
          ? 'This payment was already reviewed. Refresh to see its current state.'
          : err instanceof Error
            ? err.message
            : 'Could not approve this payment.',
      );
      setBusy(null);
    }
  }

  async function reject() {
    setBusy('reject');
    setError(null);
    try {
      await api.post(`/teacher/payments/${row.id}/reject`, { reason, note: note || undefined });
      onResolved(row.id, `Rejected ${row.referenceCode}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not reject this payment.');
      setBusy(null);
    }
  }

  return (
    <Card as="li" className="p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-base font-semibold text-[var(--color-foreground)]">
            {row.studentName || 'Unnamed student'}
          </p>
          {row.studentPhone && (
            <a
              href={`tel:${row.studentPhone}`}
              className="tabular text-sm text-[var(--color-primary)]"
            >
              {row.studentPhone}
            </a>
          )}
        </div>

        {/* The number being checked against the wallet SMS. Largest thing on
            the card for that reason. */}
        <p className="tabular text-xl font-semibold text-[var(--color-foreground)]">
          {formatPoisha(row.amountPoisha)}
        </p>
      </div>

      <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="text-[var(--color-muted-foreground)]">For</dt>
        <dd className="text-[var(--color-foreground)]">
          {row.courseTitle ?? row.planName ?? 'Unknown'}
        </dd>

        <dt className="text-[var(--color-muted-foreground)]">Reference</dt>
        {/* The reconciliation key: this is what the student put in the wallet's
            reference field. */}
        <dd className="tabular font-medium text-[var(--color-foreground)]">{row.referenceCode}</dd>

        <dt className="text-[var(--color-muted-foreground)]">Channel</dt>
        <dd className="text-[var(--color-foreground)]">
          {CHANNEL_LABELS[row.channel] ?? row.channel}
          {row.methodNumber && (
            <span className="tabular text-[var(--color-muted-foreground)]"> to {row.methodNumber}</span>
          )}
        </dd>

        {row.senderNumber && (
          <>
            <dt className="text-[var(--color-muted-foreground)]">Sent from</dt>
            <dd className="tabular text-[var(--color-foreground)]">{row.senderNumber}</dd>
          </>
        )}

        {row.transactionId && (
          <>
            <dt className="text-[var(--color-muted-foreground)]">Trx ID</dt>
            <dd className="tabular font-medium text-[var(--color-foreground)]">
              {row.transactionId}
            </dd>
          </>
        )}

        <dt className="text-[var(--color-muted-foreground)]">Waiting</dt>
        <dd className="text-[var(--color-foreground)]">{waitedFor(row.submittedAt)}</dd>
      </dl>

      {row.studentNote && (
        <p className="prose-measure mt-3 rounded-[var(--radius-md)] bg-[var(--color-surface-sunken)] p-3 text-sm text-[var(--color-foreground)]">
          {row.studentNote}
        </p>
      )}

      {row.proofR2Key && <ProofImage paymentId={row.id} />}

      {row.status === 'rejected' && row.rejectionReason && (
        <p className="mt-3 text-sm text-[var(--color-muted-foreground)]">
          Rejected: {row.rejectionReason}
        </p>
      )}

      {error && (
        <div className="mt-3">
          <ErrorNote>{error}</ErrorNote>
        </div>
      )}

      {row.status === 'pending' && (
        <div className="mt-4">
          {rejecting ? (
            <div className="flex flex-col gap-3 rounded-[var(--radius-md)] border border-[var(--color-destructive)] p-3">
              <Field label="Why is this being rejected?" required>
                {(props) => (
                  <Select {...props} value={reason} onChange={(e) => setReason(e.target.value)}>
                    {REJECTION_REASONS.map((r) => (
                      <option key={r.value} value={r.value}>
                        {r.label}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>

              <Field
                label="Note to the student"
                hint={
                  reason === 'other'
                    ? 'Required. The student sees this, so say what they should do next.'
                    : 'Optional. The student sees this.'
                }
                required={reason === 'other'}
              >
                {(props) => (
                  <Textarea
                    {...props}
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    rows={2}
                    placeholder="Send the remaining 200 BDT and submit again."
                  />
                )}
              </Field>

              <div className="flex flex-wrap gap-2">
                <Button size="sm" onClick={() => setRejecting(false)} disabled={busy !== null}>
                  Cancel
                </Button>
                <Button
                  size="sm"
                  variant="danger"
                  loading={busy === 'reject'}
                  disabled={reason === 'other' && !note.trim()}
                  onClick={() => void reject()}
                >
                  Confirm rejection
                </Button>
              </div>
            </div>
          ) : (
            /* Approve is the primary action and sits alone on its own row.
               Reject is below and visually quieter — on a phone at 11pm these
               must not be adjacent targets. */
            <div className="flex flex-col gap-2">
              <Button
                variant="primary"
                loading={busy === 'approve'}
                disabled={!row.transactionId}
                onClick={() => void approve()}
              >
                Approve and give access
              </Button>

              {!row.transactionId && (
                <p className="text-sm text-[var(--color-muted-foreground)]">
                  This student has not submitted their transaction details yet.
                </p>
              )}

              <Button size="sm" variant="ghost" onClick={() => setRejecting(true)}>
                Reject
              </Button>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

/**
 * The proof screenshot.
 *
 * Fetched on demand, not with the queue: a signed URL shipped with the list
 * would stay valid for every row the teacher never opened, and these images
 * carry a student's name, number and account balance.
 */
function ProofImage({ paymentId }: { paymentId: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function show() {
    setOpen(true);
    if (url) return;
    setLoading(true);
    setError(null);
    try {
      const grant = await api.get<{ url: string }>(`/teacher/payments/${paymentId}/proof`);
      setUrl(grant.url);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load the screenshot.');
    } finally {
      setLoading(false);
    }
  }

  if (!open) {
    return (
      <Button size="sm" className="mt-3" onClick={() => void show()}>
        View screenshot
      </Button>
    );
  }

  return (
    <div className="mt-3">
      {loading && <Skeleton className="h-64 w-full" />}
      {error && <ErrorNote>{error}</ErrorNote>}
      {url && (
        // A plain <img>, not next/image: a presigned R2 URL cannot go through
        // the Next image optimiser, and proxying a student's payment proof
        // through our own server would defeat the point of presigning it.
        <img
          src={url}
          alt="Payment screenshot submitted by the student"
          className="max-h-[70vh] w-full rounded-[var(--radius-md)] object-contain"
        />
      )}
      <Button size="sm" variant="ghost" className="mt-2" onClick={() => setOpen(false)}>
        Hide screenshot
      </Button>
    </div>
  );
}
