'use client';

import { useCallback, useEffect, useState } from 'react';
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

type Channel = 'bkash' | 'nagad' | 'rocket' | 'bank' | 'cash' | 'other';

type PaymentMethod = {
  id: string;
  channel: Channel;
  accountNumber: string;
  accountType: string | null;
  accountLabel: string | null;
  instructions: string | null;
  isActive: boolean;
};

const CHANNEL_LABELS: Record<Channel, string> = {
  bkash: 'bKash',
  nagad: 'Nagad',
  rocket: 'Rocket',
  bank: 'Bank transfer',
  cash: 'Cash',
  other: 'Other',
};

/**
 * Where the teacher's money arrives.
 *
 * Students pay this number directly — nothing routes through the platform
 * (ADR 0003) — so a wrong digit here means a transfer that cannot be recovered.
 * The page is built around that: the number is echoed back in large tabular
 * figures after saving, and nothing is ever deleted.
 */
export default function PaymentMethodsPage() {
  const [methods, setMethods] = useState<PaymentMethod[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      setMethods(await api.get<PaymentMethod[]>('/teacher/payment-methods'));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load your payment numbers.');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const active = methods?.filter((m) => m.isActive) ?? [];
  const inactive = methods?.filter((m) => !m.isActive) ?? [];

  return (
    <div className="mx-auto max-w-3xl px-4 py-8 sm:px-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold text-[var(--color-foreground)]">Payment settings</h1>
        <Button variant="primary" onClick={() => setAdding((v) => !v)} aria-expanded={adding}>
          <PlusIcon className="size-4" />
          Add number
        </Button>
      </div>

      <p className="prose-measure mt-2 text-sm text-[var(--color-muted-foreground)]">
        Students send money straight to these numbers. Check every digit — a transfer to a wrong
        number cannot be reversed.
      </p>

      {error && (
        <div className="mt-4">
          <ErrorNote onRetry={() => void load()}>{error}</ErrorNote>
        </div>
      )}

      {adding && (
        <AddMethodForm
          onCancel={() => setAdding(false)}
          onAdded={async () => {
            setAdding(false);
            await load();
          }}
        />
      )}

      {methods === null && !error && (
        <div className="mt-6 flex flex-col gap-3">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
          <span className="sr-only" role="status">
            Loading payment numbers
          </span>
        </div>
      )}

      {methods && active.length === 0 && !adding && (
        <div className="mt-6">
          <EmptyState
            title="No payment numbers yet"
            body="Students cannot buy your courses until you add at least one bKash, Nagad or Rocket number. Nothing is shown to them until then."
            action={
              <Button variant="primary" onClick={() => setAdding(true)}>
                Add your first number
              </Button>
            }
          />
        </div>
      )}

      {active.length > 0 && (
        <ul className="mt-6 flex flex-col gap-3">
          {active.map((method) => (
            <MethodCard key={method.id} method={method} onChanged={load} />
          ))}
        </ul>
      )}

      {inactive.length > 0 && (
        <section className="mt-10">
          <h2 className="text-sm font-semibold text-[var(--color-foreground)]">Turned off</h2>
          <p className="mt-1 text-sm text-[var(--color-muted-foreground)]">
            Kept so past payments still show which number the student was told to use.
          </p>
          <ul className="mt-3 flex flex-col gap-3">
            {inactive.map((method) => (
              <MethodCard key={method.id} method={method} onChanged={load} />
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function MethodCard({ method, onChanged }: { method: PaymentMethod; onChanged: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function toggle() {
    setBusy(true);
    setError(null);
    try {
      await api.patch(`/teacher/payment-methods/${method.id}`, { isActive: !method.isActive });
      await onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not update this number.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card as="li" className="p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-base font-semibold text-[var(--color-foreground)]">
              {CHANNEL_LABELS[method.channel]}
            </h3>
            {method.accountType && <Badge tone="neutral">{method.accountType}</Badge>}
            {!method.isActive && <Badge tone="warning">Turned off</Badge>}
          </div>

          {/* Tabular and spaced: this is the number a student copies, and
              mis-reading one digit loses the money. */}
          <p className="tabular mt-1 text-lg font-medium tracking-wide text-[var(--color-foreground)]">
            {method.accountNumber}
          </p>

          {method.accountLabel && (
            <p className="text-sm text-[var(--color-muted-foreground)]">{method.accountLabel}</p>
          )}
          {method.instructions && (
            <p className="prose-measure mt-1 text-sm text-[var(--color-muted-foreground)]">
              {method.instructions}
            </p>
          )}
        </div>

        <Button size="sm" loading={busy} onClick={() => void toggle()}>
          {method.isActive ? 'Turn off' : 'Turn back on'}
        </Button>
      </div>

      {error && (
        <div className="mt-3">
          <ErrorNote>{error}</ErrorNote>
        </div>
      )}
    </Card>
  );
}

function AddMethodForm({
  onCancel,
  onAdded,
}: {
  onCancel: () => void;
  onAdded: () => Promise<void>;
}) {
  const [channel, setChannel] = useState<Channel>('bkash');
  const [accountNumber, setAccountNumber] = useState('');
  const [accountType, setAccountType] = useState('Personal');
  const [accountLabel, setAccountLabel] = useState('');
  const [instructions, setInstructions] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [numberError, setNumberError] = useState<string | null>(null);

  const isWallet = channel === 'bkash' || channel === 'nagad' || channel === 'rocket';

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setNumberError(null);

    try {
      await api.post('/teacher/payment-methods', {
        channel,
        accountNumber,
        accountType: accountType || undefined,
        accountLabel: accountLabel || undefined,
        instructions: instructions || undefined,
      });
      await onAdded();
    } catch (err) {
      if (err instanceof ApiClientError && err.status === 422) {
        setNumberError(err.message);
      } else if (err instanceof ApiClientError && err.status === 409) {
        setNumberError('You have already added that number for this channel.');
      } else {
        setError(err instanceof Error ? err.message : 'Could not save this number.');
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="mt-6 p-5">
      <h2 className="text-base font-semibold text-[var(--color-foreground)]">Add a number</h2>

      <form onSubmit={submit} className="mt-4 flex flex-col gap-4" noValidate>
        <Field label="Channel">
          {(props) => (
            <Select
              {...props}
              value={channel}
              onChange={(e) => setChannel(e.target.value as Channel)}
            >
              <option value="bkash">bKash</option>
              <option value="nagad">Nagad</option>
              <option value="rocket">Rocket</option>
              <option value="bank">Bank transfer</option>
              <option value="other">Other</option>
            </Select>
          )}
        </Field>

        <Field
          label={isWallet ? 'Mobile number' : 'Account details'}
          hint={
            isWallet
              ? 'The number students send to. Entered as 01XXXXXXXXX.'
              : 'Account number or details the student needs.'
          }
          error={numberError ?? undefined}
          required
        >
          {(props) => (
            <Input
              {...props}
              type={isWallet ? 'tel' : 'text'}
              inputMode={isWallet ? 'tel' : 'text'}
              value={accountNumber}
              onChange={(e) => setAccountNumber(e.target.value)}
              placeholder={isWallet ? '01712345678' : 'Bank, branch, account number'}
              className="tabular"
              required
            />
          )}
        </Field>

        {isWallet && (
          <Field
            label="Account type"
            hint="bKash charges differ between Personal and Merchant, and students need to pick the right send option."
          >
            {(props) => (
              <Select
                {...props}
                value={accountType}
                onChange={(e) => setAccountType(e.target.value)}
              >
                <option value="Personal">Personal</option>
                <option value="Merchant">Merchant</option>
                <option value="Agent">Agent</option>
              </Select>
            )}
          </Field>
        )}

        <Field label="Account name" hint="Optional. Shown so students can check the name matches.">
          {(props) => (
            <Input
              {...props}
              value={accountLabel}
              onChange={(e) => setAccountLabel(e.target.value)}
              placeholder="Your name as it appears on the account"
            />
          )}
        </Field>

        <Field label="Extra instructions" hint="Optional. Anything else the student should do.">
          {(props) => (
            <Textarea
              {...props}
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
              rows={2}
              placeholder="Use Send Money, not Payment."
            />
          )}
        </Field>

        {error && <ErrorNote>{error}</ErrorNote>}

        <div className="flex flex-wrap gap-2">
          <Button type="submit" variant="primary" loading={busy}>
            Save number
          </Button>
          <Button type="button" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
        </div>
      </form>
    </Card>
  );
}
