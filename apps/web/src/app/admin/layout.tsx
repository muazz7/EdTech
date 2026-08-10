'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { AuthProvider, useAuth } from '@/components/auth-provider';
import { Button, Skeleton } from '@/components/ui';

/**
 * Owner console.
 *
 * Separate from the teacher portal because the powers are different in kind,
 * not degree: plans here grant access across EVERY teacher's catalog, which is
 * exactly why no teacher may create or price one (ADR 0003).
 *
 * This gate is UI convenience. Every /api/v1/admin/* route calls resolveAdmin,
 * which reads the live role from the database — bypassing this in devtools
 * reveals an empty shell and nothing else.
 */
function RequireAdmin({ children }: { children: ReactNode }) {
  const { state } = useAuth();

  if (state.status === 'loading') {
    return (
      <div className="mx-auto flex max-w-4xl flex-col gap-4 px-4 py-10 sm:px-6">
        <Skeleton className="h-8 w-56" />
        <Skeleton className="h-32 w-full" />
        <span className="sr-only" role="status">
          Loading
        </span>
      </div>
    );
  }

  if (state.status === 'signed-out' || state.me.role !== 'admin') {
    return (
      <div className="mx-auto max-w-xl px-4 py-16 text-center sm:px-6">
        <h1 className="text-xl font-semibold text-[var(--color-foreground)]">
          This area is for the platform owner
        </h1>
        <p className="prose-measure mx-auto mt-2 text-sm text-[var(--color-muted-foreground)]">
          Plans set here apply across every teacher&apos;s catalog, so only the owner can change
          them.
        </p>
        <Link
          href="/"
          className="mt-4 inline-flex min-h-11 items-center text-sm text-[var(--color-primary)]"
        >
          Back to the catalog
        </Link>
      </div>
    );
  }

  return <>{children}</>;
}

function AdminChrome({ children }: { children: ReactNode }) {
  const { state, signOut } = useAuth();
  const pathname = usePathname();
  const me = state.status === 'signed-in' ? state.me : null;

  return (
    <div className="min-h-dvh">
      <header className="sticky top-0 z-[var(--z-sticky)] border-b border-[var(--color-border)] bg-[var(--color-surface)]">
        <div className="mx-auto flex max-w-4xl items-center justify-between gap-4 px-4 py-3 sm:px-6">
          <Link
            href="/admin/plans"
            className="rounded-[var(--radius-sm)] text-sm font-semibold text-[var(--color-foreground)]"
          >
            Owner console
          </Link>

          <div className="flex items-center gap-3">
            {me && (
              <span className="hidden text-sm text-[var(--color-muted-foreground)] sm:inline">
                {me.fullName || me.phone}
              </span>
            )}
            <Button size="sm" onClick={() => void signOut()}>
              Sign out
            </Button>
          </div>
        </div>

        <nav aria-label="Owner sections" className="mx-auto max-w-4xl overflow-x-auto px-4 sm:px-6">
          <ul className="flex min-w-max gap-1 pb-1">
            {[
              { href: '/admin/plans', label: 'Plans' },
              { href: '/admin/piracy', label: 'Piracy signals' },
              { href: '/teacher', label: 'Teacher portal' },
            ].map((item) => {
              const active = pathname.startsWith(item.href);
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    aria-current={active ? 'page' : undefined}
                    className={`inline-flex min-h-11 items-center rounded-t-[var(--radius-sm)] border-b-2 px-3 text-sm transition-colors duration-150 ${
                      active
                        ? 'border-[var(--color-primary)] font-medium text-[var(--color-foreground)]'
                        : 'border-transparent text-[var(--color-muted-foreground)] hover:bg-[var(--color-muted)]'
                    }`}
                  >
                    {item.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>
      </header>

      {children}
    </div>
  );
}

export default function AdminLayout({ children }: { children: ReactNode }) {
  return (
    <AuthProvider>
      <AdminChrome>
        <RequireAdmin>{children}</RequireAdmin>
      </AdminChrome>
    </AuthProvider>
  );
}
