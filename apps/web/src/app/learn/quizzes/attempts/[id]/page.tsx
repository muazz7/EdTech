'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { AuthProvider, useAuth } from '@/components/auth-provider';
import { SiteHeader } from '@/components/site-header';
import { EmptyState, Skeleton } from '@/components/ui';
import { AttemptResult } from '@/components/learn/quiz-panel';

/**
 * One attempt's result, on its own URL.
 *
 * This is where the "your result is ready" notification points (Section 15), so
 * it has to stand alone — a student tapping a push a week later has no lesson
 * page open and no attempt in memory.
 */
function AttemptResultScreen() {
  const params = useParams<{ id: string }>();
  const { state } = useAuth();

  if (state.status === 'loading') {
    return (
      <div className="mx-auto max-w-2xl px-4 py-8 sm:px-6">
        <Skeleton className="h-48 w-full" />
        <span className="sr-only" role="status">
          Loading your result
        </span>
      </div>
    );
  }

  if (state.status === 'signed-out') {
    return (
      <div className="mx-auto max-w-md px-4 py-16 sm:px-6">
        <EmptyState
          title="Sign in to see your result"
          body="Quiz results are tied to your account."
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
      <h1 className="text-2xl font-semibold text-[var(--color-foreground)]">Your quiz result</h1>
      <div className="mt-6">
        <AttemptResult attemptId={params.id} />
      </div>

      <p className="mt-8">
        <Link href="/my-courses" className="text-sm text-[var(--color-primary)] hover:underline">
          Back to my courses
        </Link>
      </p>
    </div>
  );
}

export default function AttemptResultPage() {
  return (
    <AuthProvider>
      <SiteHeader />
      <AttemptResultScreen />
    </AuthProvider>
  );
}
