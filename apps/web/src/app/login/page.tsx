'use client';

import { Suspense, useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { ApiClientError, api } from '@/lib/client/api-client';
import { AuthProvider, useAuth } from '@/components/auth-provider';
import { Button, Card, ErrorNote, Field, Input } from '@/components/ui';

/**
 * Phone + OTP sign-in (Section 6.1).
 *
 * Phone is primary because Bangladeshi students reliably have a phone number
 * and unreliably have an email they check.
 *
 * Two steps rather than one form: asking for a code before it has been sent is
 * confusing, and a single form cannot show the "code sent to X" confirmation
 * that stops people staring at an empty inbox.
 */

type Step =
  | { name: 'phone' }
  | { name: 'code'; phone: string };

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const { state, adopt } = useAuth();

  const [step, setStep] = useState<Step>({ name: 'phone' });
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const codeRef = useRef<HTMLInputElement>(null);

  // Explains itself when the session ended for a reason the user did not choose
  // — otherwise being bounced to a login screen looks like a bug.
  const reason = params.get('reason');

  useEffect(() => {
    if (state.status === 'signed-in') {
      router.replace(state.me.role === 'student' ? '/' : '/teacher');
    }
  }, [state, router]);

  // Focus moves to the code field once it appears, so a keyboard user is not
  // left tabbing to find it.
  useEffect(() => {
    if (step.name === 'code') codeRef.current?.focus();
  }, [step.name]);

  async function requestCode(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setFieldError(null);

    try {
      await api.post('/auth/otp/request', { phone });
      setStep({ name: 'code', phone });
    } catch (err) {
      if (err instanceof ApiClientError && err.status === 422) {
        setFieldError('Enter a valid Bangladeshi mobile number, e.g. 01712345678.');
      } else if (err instanceof ApiClientError && err.status === 429) {
        const wait = (err.details as { retryAfterSeconds?: number })?.retryAfterSeconds;
        setError(
          wait
            ? `Too many code requests. Try again in about ${Math.ceil(wait / 60)} minute(s).`
            : 'Too many code requests. Wait a few minutes and try again.',
        );
      } else {
        setError(err instanceof Error ? err.message : 'Could not send the code.');
      }
    } finally {
      setBusy(false);
    }
  }

  async function verifyCode(event: React.FormEvent) {
    event.preventDefault();
    if (step.name !== 'code') return;

    setBusy(true);
    setError(null);
    setFieldError(null);

    try {
      const data = await api.post<{ accessToken: string; sessionId: string }>('/auth/otp/verify', {
        phone: step.phone,
        code,
        // No fingerprint: the server derives the web one from an httpOnly
        // cookie plus the UA (Section 6.3), and rejects a client-supplied value.
        device: { platform: 'web' },
      });
      await adopt(data.accessToken, data.sessionId);
    } catch (err) {
      if (err instanceof ApiClientError) {
        if (err.code === 'OTP_INVALID') setFieldError('That code is incorrect. Check the SMS.');
        else if (err.code === 'OTP_EXPIRED') {
          setFieldError('That code expired. Request a new one.');
        } else if (err.code === 'DEVICE_LIMIT_REACHED') {
          setError(err.message);
        } else setError(err.message);
      } else {
        setError('Could not verify the code.');
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto flex min-h-dvh max-w-md flex-col justify-center px-4 py-12 sm:px-6">
      <h1 className="text-2xl font-semibold text-[var(--color-foreground)]">Sign in</h1>
      <p className="mt-1 text-sm text-[var(--color-muted-foreground)]">
        Enter your mobile number and we will text you a code.
      </p>

      {reason === 'revoked' && (
        <div className="mt-4">
          <ErrorNote>
            You were signed out because this account signed in on another device. Only one device can
            be active at a time.
          </ErrorNote>
        </div>
      )}

      <Card className="mt-6 p-5">
        {step.name === 'phone' ? (
          <form onSubmit={requestCode} className="flex flex-col gap-4" noValidate>
            <Field
              label="Mobile number"
              hint="Bangladeshi number, with or without the leading zero."
              error={fieldError ?? undefined}
              required
            >
              {(props) => (
                <Input
                  {...props}
                  // type=tel brings up the numeric keypad; autocomplete lets the
                  // browser and Android fill it from the SIM.
                  type="tel"
                  inputMode="tel"
                  autoComplete="tel"
                  name="phone"
                  placeholder="01712345678"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  required
                />
              )}
            </Field>

            {error && <ErrorNote>{error}</ErrorNote>}

            <Button type="submit" variant="primary" loading={busy}>
              {busy ? 'Sending code' : 'Send code'}
            </Button>
          </form>
        ) : (
          <form onSubmit={verifyCode} className="flex flex-col gap-4" noValidate>
            <p className="text-sm text-[var(--color-muted-foreground)]">
              Code sent to <span className="font-medium text-[var(--color-foreground)]">{phone}</span>
            </p>

            <Field label="Verification code" hint="6 digits." error={fieldError ?? undefined} required>
              {(props) => (
                <Input
                  {...props}
                  ref={codeRef}
                  type="text"
                  inputMode="numeric"
                  // Lets iOS and Android offer the code straight from the SMS.
                  autoComplete="one-time-code"
                  maxLength={6}
                  pattern="\d{6}"
                  name="code"
                  placeholder="123456"
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
                  required
                  className="tabular tracking-[0.3em]"
                />
              )}
            </Field>

            {error && <ErrorNote>{error}</ErrorNote>}

            <Button type="submit" variant="primary" loading={busy}>
              {busy ? 'Verifying' : 'Verify and sign in'}
            </Button>

            {/* Always an escape route out of a multi-step flow. */}
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                setStep({ name: 'phone' });
                setCode('');
                setFieldError(null);
                setError(null);
              }}
            >
              Use a different number
            </Button>
          </form>
        )}
      </Card>
    </div>
  );
}

export default function LoginPage() {
  // useSearchParams needs a Suspense boundary in the App Router.
  return (
    <AuthProvider>
      <Suspense fallback={null}>
        <LoginForm />
      </Suspense>
    </AuthProvider>
  );
}
