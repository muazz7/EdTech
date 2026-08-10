'use client';

import { useCallback, useEffect, useState } from 'react';
import { formatPoisha } from '@edtech/shared';
import { api } from '@/lib/client/api-client';
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
} from '@/components/ui';
import { Copyable } from '@/components/copyable';
import { PlusIcon } from '@/components/icons';

type PromoCode = {
  id: string;
  code: string;
  courseId: string | null;
  courseTitle: string | null;
  discountPercent: number;
  maxRedemptions: number;
  startsAt: string;
  expiresAt: string | null;
  isActive: boolean;
  note: string | null;
  used: number;
};

type Course = { id: string; title: string; pricePoisha: number };

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

/**
 * Teacher promo codes (ADR 0002).
 *
 * The two things the teacher was promised control of are the two most prominent
 * fields: how many students may use a code, and when it stops working. Both are
 * enforced server-side — the quantity is counted from real payments, and a
 * pending payment holds its slot so a limited code cannot be oversold while
 * proofs are being checked.
 */
function PromoCodesScreen() {
  const [codes, setCodes] = useState<PromoCode[] | null>(null);
  const [courses, setCourses] = useState<Course[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [list, mine] = await Promise.all([
        api.get<PromoCode[]>('/teacher/promo-codes'),
        api.get<Course[]>('/teacher/courses'),
      ]);
      setCodes(list);
      setCourses(mine);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load your promo codes.');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="mx-auto max-w-3xl px-4 py-8 sm:px-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold text-[var(--color-foreground)]">Promo codes</h1>
        <Button onClick={() => setCreating((v) => !v)} aria-expanded={creating}>
          <PlusIcon className="size-4" />
          New code
        </Button>
      </div>

      <p className="prose-measure mt-2 text-sm text-[var(--color-muted-foreground)]">
        Codes discount your own courses only. A code at 100% gives free access, and the student is
        let straight in — there is nothing to transfer and nothing for you to check.
      </p>

      {error && (
        <div className="mt-4">
          <ErrorNote onRetry={() => void load()}>{error}</ErrorNote>
        </div>
      )}

      {creating && (
        <CreateForm
          courses={courses}
          onCancel={() => setCreating(false)}
          onCreated={() => {
            setCreating(false);
            void load();
          }}
        />
      )}

      {codes === null && !error && (
        <div className="mt-6 flex flex-col gap-3">
          <Skeleton className="h-24 w-full" />
          <span className="sr-only" role="status">
            Loading promo codes
          </span>
        </div>
      )}

      {codes?.length === 0 && !creating && (
        <div className="mt-6">
          <EmptyState
            title="No promo codes yet"
            body="Create one to run a discount on your own courses. You set how many students can use it and when it stops."
          />
        </div>
      )}

      {codes && codes.length > 0 && (
        <ul className="mt-6 flex flex-col gap-3">
          {codes.map((code) => (
            <PromoRow key={code.id} promo={code} onChanged={() => void load()} />
          ))}
        </ul>
      )}
    </div>
  );
}

function PromoRow({ promo, onChanged }: { promo: PromoCode; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const expired = promo.expiresAt ? new Date(promo.expiresAt) <= new Date() : false;
  const exhausted = promo.used >= promo.maxRedemptions;
  const live = promo.isActive && !expired && !exhausted;

  async function deactivate() {
    setBusy(true);
    setError(null);
    try {
      await api.del(`/teacher/promo-codes/${promo.id}`);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not switch off that code.');
      setBusy(false);
    }
  }

  return (
    <Card as="li" className="p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <p className="tabular text-lg font-semibold tracking-wider text-[var(--color-foreground)]">
              {promo.code}
            </p>
            {/* Why a code is not working matters more than that it is not:
                "used up" and "expired" need different actions. */}
            {live ? (
              <Badge tone="success">Live</Badge>
            ) : !promo.isActive ? (
              <Badge tone="neutral">Switched off</Badge>
            ) : exhausted ? (
              <Badge tone="warning">Fully used</Badge>
            ) : (
              <Badge tone="neutral">Expired</Badge>
            )}
          </div>

          <p className="mt-1 text-sm text-[var(--color-muted-foreground)]">
            <span className="tabular">{promo.discountPercent}%</span> off ·{' '}
            {promo.courseTitle ?? 'any of your courses'}
          </p>

          <p className="mt-1 text-sm text-[var(--color-muted-foreground)]">
            <span className="tabular">{promo.used}</span> of{' '}
            <span className="tabular">{promo.maxRedemptions}</span> used
            {promo.expiresAt ? <> · ends {formatDate(promo.expiresAt)}</> : <> · no end date</>}
          </p>

          {promo.note && (
            <p className="mt-1 text-sm text-[var(--color-muted-foreground)]">{promo.note}</p>
          )}
        </div>

        {promo.isActive && (
          <Button size="sm" loading={busy} onClick={() => void deactivate()}>
            Switch off
          </Button>
        )}
      </div>

      {live && (
        <div className="mt-3">
          <Copyable value={promo.code} label="Share this code" />
        </div>
      )}

      {error && (
        <div className="mt-3">
          <ErrorNote>{error}</ErrorNote>
        </div>
      )}

      {!promo.isActive && promo.used > 0 && (
        <p className="mt-3 text-sm text-[var(--color-muted-foreground)]">
          Switched off, but the {promo.used} student(s) who already used it keep the price they were
          quoted.
        </p>
      )}
    </Card>
  );
}

function CreateForm({
  courses,
  onCancel,
  onCreated,
}: {
  courses: Course[];
  onCancel: () => void;
  onCreated: () => void;
}) {
  const [code, setCode] = useState('');
  const [courseId, setCourseId] = useState('');
  const [discountPercent, setDiscountPercent] = useState('20');
  const [maxRedemptions, setMaxRedemptions] = useState('50');
  const [expiresAt, setExpiresAt] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const course = courses.find((c) => c.id === courseId);
  const percent = Number(discountPercent);
  const preview =
    course && Number.isFinite(percent) && percent > 0 && percent <= 100
      ? Math.floor((course.pricePoisha * percent) / 100)
      : null;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post('/teacher/promo-codes', {
        ...(code.trim() ? { code: code.trim().toUpperCase() } : {}),
        courseId: courseId || null,
        discountPercent: Number(discountPercent),
        maxRedemptions: Number(maxRedemptions),
        expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
        ...(note.trim() ? { note: note.trim() } : {}),
      });
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create that code.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="mt-4 p-5">
      <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
        <Field
          label="Code"
          hint="Leave empty and one is generated for you, avoiding letters that look like digits."
        >
          {(props) => (
            <Input
              {...props}
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="EID50"
              className="tabular uppercase"
            />
          )}
        </Field>

        <Field label="Applies to">
          {(props) => (
            <Select {...props} value={courseId} onChange={(e) => setCourseId(e.target.value)}>
              <option value="">Any of my courses</option>
              {courses.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.title}
                </option>
              ))}
            </Select>
          )}
        </Field>

        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Discount (%)" hint="100 gives free access.">
            {(props) => (
              <Input
                {...props}
                inputMode="numeric"
                value={discountPercent}
                onChange={(e) => setDiscountPercent(e.target.value)}
                className="tabular"
              />
            )}
          </Field>

          <Field label="How many students" hint="Pending payments hold a slot.">
            {(props) => (
              <Input
                {...props}
                inputMode="numeric"
                value={maxRedemptions}
                onChange={(e) => setMaxRedemptions(e.target.value)}
                className="tabular"
              />
            )}
          </Field>

          <Field label="Ends" hint="Leave empty for no end date.">
            {(props) => (
              <Input
                {...props}
                type="datetime-local"
                value={expiresAt}
                onChange={(e) => setExpiresAt(e.target.value)}
              />
            )}
          </Field>
        </div>

        <Field label="Note to yourself (optional)">
          {(props) => (
            <Input
              {...props}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Eid campaign"
            />
          )}
        </Field>

        {/* What the discount actually costs, before it is live. A percentage is
            abstract; a taka figure is not. */}
        {preview !== null && course && (
          <p className="text-sm text-[var(--color-muted-foreground)]">
            {course.title} is {formatPoisha(course.pricePoisha)} — this takes off{' '}
            <span className="tabular font-medium text-[var(--color-foreground)]">
              {formatPoisha(preview)}
            </span>
            , leaving{' '}
            <span className="tabular font-medium text-[var(--color-foreground)]">
              {formatPoisha(course.pricePoisha - preview)}
            </span>
            {Number(maxRedemptions) > 0 && (
              <>
                . All {maxRedemptions} uses would give away up to{' '}
                <span className="tabular font-medium text-[var(--color-foreground)]">
                  {formatPoisha(preview * Number(maxRedemptions))}
                </span>
              </>
            )}
            .
          </p>
        )}

        {error && <ErrorNote>{error}</ErrorNote>}

        <div className="flex gap-2">
          <Button type="submit" variant="primary" loading={busy}>
            Create code
          </Button>
          <Button type="button" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </form>
    </Card>
  );
}

export default function PromoCodesPage() {
  return <PromoCodesScreen />;
}
