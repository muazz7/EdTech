'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams, useSearchParams } from 'next/navigation';
import { formatPoisha } from '@edtech/shared';
import { ApiClientError, api } from '@/lib/client/api-client';
import { uploadPaymentProof } from '@/lib/client/uploads';
import { AuthProvider, useAuth } from '@/components/auth-provider';
import { Copyable } from '@/components/copyable';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorNote,
  Field,
  Input,
  ProgressBar,
  Select,
  Skeleton,
  Textarea,
} from '@/components/ui';

type Method = {
  id: string;
  channel: string;
  accountNumber: string;
  accountType: string | null;
  accountLabel: string | null;
  instructions: string | null;
};

type Intent = {
  paymentId: string;
  referenceCode: string;
  amountPoisha: number;
  originalPoisha: number;
  discountPoisha: number;
  promoCode: string | null;
  currency: string;
  target: { kind: string; title: string };
  methods: Method[];
  verificationSlaHours: number;
  expiresInDays: number;
  /** A promo code covered the whole price: access is already granted and there
   *  is nothing to transfer. */
  settled: boolean;
};

const CHANNEL_LABELS: Record<string, string> = {
  bkash: 'bKash',
  nagad: 'Nagad',
  rocket: 'Rocket',
  bank: 'Bank transfer',
  cash: 'Cash',
  other: 'Other',
};

type Step = 'instructions' | 'submit' | 'done';

/**
 * Manual payment, student side (Section 8.1).
 *
 * This is where sales are lost, so the whole screen is built around removing
 * reasons to abandon: the reference code exists before any money moves, every
 * value the student must retype is one tap to copy, and the wait is stated as a
 * number of hours rather than left open-ended.
 */
function PurchaseScreen() {
  const params = useParams<{ courseId: string }>();
  const searchParams = useSearchParams();
  const { state } = useAuth();

  /**
   * A plan purchase reuses this screen: the instructions, the reference code
   * and the proof upload are identical, and only the target differs. It arrives
   * as `/purchase/plan?planId=<uuid>` — the literal segment "plan" in place of a
   * course id, which is never a valid uuid, so the two cannot be confused.
   */
  const planId = params.courseId === 'plan' ? searchParams.get('planId') : null;

  const [intent, setIntent] = useState<Intent | null>(null);
  // Held here rather than inside the instructions step: the submission has to
  // record WHICH number the student was told to pay, or the teacher's queue
  // cannot show what to check the transfer against.
  const [methodId, setMethodId] = useState<string | null>(null);
  const [step, setStep] = useState<Step>('instructions');
  const [error, setError] = useState<string | null>(null);
  const [blocked, setBlocked] = useState<string | null>(null);

  const load = useCallback(async (promoCode?: string) => {
    setError(null);
    setBlocked(null);
    try {
      // Reuses an existing pending intent rather than minting a second
      // reference code, so a reload never leaves the student holding two.
      setIntent(
        await api.post<Intent>('/payments/intent', {
          ...(planId ? { planId } : { courseId: params.courseId }),
          // Promo codes are a teacher discounting their own course; the server
          // refuses one against a platform-wide plan.
          ...(promoCode && !planId ? { promoCode } : {}),
        }),
      );
    } catch (err) {
      if (err instanceof ApiClientError && (err.status === 409 || err.status === 422)) {
        setBlocked(err.message);
      } else if (err instanceof ApiClientError && err.status === 503) {
        setBlocked(err.message);
      } else {
        setError(err instanceof Error ? err.message : 'Could not start this purchase.');
      }
    }
  }, [params.courseId, planId]);

  useEffect(() => {
    if (state.status === 'signed-in') void load();
  }, [state.status, load]);

  if (state.status === 'loading') {
    return (
      <div className="mx-auto max-w-xl px-4 py-10 sm:px-6">
        <Skeleton className="h-9 w-64" />
        <Skeleton className="mt-4 h-64 w-full" />
      </div>
    );
  }

  if (state.status === 'signed-out') {
    return (
      <div className="mx-auto max-w-md px-4 py-16 sm:px-6">
        <EmptyState
          title="Sign in to buy this course"
          body="You need an account so we can give you access once your payment is checked."
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
    <div className="mx-auto max-w-xl px-4 py-8 sm:px-6">
      <h1 className="text-2xl font-semibold text-[var(--color-foreground)]">
        {planId ? 'Buy this plan' : 'Buy this course'}
      </h1>

      {error && (
        <div className="mt-4">
          <ErrorNote onRetry={() => void load()}>{error}</ErrorNote>
        </div>
      )}

      {blocked && (
        <Card className="mt-4 p-5">
          <p className="text-[var(--color-foreground)]">{blocked}</p>
          <Link
            href="/account/payments"
            className="mt-3 inline-flex min-h-11 items-center text-sm font-medium text-[var(--color-primary)]"
          >
            See your payments
          </Link>
        </Card>
      )}

      {!intent && !error && !blocked && (
        <div className="mt-6 flex flex-col gap-3">
          <Skeleton className="h-40 w-full" />
          <span className="sr-only" role="status">
            Preparing your payment details
          </span>
        </div>
      )}

      {/* A code that covers the whole price has nothing to transfer and nothing
          to prove, so the instructions flow would be theatre. */}
      {intent?.settled && (
        <Card className="mt-4 p-6 text-center">
          <p className="text-lg font-semibold text-[var(--color-success)]">
            Your code covered the full price
          </p>
          <p className="prose-measure mx-auto mt-2 text-sm text-[var(--color-muted-foreground)]">
            Access to {intent.target.title} is already open. Nothing to pay.
          </p>
          <Link
            href="/my-courses"
            className="mt-4 inline-flex min-h-11 items-center rounded-[var(--radius-md)] bg-[var(--color-primary)] px-5 text-sm font-medium text-[var(--color-on-primary)]"
          >
            Start learning
          </Link>
        </Card>
      )}

      {intent && !intent.settled && step === 'instructions' && (
        <>
          <PromoField
            applied={intent.promoCode}
            discountPoisha={intent.discountPoisha}
            onApply={(code) => void load(code)}
          />
          <Instructions
            intent={intent}
            onContinue={(chosen) => {
              setMethodId(chosen);
              setStep('submit');
            }}
          />
        </>
      )}

      {intent && !intent.settled && step === 'submit' && (
        <SubmitForm
          intent={intent}
          methodId={methodId}
          onBack={() => setStep('instructions')}
          onSubmitted={() => setStep('done')}
        />
      )}

      {intent && step === 'done' && <PendingConfirmation intent={intent} />}
    </div>
  );
}

/**
 * Promo code entry.
 *
 * Applying re-creates the intent rather than patching the amount, because the
 * discount and the slot reservation both belong to the payment row. The server
 * reserves the code under a row lock at that moment — what the student sees
 * here is the result, not a promise.
 */
function PromoField({
  applied,
  discountPoisha,
  onApply,
}: {
  applied: string | null;
  discountPoisha: number;
  onApply: (code: string) => void;
}) {
  const [code, setCode] = useState('');
  const [open, setOpen] = useState(false);

  if (discountPoisha > 0) {
    return (
      <Card className="mt-4 flex flex-wrap items-center justify-between gap-2 p-4">
        <p className="text-sm text-[var(--color-foreground)]">
          Code {applied && <span className="tabular font-semibold">{applied}</span>} applied —{' '}
          <span className="tabular font-semibold text-[var(--color-success)]">
            {formatPoisha(discountPoisha)} off
          </span>
        </p>
      </Card>
    );
  }

  return (
    <div className="mt-4">
      {open ? (
        <Card className="p-4">
          <Field label="Promo code" hint="From your teacher. Case does not matter.">
            {(props) => (
              <Input
                {...props}
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder="EID50"
                className="tabular uppercase"
                autoCapitalize="characters"
              />
            )}
          </Field>
          <div className="mt-3 flex gap-2">
            <Button
              size="sm"
              variant="primary"
              disabled={code.trim().length < 4}
              onClick={() => onApply(code.trim().toUpperCase())}
            >
              Apply
            </Button>
            <Button size="sm" onClick={() => setOpen(false)}>
              Cancel
            </Button>
          </div>
        </Card>
      ) : (
        <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>
          Have a promo code?
        </Button>
      )}
    </div>
  );
}

function Instructions({
  intent,
  onContinue,
}: {
  intent: Intent;
  onContinue: (methodId: string | null) => void;
}) {
  const [selected, setSelected] = useState(intent.methods[0]?.id ?? '');
  const method = intent.methods.find((m) => m.id === selected) ?? intent.methods[0];

  return (
    <div className="mt-5 flex flex-col gap-5">
      <Card className="p-5">
        <p className="text-sm text-[var(--color-muted-foreground)]">{intent.target.title}</p>
        <p className="tabular mt-1 text-3xl font-semibold text-[var(--color-foreground)]">
          {formatPoisha(intent.amountPoisha)}
        </p>
        <p className="mt-2 text-sm text-[var(--color-muted-foreground)]">
          Send exactly this amount. A different amount has to be rejected and sent again.
        </p>
      </Card>

      {intent.methods.length > 1 && (
        <Field label="Pay with">
          {(props) => (
            <Select {...props} value={selected} onChange={(e) => setSelected(e.target.value)}>
              {intent.methods.map((m) => (
                <option key={m.id} value={m.id}>
                  {CHANNEL_LABELS[m.channel] ?? m.channel} — {m.accountNumber}
                </option>
              ))}
            </Select>
          )}
        </Field>
      )}

      {method && (
        <Card className="flex flex-col gap-4 p-5">
          <h2 className="text-base font-semibold text-[var(--color-foreground)]">
            Steps for {CHANNEL_LABELS[method.channel] ?? method.channel}
          </h2>

          <ol className="flex flex-col gap-4">
            <li className="flex flex-col gap-2">
              <p className="text-sm text-[var(--color-foreground)]">
                <span className="font-medium">1.</span> Open{' '}
                {CHANNEL_LABELS[method.channel] ?? method.channel} and choose{' '}
                <span className="font-medium">
                  {method.accountType === 'Merchant' ? 'Payment' : 'Send Money'}
                </span>
                .
              </p>
              {method.instructions && (
                <p className="text-sm text-[var(--color-muted-foreground)]">
                  {method.instructions}
                </p>
              )}
            </li>

            <li className="flex flex-col gap-2">
              <p className="text-sm text-[var(--color-foreground)]">
                <span className="font-medium">2.</span> Send to this number
                {method.accountLabel && (
                  <span className="text-[var(--color-muted-foreground)]">
                    {' '}
                    ({method.accountLabel})
                  </span>
                )}
                :
              </p>
              <Copyable value={method.accountNumber} label="Number to send to" size="lg" />
            </li>

            <li className="flex flex-col gap-2">
              <p className="text-sm text-[var(--color-foreground)]">
                <span className="font-medium">3.</span> Send exactly:
              </p>
              <Copyable
                value={(intent.amountPoisha / 100).toString()}
                label="Amount in BDT"
                size="lg"
              />
            </li>

            <li className="flex flex-col gap-2">
              <p className="text-sm text-[var(--color-foreground)]">
                <span className="font-medium">4.</span> Put this code in the{' '}
                <span className="font-medium">reference</span> field:
              </p>
              <Copyable value={intent.referenceCode} label="Reference code" size="lg" />
              {/* This is what lets the teacher match the transfer to this
                  student without guessing from amounts and timestamps. */}
              <p className="text-sm text-[var(--color-muted-foreground)]">
                This is how your teacher finds your payment. If your app has no reference field,
                skip it — the transaction ID on the next screen is enough.
              </p>
            </li>

            <li>
              <p className="text-sm text-[var(--color-foreground)]">
                <span className="font-medium">5.</span> Take a screenshot of the confirmation. You
                will need the transaction ID from it.
              </p>
            </li>
          </ol>
        </Card>
      )}

      <Button variant="primary" onClick={() => onContinue(method?.id ?? null)}>
        I have sent the money
      </Button>

      <p className="text-sm text-[var(--color-muted-foreground)]">
        Your reference code stays valid for {intent.expiresInDays} days. You can leave and come back
        — it will be here.
      </p>
    </div>
  );
}

function SubmitForm({
  intent,
  methodId,
  onBack,
  onSubmitted,
}: {
  intent: Intent;
  methodId: string | null;
  onBack: () => void;
  onSubmitted: () => void;
}) {
  const [channel, setChannel] = useState(
    intent.methods.find((m) => m.id === methodId)?.channel ?? intent.methods[0]?.channel ?? 'bkash',
  );
  const [senderNumber, setSenderNumber] = useState('');
  const [transactionId, setTransactionId] = useState('');
  const [note, setNote] = useState('');
  const [proofKey, setProofKey] = useState<string | null>(null);
  const [uploadPercent, setUploadPercent] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  async function pickProof(file: File) {
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
      setFieldErrors((e) => ({ ...e, proof: 'Choose a JPEG, PNG or WebP image.' }));
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      setFieldErrors((e) => ({
        ...e,
        proof: `That image is ${(file.size / 1024 / 1024).toFixed(1)} MB. The limit is 5 MB.`,
      }));
      return;
    }

    setFieldErrors((e) => ({ ...e, proof: '' }));
    setUploadPercent(0);
    try {
      setProofKey(await uploadPaymentProof(file, setUploadPercent));
    } catch (err) {
      setFieldErrors((e) => ({
        ...e,
        proof: err instanceof Error ? err.message : 'Could not upload the screenshot.',
      }));
    } finally {
      setUploadPercent(null);
    }
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setFieldErrors({});

    try {
      await api.post('/payments', {
        referenceCode: intent.referenceCode,
        channel,
        senderNumber,
        transactionId,
        // Records which of the teacher's numbers the student was shown, so the
        // queue can display what the transfer should be checked against.
        paymentMethodId: methodId ?? undefined,
        proofKey: proofKey ?? undefined,
        studentNote: note || undefined,
      });
      onSubmitted();
    } catch (err) {
      if (err instanceof ApiClientError) {
        if (err.code === 'DUPLICATE_TRANSACTION_ID') {
          setFieldErrors({
            transactionId:
              'This transaction ID has already been submitted. If this is your payment, contact your teacher rather than sending again.',
          });
        } else if (err.status === 422) {
          const details = err.details as Record<string, string[]> | undefined;
          setFieldErrors({
            senderNumber: details?.senderNumber?.[0] ?? '',
            transactionId: details?.transactionId?.[0] ?? '',
          });
          if (!details) setError(err.message);
        } else {
          setError(err.message);
        }
      } else {
        setError('Could not submit your payment.');
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="mt-5 flex flex-col gap-5" noValidate>
      <Card className="p-5">
        <p className="text-sm text-[var(--color-muted-foreground)]">Reference code</p>
        <p className="tabular text-lg font-semibold text-[var(--color-foreground)]">
          {intent.referenceCode}
        </p>
      </Card>

      <Field label="Which app did you send from?">
        {(props) => (
          <Select {...props} value={channel} onChange={(e) => setChannel(e.target.value)}>
            <option value="bkash">bKash</option>
            <option value="nagad">Nagad</option>
            <option value="rocket">Rocket</option>
            <option value="bank">Bank transfer</option>
            <option value="other">Other</option>
          </Select>
        )}
      </Field>

      <Field
        label="Your number"
        hint="The number you sent the money from."
        error={fieldErrors.senderNumber || undefined}
        required
      >
        {(props) => (
          <Input
            {...props}
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            value={senderNumber}
            onChange={(e) => setSenderNumber(e.target.value)}
            placeholder="01712345678"
            className="tabular"
            required
          />
        )}
      </Field>

      <Field
        label="Transaction ID"
        hint="On the confirmation SMS or screen. bKash IDs are 10 letters and numbers."
        error={fieldErrors.transactionId || undefined}
        required
      >
        {(props) => (
          <Input
            {...props}
            value={transactionId}
            // Upper-cased and stripped as typed: wallet IDs are upper-case, and
            // a lower-case paste would otherwise look like a mismatch to the
            // teacher comparing it against their SMS.
            onChange={(e) => setTransactionId(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))}
            placeholder="8FK2QX9L1M"
            maxLength={20}
            className="tabular tracking-wider"
            required
          />
        )}
      </Field>

      <Field
        label="Screenshot of the confirmation"
        hint="Strongly recommended. Without it your teacher may not be able to confirm the payment."
        error={fieldErrors.proof || undefined}
      >
        {() => (
          <div className="flex flex-col gap-2">
            <label className="inline-flex w-fit min-h-11 cursor-pointer items-center rounded-[var(--radius-md)] border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-4 text-sm font-medium text-[var(--color-foreground)] transition-colors duration-150 hover:bg-[var(--color-cyan-tint)] focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-[var(--color-ring)]">
              {proofKey ? 'Choose a different image' : 'Choose image'}
              <input
                type="file"
                accept="image/jpeg,image/png,image/webp"
                className="sr-only"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) void pickProof(file);
                  e.target.value = '';
                }}
              />
            </label>

            {uploadPercent !== null && (
              <ProgressBar value={uploadPercent} label="Uploading screenshot" />
            )}
            {proofKey && uploadPercent === null && (
              <Badge tone="success">Screenshot attached</Badge>
            )}
          </div>
        )}
      </Field>

      <Field label="Anything else?" hint="Optional.">
        {(props) => (
          <Textarea {...props} value={note} onChange={(e) => setNote(e.target.value)} rows={2} />
        )}
      </Field>

      {error && <ErrorNote>{error}</ErrorNote>}

      <div className="flex flex-col gap-2">
        <Button type="submit" variant="primary" loading={busy}>
          Submit for checking
        </Button>
        <Button type="button" variant="ghost" onClick={onBack} disabled={busy}>
          Back to the payment steps
        </Button>
      </div>
    </form>
  );
}

/**
 * Section 8.1 is specific that the pending screen must set an expectation.
 * "We will check it soon" is what makes a student message a teacher twice.
 */
function PendingConfirmation({ intent }: { intent: Intent }) {
  return (
    <div className="mt-6 flex flex-col gap-4">
      <Card className="flex flex-col items-center gap-3 p-8 text-center">
        <Badge tone="warning">Waiting to be checked</Badge>
        <h2 className="text-lg font-semibold text-[var(--color-foreground)]">
          Payment submitted
        </h2>
        <p className="prose-measure text-sm text-[var(--color-muted-foreground)]">
          Your teacher usually checks payments within {intent.verificationSlaHours} hours. You will
          get a message when your access is ready. You do not need to send anything again.
        </p>
        <p className="tabular text-sm text-[var(--color-muted-foreground)]">
          Reference {intent.referenceCode}
        </p>
      </Card>

      <Link
        href="/account/payments"
        className="inline-flex min-h-11 items-center justify-center rounded-[var(--radius-md)] border border-[var(--color-border-strong)] px-4 text-sm font-medium text-[var(--color-foreground)]"
      >
        Check the status of your payments
      </Link>
    </div>
  );
}

export default function PurchasePage() {
  return (
    <AuthProvider>
      <PurchaseScreen />
    </AuthProvider>
  );
}
