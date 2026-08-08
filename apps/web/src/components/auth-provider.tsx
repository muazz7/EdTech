'use client';

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import type { Me } from '@edtech/shared';
import { api, bootstrap, onForcedSignOut, setCredentials } from '@/lib/client/api-client';
import { Skeleton } from './ui';

type AuthState =
  | { status: 'loading' }
  | { status: 'signed-out'; reason?: 'revoked' | 'expired' }
  | { status: 'signed-in'; me: Me };

type AuthContextValue = {
  state: AuthState;
  /** Called by the login form once tokens are in hand. */
  adopt: (token: string, sessionId: string) => Promise<void>;
  signOut: () => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({ status: 'loading' });

  const load = useCallback(async () => {
    try {
      const me = await api.get<Me>('/auth/me');
      setState({ status: 'signed-in', me });
    } catch {
      setState({ status: 'signed-out' });
    }
  }, []);

  useEffect(() => {
    // A page load starts with no access token — it is held in memory only
    // (Section 6.2), so the httpOnly refresh cookie is what restores the
    // session. No cookie means genuinely signed out.
    void (async () => {
      if (await bootstrap()) await load();
      else setState({ status: 'signed-out' });
    })();
  }, [load]);

  useEffect(() => {
    // Fires when another device signs in and revokes this session, or when a
    // refresh token is replayed. Section 6.3: the kicked device must find out.
    return onForcedSignOut((reason) => setState({ status: 'signed-out', reason }));
  }, []);

  const adopt = useCallback(
    async (token: string, sessionId: string) => {
      setCredentials(token, sessionId);
      await load();
    },
    [load],
  );

  const signOut = useCallback(async () => {
    try {
      await api.post('/auth/logout');
    } catch {
      // Already revoked server-side; the local state still needs clearing.
    }
    setState({ status: 'signed-out' });
  }, []);

  return <AuthContext.Provider value={{ state, adopt, signOut }}>{children}</AuthContext.Provider>;
}

/**
 * Gate for teacher-only areas.
 *
 * This is UI convenience, not access control. Every /api/v1/teacher/* route
 * re-checks the live role server-side (Section 7), so bypassing this in devtools
 * reveals an empty shell and nothing else.
 */
export function RequireTeacher({ children }: { children: ReactNode }) {
  const { state } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (state.status === 'signed-out') {
      const reason = state.reason ? `?reason=${state.reason}` : '';
      router.replace(`/login${reason}`);
    }
  }, [state, router]);

  if (state.status === 'loading') {
    return (
      <div className="mx-auto flex max-w-5xl flex-col gap-4 px-4 py-10 sm:px-6">
        <Skeleton className="h-8 w-56" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-24 w-full" />
        <span className="sr-only" role="status">
          Loading your courses
        </span>
      </div>
    );
  }

  if (state.status === 'signed-out') return null;

  if (state.me.role === 'student') {
    return (
      <div className="mx-auto max-w-xl px-4 py-16 text-center sm:px-6">
        <h1 className="text-xl font-semibold text-[var(--color-foreground)]">
          This area is for teachers
        </h1>
        <p className="mt-2 text-sm text-[var(--color-muted-foreground)]">
          Your account does not have teacher access. If that is wrong, contact the platform owner.
        </p>
      </div>
    );
  }

  return <>{children}</>;
}
