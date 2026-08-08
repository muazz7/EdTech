'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { ApiClientError, api } from '@/lib/client/api-client';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorNote,
  Field,
  Input,
  Select,
  Skeleton,
  Textarea,
} from '@/components/ui';
import { PlusIcon } from '@/components/icons';

type RosterRow = {
  entitlementId: string;
  studentId: string;
  studentName: string;
  studentPhone: string | null;
  source: 'purchase' | 'manual_grant' | 'promo' | 'migration';
  startsAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
  notes: string | null;
};

type Student = { id: string; fullName: string; phone: string | null };

const SOURCE_LABELS: Record<RosterRow['source'], string> = {
  purchase: 'Paid',
  manual_grant: 'Given by you',
  promo: 'Promo',
  migration: 'Migrated',
};

const REVOKE_REASONS = [
  'Refunded',
  'Payment reversed',
  'Shared their account',
  'Added by mistake',
  'Other',
];

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

/**
 * Who can watch this course, and the controls to change that by hand.
 *
 * Manual grants exist for the case that actually happens in Bangladesh: a
 * student pays cash at the coaching centre. Every grant and revocation is
 * audited, because giving content away for free is exactly the action that
 * needs a permanent record (ADR 0003).
 */
export default function CourseStudentsPage() {
  const params = useParams<{ id: string }>();
  const courseId = params.id;

  const [rows, setRows] = useState<RosterRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [granting, setGranting] = useState(false);
  const [announcement, setAnnouncement] = useState('');

  const load = useCallback(async () => {
    setError(null);
    try {
      setRows(await api.get<RosterRow[]>(`/teacher/courses/${courseId}/students`));
    } catch (err) {
      if (err instanceof ApiClientError && err.status === 404) {
        setError('That course does not exist, or it belongs to another teacher.');
      } else {
        setError(err instanceof Error ? err.message : 'Could not load the student list.');
      }
    }
  }, [courseId]);

  useEffect(() => {
    void load();
  }, [load]);

  const active = rows?.filter((r) => !r.revokedAt) ?? [];
  const revoked = rows?.filter((r) => r.revokedAt) ?? [];

  return (
    <div className="mx-auto max-w-3xl px-4 py-8 sm:px-6">
      <nav aria-label="Breadcrumb" className="text-sm">
        <Link
          href="/teacher"
          className="rounded-[var(--radius-sm)] text-[var(--color-primary)] hover:underline"
        >
          Your courses
        </Link>
        <span className="mx-2 text-[var(--color-muted-foreground)]" aria-hidden="true">
          /
        </span>
        <Link
          href={`/teacher/courses/${courseId}`}
          className="rounded-[var(--radius-sm)] text-[var(--color-primary)] hover:underline"
        >
          Course
        </Link>
        <span className="mx-2 text-[var(--color-muted-foreground)]" aria-hidden="true">
          /
        </span>
        <span className="text-[var(--color-muted-foreground)]">Students</span>
      </nav>

      <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold text-[var(--color-foreground)]">Students</h1>
        <Button variant="primary" onClick={() => setGranting((v) => !v)} aria-expanded={granting}>
          <PlusIcon className="size-4" />
          Give access
        </Button>
      </div>

      {/* Honest about what this list is NOT. A teacher seeing an empty roster
          while all-access subscribers are watching would draw the wrong
          conclusion about their course. */}
      <p className="prose-measure mt-2 text-sm text-[var(--color-muted-foreground)]">
        Students who bought this course directly, or who you gave access to. Anyone on a
        platform-wide plan can also watch and is not listed here.
      </p>

      <p aria-live="polite" className="sr-only">
        {announcement}
      </p>

      {error && (
        <div className="mt-4">
          <ErrorNote onRetry={() => void load()}>{error}</ErrorNote>
        </div>
      )}

      {granting && (
        <GrantForm
          courseId={courseId}
          onCancel={() => setGranting(false)}
          onGranted={async (name) => {
            setGranting(false);
            setAnnouncement(`${name} now has access.`);
            await load();
          }}
        />
      )}

      {rows === null && !error && (
        <div className="mt-6 flex flex-col gap-3">
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-20 w-full" />
          <span className="sr-only" role="status">
            Loading students
          </span>
        </div>
      )}

      {rows && active.length === 0 && !granting && (
        <div className="mt-6">
          <EmptyState
            title="Nobody has bought this course yet"
            body="Approved payments appear here automatically. You can also give access by hand — useful when a student pays you in cash."
            action={
              <Button variant="primary" onClick={() => setGranting(true)}>
                Give access
              </Button>
            }
          />
        </div>
      )}

      {active.length > 0 && (
        <>
          <p className="mt-6 text-sm text-[var(--color-muted-foreground)]">
            <span className="tabular font-medium text-[var(--color-foreground)]">
              {active.length}
            </span>{' '}
            with access
          </p>
          <ul className="mt-3 flex flex-col gap-3">
            {active.map((row) => (
              <RosterCard
                key={row.entitlementId}
                row={row}
                onRevoked={async (name) => {
                  setAnnouncement(`Access removed for ${name}.`);
                  await load();
                }}
              />
            ))}
          </ul>
        </>
      )}

      {revoked.length > 0 && (
        <section className="mt-10">
          <h2 className="text-sm font-semibold text-[var(--color-foreground)]">Access removed</h2>
          <ul className="mt-3 flex flex-col gap-3">
            {revoked.map((row) => (
              <RosterCard key={row.entitlementId} row={row} onRevoked={async () => load()} />
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function RosterCard({
  row,
  onRevoked,
}: {
  row: RosterRow;
  onRevoked: (name: string) => Promise<void>;
}) {
  const [confirming, setConfirming] = useState(false);
  const [reason, setReason] = useState(REVOKE_REASONS[0] ?? 'Other');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function revoke() {
    setBusy(true);
    setError(null);
    try {
      await api.post(`/teacher/access/${row.entitlementId}`, { reason });
      await onRevoked(row.studentName);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not remove access.');
      setBusy(false);
      setConfirming(false);
    }
  }

  return (
    <Card as="li" className="p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-medium text-[var(--color-foreground)]">
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
          <p className="mt-1 text-sm text-[var(--color-muted-foreground)]">
            Since {formatDate(row.startsAt)}
            {row.expiresAt && <> · until {formatDate(row.expiresAt)}</>}
          </p>
          {row.notes && (
            <p className="prose-measure mt-1 text-sm text-[var(--color-muted-foreground)]">
              {row.notes}
            </p>
          )}
        </div>

        <div className="flex flex-col items-end gap-2">
          <Badge tone={row.source === 'purchase' ? 'success' : 'info'}>
            {SOURCE_LABELS[row.source]}
          </Badge>
          {row.revokedAt && <Badge tone="danger">Removed</Badge>}
        </div>
      </div>

      {error && (
        <div className="mt-3">
          <ErrorNote>{error}</ErrorNote>
        </div>
      )}

      {!row.revokedAt && (
        <div className="mt-3">
          {confirming ? (
            <div className="flex flex-col gap-3 rounded-[var(--radius-md)] border border-[var(--color-destructive)] p-3">
              <p className="text-sm text-[var(--color-foreground)]">
                {row.studentName} will lose access to this course straight away. This is recorded.
              </p>

              <Field label="Why?" required>
                {(props) => (
                  <Select {...props} value={reason} onChange={(e) => setReason(e.target.value)}>
                    {REVOKE_REASONS.map((r) => (
                      <option key={r} value={r}>
                        {r}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>

              <div className="flex flex-wrap gap-2">
                <Button size="sm" onClick={() => setConfirming(false)} disabled={busy}>
                  Keep access
                </Button>
                <Button size="sm" variant="danger" loading={busy} onClick={() => void revoke()}>
                  Remove access
                </Button>
              </div>
            </div>
          ) : (
            <Button size="sm" variant="ghost" onClick={() => setConfirming(true)}>
              Remove access
            </Button>
          )}
        </div>
      )}
    </Card>
  );
}

/**
 * Two steps: find the student by their number, then confirm.
 *
 * The confirmation step is not ceremony — granting access to the wrong person
 * because of one wrong digit is silent, and the teacher would only find out
 * when the right student complains.
 */
function GrantForm({
  courseId,
  onCancel,
  onGranted,
}: {
  courseId: string;
  onCancel: () => void;
  onGranted: (name: string) => Promise<void>;
}) {
  const [phone, setPhone] = useState('');
  const [student, setStudent] = useState<Student | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [phoneError, setPhoneError] = useState<string | null>(null);

  async function lookup(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setPhoneError(null);
    setError(null);
    try {
      setStudent(await api.post<Student>('/teacher/students/lookup', { phone }));
    } catch (err) {
      if (err instanceof ApiClientError && (err.status === 404 || err.status === 422)) {
        setPhoneError(err.message);
      } else {
        setError(err instanceof Error ? err.message : 'Could not look up that number.');
      }
    } finally {
      setBusy(false);
    }
  }

  async function grant() {
    if (!student) return;
    setBusy(true);
    setError(null);
    try {
      await api.post('/teacher/access', {
        studentId: student.id,
        courseId,
        note: note || undefined,
      });
      await onGranted(student.fullName);
    } catch (err) {
      setError(
        err instanceof ApiClientError && err.status === 409
          ? 'This student already has access to this course.'
          : err instanceof Error
            ? err.message
            : 'Could not give access.',
      );
      setBusy(false);
    }
  }

  return (
    <Card className="mt-6 p-5">
      <h2 className="text-base font-semibold text-[var(--color-foreground)]">Give access</h2>
      <p className="prose-measure mt-1 text-sm text-[var(--color-muted-foreground)]">
        For a student who paid you outside the app. They need an account already — ask them to sign
        up first.
      </p>

      {!student ? (
        <form onSubmit={lookup} className="mt-4 flex flex-col gap-4" noValidate>
          <Field
            label="Student mobile number"
            hint="The number they signed up with."
            error={phoneError ?? undefined}
            required
          >
            {(props) => (
              <Input
                {...props}
                type="tel"
                inputMode="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="01712345678"
                className="tabular"
                required
              />
            )}
          </Field>

          {error && <ErrorNote>{error}</ErrorNote>}

          <div className="flex flex-wrap gap-2">
            <Button type="submit" variant="primary" loading={busy}>
              Find student
            </Button>
            <Button type="button" onClick={onCancel} disabled={busy}>
              Cancel
            </Button>
          </div>
        </form>
      ) : (
        <div className="mt-4 flex flex-col gap-4">
          <div className="rounded-[var(--radius-md)] bg-[var(--color-surface-sunken)] p-4">
            <p className="text-sm text-[var(--color-muted-foreground)]">Giving access to</p>
            <p className="text-lg font-semibold text-[var(--color-foreground)]">
              {student.fullName || 'Unnamed student'}
            </p>
            <p className="tabular text-sm text-[var(--color-foreground)]">{student.phone}</p>
          </div>

          <Field
            label="Note"
            hint="Why you are giving access. Kept on the record — useful months later."
          >
            {(props) => (
              <Textarea
                {...props}
                value={note}
                onChange={(e) => setNote(e.target.value)}
                rows={2}
                placeholder="Paid 500 BDT cash at the centre on 8 Aug"
              />
            )}
          </Field>

          {error && <ErrorNote>{error}</ErrorNote>}

          <div className="flex flex-wrap gap-2">
            <Button variant="primary" loading={busy} onClick={() => void grant()}>
              Confirm and give access
            </Button>
            <Button
              onClick={() => {
                setStudent(null);
                setNote('');
                setError(null);
              }}
              disabled={busy}
            >
              Different student
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}
