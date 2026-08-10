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
  Textarea,
} from '@/components/ui';
import { PlusIcon } from '@/components/icons';

type Plan = {
  id: string;
  kind: 'subscription' | 'lifetime_all';
  name: string;
  description: string | null;
  pricePoisha: number;
  durationDays: number | null;
  isActive: boolean;
  displayOrder: number;
  liveSubscribers: number;
  pendingPayments: number;
};

const KIND_LABEL: Record<Plan['kind'], string> = {
  subscription: 'Subscription',
  lifetime_all: 'Lifetime, all courses',
};

/**
 * Platform plans (ADR 0003).
 *
 * These grant access across every teacher's catalog, so they are the Owner's
 * alone — a teacher cannot create one, price one, or collect for one. Payments
 * for a plan go to the Owner's own payment numbers for the same reason.
 */
function PlansScreen() {
  const [plans, setPlans] = useState<Plan[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      setPlans(await api.get<Plan[]>('/admin/plans'));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load the plans.');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 sm:px-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold text-[var(--color-foreground)]">Plans</h1>
        <Button onClick={() => setCreating((v) => !v)} aria-expanded={creating}>
          <PlusIcon className="size-4" />
          New plan
        </Button>
      </div>

      <p className="prose-measure mt-2 text-sm text-[var(--color-muted-foreground)]">
        A plan unlocks every course flagged into all-access, across all teachers. Students pay you
        directly for these, and you verify those payments yourself.
      </p>

      {error && (
        <div className="mt-4">
          <ErrorNote onRetry={() => void load()}>{error}</ErrorNote>
        </div>
      )}

      {creating && (
        <CreateForm
          onCancel={() => setCreating(false)}
          onCreated={() => {
            setCreating(false);
            void load();
          }}
        />
      )}

      {plans === null && !error && (
        <div className="mt-6 flex flex-col gap-3">
          <Skeleton className="h-28 w-full" />
          <span className="sr-only" role="status">
            Loading plans
          </span>
        </div>
      )}

      {plans?.length === 0 && !creating && (
        <div className="mt-6">
          <EmptyState
            title="No plans yet"
            body="Until a plan exists and is switched on, students can only buy individual courses."
          />
        </div>
      )}

      {plans && plans.length > 0 && (
        <ul className="mt-6 flex flex-col gap-4">
          {plans.map((plan) => (
            <PlanRow key={plan.id} plan={plan} onChanged={() => void load()} />
          ))}
        </ul>
      )}
    </div>
  );
}

function PlanRow({ plan, onChanged }: { plan: Plan; onChanged: () => void }) {
  const [priceBdt, setPriceBdt] = useState((plan.pricePoisha / 100).toString());
  const [busy, setBusy] = useState<'price' | 'state' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [confirmingRetire, setConfirmingRetire] = useState(false);

  async function savePrice(event: React.FormEvent) {
    event.preventDefault();
    setBusy('price');
    setError(null);
    setSaved(false);
    try {
      await api.patch(`/admin/plans/${plan.id}`, {
        pricePoisha: Math.round(Number(priceBdt) * 100),
      });
      setSaved(true);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the price.');
    } finally {
      setBusy(null);
    }
  }

  async function toggleActive() {
    setBusy('state');
    setError(null);
    try {
      await api.patch(`/admin/plans/${plan.id}`, { isActive: !plan.isActive });
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not change the plan.');
    } finally {
      setBusy(null);
    }
  }

  async function retire() {
    setBusy('state');
    setError(null);
    try {
      await api.del(`/admin/plans/${plan.id}`);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not retire the plan.');
    } finally {
      setBusy(null);
      setConfirmingRetire(false);
    }
  }

  return (
    <Card as="li" className="p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-base font-semibold text-[var(--color-foreground)]">{plan.name}</h2>
            {plan.isActive ? (
              <Badge tone="success">On sale</Badge>
            ) : (
              <Badge tone="neutral">Not on sale</Badge>
            )}
          </div>
          <p className="text-sm text-[var(--color-muted-foreground)]">
            {KIND_LABEL[plan.kind]}
            {plan.durationDays && (
              <>
                {' · '}
                <span className="tabular">{plan.durationDays}</span> days
              </>
            )}
          </p>
          {plan.description && (
            <p className="prose-measure mt-1 text-sm text-[var(--color-muted-foreground)]">
              {plan.description}
            </p>
          )}
        </div>

        <div className="text-right">
          <p className="tabular text-xl font-semibold text-[var(--color-foreground)]">
            {formatPoisha(plan.pricePoisha)}
          </p>
          <p className="tabular text-sm text-[var(--color-muted-foreground)]">
            {plan.liveSubscribers} active
            {plan.pendingPayments > 0 && <> · {plan.pendingPayments} pending</>}
          </p>
        </div>
      </div>

      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <form onSubmit={savePrice} className="flex flex-col gap-3" noValidate>
          <Field
            label="Price (BDT)"
            hint="Every change is recorded. A student already quoted the old price keeps it."
          >
            {(props) => (
              <Input
                {...props}
                inputMode="decimal"
                value={priceBdt}
                onChange={(e) => {
                  setPriceBdt(e.target.value);
                  setSaved(false);
                }}
                className="tabular"
              />
            )}
          </Field>

          <div className="flex items-center gap-3">
            <Button
              type="submit"
              size="sm"
              loading={busy === 'price'}
              disabled={Math.round(Number(priceBdt) * 100) === plan.pricePoisha}
            >
              Save price
            </Button>
            {saved && (
              <span role="status" className="text-sm text-[var(--color-success)]">
                Saved
              </span>
            )}
          </div>
        </form>

        <div className="flex flex-col gap-3">
          <p className="text-sm text-[var(--color-muted-foreground)]">
            {plan.isActive
              ? 'Students can see and buy this plan now.'
              : 'Hidden from students. Turn it on when the price is right.'}
          </p>

          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant={plan.isActive ? 'secondary' : 'primary'}
              loading={busy === 'state'}
              onClick={() => void toggleActive()}
            >
              {plan.isActive ? 'Take off sale' : 'Put on sale'}
            </Button>

            {plan.isActive && (
              <Button size="sm" onClick={() => setConfirmingRetire(true)}>
                Retire
              </Button>
            )}
          </div>
        </div>
      </div>

      {confirmingRetire && (
        <div className="mt-4 rounded-[var(--radius-md)] bg-[var(--color-surface-sunken)] p-3">
          {/* Retiring deactivates; it never deletes. Students who bought this
              must still be able to see what they paid for. */}
          <p className="prose-measure text-sm text-[var(--color-foreground)]">
            Retiring takes this plan off sale and leaves it in the records.{' '}
            {plan.liveSubscribers > 0 && (
              <>
                The <span className="tabular">{plan.liveSubscribers}</span> student(s) on it keep
                their access until it expires.{' '}
              </>
            )}
            {plan.pendingPayments > 0 && (
              <>
                <span className="tabular">{plan.pendingPayments}</span> payment(s) are still waiting
                for you to check — those students already sent money.
              </>
            )}
          </p>
          <div className="mt-3 flex gap-2">
            <Button size="sm" variant="danger" loading={busy === 'state'} onClick={() => void retire()}>
              Retire plan
            </Button>
            <Button size="sm" onClick={() => setConfirmingRetire(false)}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      {error && (
        <div className="mt-3">
          <ErrorNote>{error}</ErrorNote>
        </div>
      )}
    </Card>
  );
}

function CreateForm({ onCancel, onCreated }: { onCancel: () => void; onCreated: () => void }) {
  const [kind, setKind] = useState<Plan['kind']>('subscription');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [priceBdt, setPriceBdt] = useState('');
  const [durationDays, setDurationDays] = useState('30');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post('/admin/plans', {
        kind,
        name: name.trim(),
        ...(description.trim() ? { description: description.trim() } : {}),
        pricePoisha: Math.round(Number(priceBdt) * 100),
        durationDays: kind === 'subscription' ? Number(durationDays) : null,
        displayOrder: 0,
      });
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create the plan.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="mt-4 p-5">
      <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
        <Field label="Type">
          {(props) => (
            <Select
              {...props}
              value={kind}
              onChange={(e) => setKind(e.target.value as Plan['kind'])}
            >
              <option value="subscription">Subscription — renews, expires</option>
              <option value="lifetime_all">Lifetime — one payment, never expires</option>
            </Select>
          )}
        </Field>

        <Field label="Name" required>
          {(props) => (
            <Input
              {...props}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Monthly All-Access"
            />
          )}
        </Field>

        <Field label="Description" hint="Shown to students on the plans page.">
          {(props) => (
            <Textarea
              {...props}
              rows={2}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          )}
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Price (BDT)" required>
            {(props) => (
              <Input
                {...props}
                inputMode="decimal"
                value={priceBdt}
                onChange={(e) => setPriceBdt(e.target.value)}
                className="tabular"
              />
            )}
          </Field>

          {kind === 'subscription' && (
            <Field label="Length (days)" hint="30 for monthly.">
              {(props) => (
                <Input
                  {...props}
                  inputMode="numeric"
                  value={durationDays}
                  onChange={(e) => setDurationDays(e.target.value)}
                  className="tabular"
                />
              )}
            </Field>
          )}
        </div>

        {/* Created off sale on purpose: a plan goes in front of every student
            the moment it is active. */}
        <p className="text-sm text-[var(--color-muted-foreground)]">
          New plans start off sale. Check the price, then put it on sale.
        </p>

        {error && <ErrorNote>{error}</ErrorNote>}

        <div className="flex gap-2">
          <Button
            type="submit"
            variant="primary"
            loading={busy}
            disabled={!name.trim() || !priceBdt.trim()}
          >
            Create plan
          </Button>
          <Button type="button" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </form>
    </Card>
  );
}

export default function AdminPlansPage() {
  return <PlansScreen />;
}
