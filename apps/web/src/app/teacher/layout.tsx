'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { AuthProvider, RequireTeacher, useAuth } from '@/components/auth-provider';
import { Button } from '@/components/ui';

function TeacherChrome({ children }: { children: ReactNode }) {
  const { state, signOut } = useAuth();
  const pathname = usePathname();
  const me = state.status === 'signed-in' ? state.me : null;

  return (
    <div className="min-h-dvh">
      {/* Navigation placement stays identical on every teacher page. Moving it
          per page type is how people lose their bearings. */}
      <header className="sticky top-0 z-[var(--z-sticky)] border-b border-[var(--color-border)] bg-[var(--color-surface)]">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-4 px-4 py-3 sm:px-6">
          <Link
            href="/teacher"
            className="rounded-[var(--radius-sm)] text-sm font-semibold text-[var(--color-foreground)]"
          >
            Teacher portal
          </Link>

          <div className="flex items-center gap-3">
            {me && (
              <span className="hidden text-sm text-[var(--color-muted-foreground)] sm:inline">
                {me.fullName || me.phone}
              </span>
            )}
            {/* Sign out is spatially separated from navigation links, so it is
                not a mis-tap away from a course. */}
            <Button size="sm" onClick={() => void signOut()}>
              Sign out
            </Button>
          </div>
        </div>

        {/* Primary navigation stays in the same place on every teacher page.
            Scrollable on narrow screens rather than wrapping, so the header
            height does not change between pages. */}
        <nav
          aria-label="Teacher sections"
          className="mx-auto max-w-5xl overflow-x-auto px-4 sm:px-6"
        >
          <ul className="flex min-w-max gap-1 pb-1">
            {[
              { href: '/teacher', label: 'Courses' },
              { href: '/teacher/grading', label: 'Marking' },
              { href: '/teacher/doubts', label: 'Questions' },
              { href: '/teacher/payments', label: 'Payments' },
              { href: '/teacher/promo-codes', label: 'Promo codes' },
              { href: '/teacher/payment-methods', label: 'Payment settings' },
            ].map((item) => {
              // Exact match for the index, prefix match for the rest, so
              // /teacher/courses/:id does not light up two tabs.
              const active =
                item.href === '/teacher' ? pathname === '/teacher' : pathname.startsWith(item.href);
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

export default function TeacherLayout({ children }: { children: ReactNode }) {
  return (
    <AuthProvider>
      <TeacherChrome>
        <RequireTeacher>{children}</RequireTeacher>
      </TeacherChrome>
    </AuthProvider>
  );
}
