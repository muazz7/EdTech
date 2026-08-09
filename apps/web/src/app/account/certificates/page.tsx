'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { api } from '@/lib/client/api-client';
import { AuthProvider, useAuth } from '@/components/auth-provider';
import { SiteHeader } from '@/components/site-header';
import { Card, EmptyState, ErrorNote, Skeleton } from '@/components/ui';
import { CheckCircleIcon, LockIcon } from '@/components/icons';
import { Copyable } from '@/components/copyable';

type Certificate = {
  id: string;
  certificateNo: string;
  courseId: string;
  courseTitle: string;
  teacherName: string;
  finalScore: string | null;
  issuedAt: string;
  revokedAt: string | null;
  hasPdf: boolean;
};

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
}

/**
 * The student's certificates (Section 13).
 *
 * The certificate NUMBER is the useful thing on this page, not a download: it
 * is what a student types into an application form and what an employer checks
 * at /verify. So it is copyable, and the verification link is right beside it.
 */
function CertificatesScreen() {
  const { state } = useAuth();
  const [rows, setRows] = useState<Certificate[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setRows(await api.get<Certificate[]>('/me/certificates'));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load your certificates.');
    }
  }, []);

  useEffect(() => {
    if (state.status === 'signed-in') void load();
  }, [state.status, load]);

  if (state.status === 'signed-out') {
    return (
      <div className="mx-auto max-w-md px-4 py-16 sm:px-6">
        <EmptyState
          title="Sign in to see your certificates"
          body="Certificates are tied to your account."
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
      <h1 className="text-2xl font-semibold text-[var(--color-foreground)]">Your certificates</h1>
      <p className="prose-measure mt-2 text-sm text-[var(--color-muted-foreground)]">
        Issued automatically once you meet a course&apos;s completion rules. Anyone can check a
        certificate number at the verification page — no account needed.
      </p>

      {error && (
        <div className="mt-4">
          <ErrorNote onRetry={() => void load()}>{error}</ErrorNote>
        </div>
      )}

      {(rows === null || state.status === 'loading') && !error && (
        <div className="mt-6 flex flex-col gap-3">
          <Skeleton className="h-32 w-full" />
          <span className="sr-only" role="status">
            Loading certificates
          </span>
        </div>
      )}

      {rows?.length === 0 && (
        <div className="mt-6">
          <EmptyState
            title="No certificates yet"
            body="Finish a course's lessons and quizzes and your certificate appears here."
            action={
              <Link
                href="/my-courses"
                className="inline-flex min-h-11 items-center rounded-[var(--radius-md)] bg-[var(--color-primary)] px-4 text-sm font-medium text-[var(--color-on-primary)]"
              >
                Go to my courses
              </Link>
            }
          />
        </div>
      )}

      {rows && rows.length > 0 && (
        <ul className="mt-6 flex flex-col gap-4">
          {rows.map((certificate) => (
            <Card as="li" key={certificate.id} className="p-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <h2 className="text-base font-semibold text-[var(--color-foreground)]">
                    {certificate.courseTitle}
                  </h2>
                  <p className="text-sm text-[var(--color-muted-foreground)]">
                    {certificate.teacherName} · issued {formatDate(certificate.issuedAt)}
                  </p>
                </div>

                {/* Status in words as well as icon. A revoked certificate the
                    student still holds must say so plainly, because the public
                    page will. */}
                {certificate.revokedAt ? (
                  <span className="flex shrink-0 items-center gap-1 text-sm font-medium text-[var(--color-destructive)]">
                    <LockIcon className="size-4" />
                    Revoked
                  </span>
                ) : (
                  <span className="flex shrink-0 items-center gap-1 text-sm font-medium text-[var(--color-success)]">
                    <CheckCircleIcon className="size-4" />
                    Valid
                  </span>
                )}
              </div>

              {certificate.finalScore && (
                <p className="tabular mt-2 text-sm text-[var(--color-muted-foreground)]">
                  Quiz average {certificate.finalScore}%
                </p>
              )}

              <div className="mt-4">
                <p className="text-sm text-[var(--color-muted-foreground)]">Certificate number</p>
                <Copyable value={certificate.certificateNo} label="certificate number" />
              </div>

              <div className="mt-4 flex flex-wrap gap-2">
                <Link
                  href={`/verify/${certificate.certificateNo}`}
                  className="inline-flex min-h-11 items-center rounded-[var(--radius-md)] border border-[var(--color-border-strong)] px-4 text-sm font-medium text-[var(--color-foreground)] transition-colors duration-150 hover:bg-[var(--color-muted)]"
                >
                  Open the public page
                </Link>
              </div>

              {/* Section 13 wants a downloadable PDF. It is not built — saying
                  so beats a button that fails. */}
              {!certificate.hasPdf && !certificate.revokedAt && (
                <p className="mt-3 text-sm text-[var(--color-muted-foreground)]">
                  A downloadable PDF is not available yet. Share the number or the link above in the
                  meantime — both prove the same thing.
                </p>
              )}

              {certificate.revokedAt && (
                <p className="mt-3 rounded-[var(--radius-md)] bg-[var(--color-coral-tint)] p-3 text-sm text-[var(--color-foreground)]">
                  This certificate was withdrawn on {formatDate(certificate.revokedAt)}. The public
                  page shows it as revoked. Contact your teacher if you think this is wrong.
                </p>
              )}
            </Card>
          ))}
        </ul>
      )}
    </div>
  );
}

export default function CertificatesPage() {
  return (
    <AuthProvider>
      <SiteHeader />
      <CertificatesScreen />
    </AuthProvider>
  );
}
