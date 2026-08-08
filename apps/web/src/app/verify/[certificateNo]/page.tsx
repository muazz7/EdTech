'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { ApiClientError, api } from '@/lib/client/api-client';
import { Badge, Card, ErrorNote, Skeleton } from '@/components/ui';
import { CheckCircleIcon, LockIcon } from '@/components/icons';

type Verification = {
  certificateNo: string;
  studentName: string;
  courseTitle: string;
  teacherName: string;
  issuedAt: string;
  status: 'valid' | 'revoked';
  revokedAt: string | null;
};

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
}

/**
 * Public certificate verification (Section 13).
 *
 * No session, no header, no navigation into the product. Whoever lands here
 * scanned a QR code on a printed certificate and wants one question answered:
 * is this real? Everything on the page serves that question.
 *
 * Deliberately NOT wrapped in AuthProvider — an employer checking a certificate
 * must never be asked to sign in, and the page must not fire an auth request
 * that could redirect them.
 */
export default function VerifyPage() {
  const params = useParams<{ certificateNo: string }>();
  const number = decodeURIComponent(params.certificateNo ?? '');

  const [certificate, setCertificate] = useState<Verification | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    setNotFound(false);
    try {
      setCertificate(await api.get<Verification>(`/verify/${encodeURIComponent(number)}`));
    } catch (err) {
      if (err instanceof ApiClientError && err.status === 404) {
        setNotFound(true);
        return;
      }
      setError(err instanceof Error ? err.message : 'Could not check this certificate.');
    }
  }, [number]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <main className="mx-auto max-w-lg px-4 py-12 sm:px-6">
      <p className="text-center text-sm font-medium text-[var(--color-muted-foreground)]">
        Master EdTech
      </p>
      <h1 className="mt-1 text-center text-2xl font-semibold text-[var(--color-foreground)]">
        Certificate verification
      </h1>

      {error && (
        <div className="mt-6">
          <ErrorNote onRetry={() => void load()}>{error}</ErrorNote>
        </div>
      )}

      {!certificate && !notFound && !error && (
        <div className="mt-6 flex flex-col gap-3">
          <Skeleton className="h-48 w-full" />
          <span className="sr-only" role="status">
            Checking certificate
          </span>
        </div>
      )}

      {notFound && (
        <Card className="mt-6 flex flex-col items-center gap-3 p-8 text-center">
          <LockIcon className="size-6 text-[var(--color-muted-foreground)]" />
          <h2 className="text-lg font-semibold text-[var(--color-foreground)]">
            No certificate with that number
          </h2>
          <p className="prose-measure text-sm text-[var(--color-muted-foreground)]">
            Check the number on the certificate and try again. Numbers look like
            {' '}
            <span className="tabular">CERT-2026-4F8A2C91</span>.
          </p>
        </Card>
      )}

      {certificate && (
        <Card className="mt-6 p-6">
          {/* Status is stated in words as well as colour: a green tick alone is
              not perceivable to every reader, and this is the one fact the page
              exists to communicate. */}
          <div className="flex flex-col items-center gap-2 text-center">
            {certificate.status === 'valid' ? (
              <>
                <CheckCircleIcon className="size-8 text-[var(--color-success)]" />
                <p className="text-lg font-semibold text-[var(--color-success)]">
                  This certificate is valid
                </p>
              </>
            ) : (
              <>
                <LockIcon className="size-8 text-[var(--color-destructive)]" />
                <p className="text-lg font-semibold text-[var(--color-destructive)]">
                  This certificate has been revoked
                </p>
                <p className="prose-measure text-sm text-[var(--color-muted-foreground)]">
                  It was issued and later withdrawn
                  {certificate.revokedAt && <> on {formatDate(certificate.revokedAt)}</>}. It should
                  not be accepted as proof of completion.
                </p>
              </>
            )}
          </div>

          <dl className="mt-6 flex flex-col gap-4 border-t border-[var(--color-border)] pt-6">
            <div>
              <dt className="text-sm text-[var(--color-muted-foreground)]">Awarded to</dt>
              <dd className="text-base font-medium text-[var(--color-foreground)]">
                {certificate.studentName}
              </dd>
            </div>
            <div>
              <dt className="text-sm text-[var(--color-muted-foreground)]">Course</dt>
              <dd className="text-base font-medium text-[var(--color-foreground)]">
                {certificate.courseTitle}
              </dd>
            </div>
            <div>
              <dt className="text-sm text-[var(--color-muted-foreground)]">Taught by</dt>
              <dd className="text-base text-[var(--color-foreground)]">
                {certificate.teacherName}
              </dd>
            </div>
            <div>
              <dt className="text-sm text-[var(--color-muted-foreground)]">Issued</dt>
              <dd className="tabular text-base text-[var(--color-foreground)]">
                {formatDate(certificate.issuedAt)}
              </dd>
            </div>
            <div>
              <dt className="text-sm text-[var(--color-muted-foreground)]">Certificate number</dt>
              <dd className="tabular text-base text-[var(--color-foreground)]">
                {certificate.certificateNo}
              </dd>
            </div>
          </dl>

          <div className="mt-6 flex justify-center">
            <Badge tone={certificate.status === 'valid' ? 'success' : 'danger'}>
              {certificate.status === 'valid' ? 'Verified' : 'Revoked'}
            </Badge>
          </div>
        </Card>
      )}

      <p className="mt-8 text-center text-sm text-[var(--color-muted-foreground)]">
        <Link href="/" className="text-[var(--color-primary)] hover:underline">
          Browse courses on Master EdTech
        </Link>
      </p>
    </main>
  );
}
