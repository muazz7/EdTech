'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { formatPoisha } from '@edtech/shared';
import { api } from '@/lib/client/api-client';
import { AuthProvider, useAuth } from '@/components/auth-provider';
import { SiteHeader } from '@/components/site-header';
import { Badge, Button, Card, EmptyState, ErrorNote, Skeleton } from '@/components/ui';
import { CheckCircleIcon } from '@/components/icons';

type Plan = {
  id: string;
  kind: 'subscription' | 'lifetime_all';
  name: string;
  description: string | null;
  pricePoisha: number;
  durationDays: number | null;
};

type Entitlement = { kind: string; expiresAt: string | null; revokedAt: string | null };

/**
 * All-access plans (Section 8).
 *
 * A plan unlocks every course flagged into all-access, across teachers, which
 * is why the payment goes to the platform Owner rather than to any one teacher
 * (ADR 0003). Promo codes do not apply here — a teacher's code cannot discount
 * other teachers' catalogs.
 */
function PlansScreen() {
  const { state } = useAuth();
  const router = useRouter();

  const [plans, setPlans] = useState<Plan[] | null>(null);
  const [held, setHeld] = useState<Entitlement[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setPlans(await api.get<Plan[]>('/plans'));
      if (state.status === 'signed-in') {
        setHeld(await api.get<Entitlement[]>('/me/entitlements').catch(() => []));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load the plans.');
    }
  }, [state.status]);

  useEffect(() => {
    if (state.status !== 'loading') void load();
  }, [state.status, load]);

  const hasAllAccess = held.some(
    (e) =>
      (e.kind === 'lifetime_all' || e.kind === 'subscription') &&
      !e.revokedAt &&
      (!e.expiresAt || new Date(e.expiresAt) > new Date()),
  );

  async function buy(plan: Plan) {
    if (state.status !== 'signed-in') {
      router.push('/login');
      return;
    }

    // The purchase screen creates the intent itself, so this only navigates —
    // creating one here as well would mint a second reference code on a
    // double tap.
    setBusyId(plan.id);
    router.push(`/purchase/plan?planId=${plan.id}`);
  }

  return (
    <div className="mx-auto max-w-3xl px-4 py-8 sm:px-6">
      <h1 className="text-2xl font-semibold text-[var(--color-foreground)]">All-access plans</h1>
      <p className="prose-measure mt-2 text-sm text-[var(--color-muted-foreground)]">
        One payment unlocks every course in the all-access catalog, from every teacher. Individual
        courses can still be bought on their own.
      </p>

      {error && (
        <div className="mt-4">
          <ErrorNote onRetry={() => void load()}>{error}</ErrorNote>
        </div>
      )}

      {hasAllAccess && (
        <Card className="mt-4 flex items-center gap-3 p-4">
          <CheckCircleIcon className="size-5 shrink-0 text-[var(--color-success)]" />
          <p className="text-sm text-[var(--color-foreground)]">
            You already have all-access.{' '}
            <Link href="/my-courses" className="text-[var(--color-primary)] hover:underline">
              Go to your courses
            </Link>
            .
          </p>
        </Card>
      )}

      {plans === null && !error && (
        <div className="mt-6 flex flex-col gap-3">
          <Skeleton className="h-32 w-full" />
          <span className="sr-only" role="status">
            Loading plans
          </span>
        </div>
      )}

      {plans?.length === 0 && (
        <div className="mt-6">
          <EmptyState
            title="No plans on sale right now"
            body="Individual courses are still available."
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

      {plans && plans.length > 0 && (
        <ul className="mt-6 flex flex-col gap-4">
          {plans.map((plan) => (
            <Card as="li" key={plan.id} className="p-5">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="text-lg font-semibold text-[var(--color-foreground)]">
                      {plan.name}
                    </h2>
                    {plan.kind === 'lifetime_all' && <Badge tone="info">Never expires</Badge>}
                  </div>

                  {plan.description && (
                    <p className="prose-measure mt-1 text-sm text-[var(--color-muted-foreground)]">
                      {plan.description}
                    </p>
                  )}

                  <p className="mt-2 text-sm text-[var(--color-muted-foreground)]">
                    {plan.durationDays ? (
                      <>
                        Access for <span className="tabular">{plan.durationDays}</span> days, then
                        renew.
                      </>
                    ) : (
                      'One payment, access for good.'
                    )}
                  </p>
                </div>

                <div className="flex shrink-0 flex-col items-end gap-2">
                  <p className="tabular text-2xl font-semibold text-[var(--color-foreground)]">
                    {formatPoisha(plan.pricePoisha)}
                  </p>
                  <Button
                    variant="primary"
                    loading={busyId === plan.id}
                    disabled={hasAllAccess}
                    onClick={() => void buy(plan)}
                  >
                    {hasAllAccess ? 'Already yours' : 'Choose this plan'}
                  </Button>
                </div>
              </div>
            </Card>
          ))}
        </ul>
      )}

      {/* Section 8.3: subscription access ends when it lapses, and the spec is
          explicit that progress and certificates persist. Saying so before the
          purchase is cheaper than saying it after. */}
      {plans && plans.some((p) => p.kind === 'subscription') && (
        <p className="prose-measure mt-6 text-sm text-[var(--color-muted-foreground)]">
          When a subscription ends, course access stops — but your progress and any certificates you
          earned stay yours.
        </p>
      )}
    </div>
  );
}

export default function PlansPage() {
  return (
    <AuthProvider>
      <SiteHeader />
      <PlansScreen />
    </AuthProvider>
  );
}
