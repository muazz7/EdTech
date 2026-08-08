'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useAuth } from './auth-provider';
import { NotificationBell } from './notification-bell';
import { Button } from './ui';

/**
 * Header for the student-facing pages.
 *
 * Navigation placement is identical on every page — moving it per page type is
 * how people lose their bearings. It scrolls horizontally on narrow screens
 * rather than wrapping, so the header height never changes between pages and
 * content below it does not jump.
 */
export function SiteHeader() {
  const { state, signOut } = useAuth();
  const pathname = usePathname();
  const signedIn = state.status === 'signed-in';

  const links = [
    { href: '/', label: 'Courses' },
    { href: '/free', label: 'Free lessons' },
    // Account is in the tab row as well as the top bar: the top-bar link is
    // hidden below the sm breakpoint, and on a phone this is the only way in.
    ...(signedIn
      ? [
          { href: '/my-courses', label: 'My courses' },
          { href: '/account', label: 'Account' },
        ]
      : []),
  ];

  return (
    <header className="sticky top-0 z-[var(--z-sticky)] border-b border-[var(--color-border)] bg-[var(--color-surface)]">
      <div className="mx-auto flex max-w-5xl items-center justify-between gap-4 px-4 py-3 sm:px-6">
        <Link
          href="/"
          className="rounded-[var(--radius-sm)] text-sm font-semibold text-[var(--color-foreground)]"
        >
          Master EdTech
        </Link>

        <div className="flex items-center gap-1">
          {signedIn ? (
            <>
              <NotificationBell />
              <Link
                href="/account"
                className="hidden min-h-11 items-center px-3 text-sm text-[var(--color-muted-foreground)] hover:text-[var(--color-foreground)] sm:inline-flex"
              >
                Account
              </Link>
              <Button size="sm" onClick={() => void signOut()}>
                Sign out
              </Button>
            </>
          ) : (
            <Link
              href="/login"
              className="inline-flex min-h-11 items-center rounded-[var(--radius-md)] bg-[var(--color-primary)] px-4 text-sm font-medium text-[var(--color-on-primary)]"
            >
              Sign in
            </Link>
          )}
        </div>
      </div>

      <nav aria-label="Main" className="mx-auto max-w-5xl overflow-x-auto px-4 sm:px-6">
        <ul className="flex min-w-max gap-1 pb-1">
          {links.map((item) => {
            const active =
              item.href === '/' ? pathname === '/' : pathname.startsWith(item.href);
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
  );
}
