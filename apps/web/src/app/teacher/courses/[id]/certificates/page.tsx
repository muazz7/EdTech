'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { api } from '@/lib/client/api-client';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorNote,
  Field,
  Input,
  Skeleton,
} from '@/components/ui';

type Certificate = {
  id: string;
  certificateNo: string;
  studentName: string;
  finalScore: string | null;
  issuedAt: string;
  revokedAt: string | null;
};

type CompletionRules = {
  minLessonsPercent: number;
  requireAllQuizzes: boolean;
  minQuizAverage: number;
  requireAssignments: boolean;
  issuesCertificate: boolean;
};

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

/**
 * Certificates issued for one course, and the rules that issue them
 * (Section 13).
 *
 * The rules sit on the same screen as the results deliberately: a teacher
 * looking at "why has nobody got a certificate" needs the thresholds in front
 * of them, not one page away.
 */
function CourseCertificatesScreen() {
  const params = useParams<{ id: string }>();
  const courseId = params.id;

  const [rows, setRows] = useState<Certificate[] | null>(null);
  const [rules, setRules] = useState<CompletionRules | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [list, ruleSet] = await Promise.all([
        api.get<Certificate[]>(`/teacher/courses/${courseId}/certificates`),
        api.get<CompletionRules>(`/teacher/courses/${courseId}/completion-rules`),
      ]);
      setRows(list);
      setRules(ruleSet);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load certificates.');
    }
  }, [courseId]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="mx-auto max-w-3xl px-4 py-8 sm:px-6">
      <nav aria-label="Breadcrumb" className="text-sm">
        <Link
          href={`/teacher/courses/${courseId}`}
          className="rounded-[var(--radius-sm)] text-[var(--color-primary)] hover:underline"
        >
          Back to the course
        </Link>
      </nav>

      <h1 className="mt-3 text-2xl font-semibold text-[var(--color-foreground)]">Certificates</h1>

      {error && (
        <div className="mt-4">
          <ErrorNote onRetry={() => void load()}>{error}</ErrorNote>
        </div>
      )}

      {rules && <RulesPanel courseId={courseId} rules={rules} onSaved={setRules} />}

      <section className="mt-8">
        <h2 className="text-lg font-semibold text-[var(--color-foreground)]">Issued</h2>

        {rows === null && !error && <Skeleton className="mt-3 h-24 w-full" />}

        {rows?.length === 0 && (
          <div className="mt-3">
            <EmptyState
              title="None issued yet"
              body="Certificates are issued automatically, within the hour, once a student meets the rules above."
            />
          </div>
        )}

        {rows && rows.length > 0 && (
          <ul className="mt-3 flex flex-col gap-3">
            {rows.map((certificate) => (
              <CertificateRow
                key={certificate.id}
                certificate={certificate}
                onRevoked={() => void load()}
              />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function CertificateRow({
  certificate,
  onRevoked,
}: {
  certificate: Certificate;
  onRevoked: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function revoke() {
    setBusy(true);
    setError(null);
    try {
      await api.post(`/teacher/certificates/${certificate.id}/revoke`, { reason: reason.trim() });
      onRevoked();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not revoke this certificate.');
      setBusy(false);
    }
  }

  return (
    <Card as="li" className="p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-medium text-[var(--color-foreground)]">{certificate.studentName}</p>
          <p className="tabular text-sm text-[var(--color-muted-foreground)]">
            {certificate.certificateNo} · {formatDate(certificate.issuedAt)}
            {certificate.finalScore && <> · {certificate.finalScore}% quiz average</>}
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {certificate.revokedAt ? (
            <Badge tone="danger">Revoked</Badge>
          ) : (
            <>
              <Link
                href={`/verify/${certificate.certificateNo}`}
                target="_blank"
                rel="noreferrer"
                className="inline-flex min-h-9 items-center rounded-[var(--radius-md)] px-3 text-sm font-medium text-[var(--color-primary)] hover:bg-[var(--color-cyan-tint)]"
              >
                Public page
                <span className="sr-only"> (opens in a new tab)</span>
              </Link>
              <Button size="sm" onClick={() => setConfirming(true)}>
                Revoke
              </Button>
            </>
          )}
        </div>
      </div>

      {confirming && !certificate.revokedAt && (
        <div className="mt-3 rounded-[var(--radius-md)] bg-[var(--color-surface-sunken)] p-3">
          {/* Revocation is permanent and public. The reason is required because
              the audit entry is worthless without one, and because an employer
              may later ask what happened. */}
          <p className="prose-measure text-sm text-[var(--color-foreground)]">
            Revoking is permanent. The public verification page will show this certificate as
            revoked rather than valid — it does not disappear.
          </p>

          <div className="mt-3">
            <Field label="Reason" required hint="Recorded in the audit trail with your name.">
              {(props) => (
                <Input
                  {...props}
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="Academic misconduct"
                />
              )}
            </Field>
          </div>

          {error && (
            <div className="mt-2">
              <ErrorNote>{error}</ErrorNote>
            </div>
          )}

          <div className="mt-3 flex gap-2">
            <Button
              size="sm"
              variant="danger"
              loading={busy}
              disabled={reason.trim().length < 3}
              onClick={() => void revoke()}
            >
              Revoke certificate
            </Button>
            <Button size="sm" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}

function RulesPanel({
  courseId,
  rules,
  onSaved,
}: {
  courseId: string;
  rules: CompletionRules;
  onSaved: (next: CompletionRules) => void;
}) {
  const [minLessons, setMinLessons] = useState(String(rules.minLessonsPercent));
  const [minQuiz, setMinQuiz] = useState(String(rules.minQuizAverage));
  const [requireQuizzes, setRequireQuizzes] = useState(rules.requireAllQuizzes);
  const [requireAssignments, setRequireAssignments] = useState(rules.requireAssignments);
  const [issues, setIssues] = useState(rules.issuesCertificate);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      onSaved(
        await api.put<CompletionRules>(`/teacher/courses/${courseId}/completion-rules`, {
          minLessonsPercent: Number(minLessons),
          requireAllQuizzes: requireQuizzes,
          minQuizAverage: Number(minQuiz),
          requireAssignments,
          issuesCertificate: issues,
        }),
      );
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the rules.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="mt-6 p-5">
      <h2 className="text-base font-semibold text-[var(--color-foreground)]">Completion rules</h2>
      <p className="prose-measure mt-1 text-sm text-[var(--color-muted-foreground)]">
        Checked hourly for students whose progress has moved. Loosening a rule issues certificates
        to anyone who already qualifies; tightening one does not take back certificates already
        issued.
      </p>

      <form onSubmit={save} className="mt-4 flex flex-col gap-4" noValidate>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Lessons completed (%)">
            {(props) => (
              <Input
                {...props}
                inputMode="numeric"
                value={minLessons}
                onChange={(e) => setMinLessons(e.target.value)}
                className="tabular"
              />
            )}
          </Field>

          <Field label="Quiz average (%)" hint="Only applies if the course has published quizzes.">
            {(props) => (
              <Input
                {...props}
                inputMode="numeric"
                value={minQuiz}
                onChange={(e) => setMinQuiz(e.target.value)}
                className="tabular"
              />
            )}
          </Field>
        </div>

        <label className="flex items-start gap-3 text-sm">
          <input
            type="checkbox"
            checked={requireQuizzes}
            onChange={(e) => setRequireQuizzes(e.target.checked)}
            className="mt-1 size-4"
          />
          <span>
            <span className="font-medium text-[var(--color-foreground)]">
              Every quiz must be attempted
            </span>
            <span className="block text-[var(--color-muted-foreground)]">
              An attempt still waiting on your marking does not count yet, so a slow marking queue
              delays certificates.
            </span>
          </span>
        </label>

        <label className="flex items-start gap-3 text-sm">
          <input
            type="checkbox"
            checked={requireAssignments}
            onChange={(e) => setRequireAssignments(e.target.checked)}
            className="mt-1 size-4"
          />
          <span>
            <span className="font-medium text-[var(--color-foreground)]">
              Every assignment must be marked
            </span>
            <span className="block text-[var(--color-muted-foreground)]">
              Same caveat: this depends on you, not only on the student.
            </span>
          </span>
        </label>

        <label className="flex items-start gap-3 text-sm">
          <input
            type="checkbox"
            checked={issues}
            onChange={(e) => setIssues(e.target.checked)}
            className="mt-1 size-4"
          />
          <span>
            <span className="font-medium text-[var(--color-foreground)]">
              Issue certificates for this course
            </span>
            <span className="block text-[var(--color-muted-foreground)]">
              Turn off for a course where a certificate would not mean anything.
            </span>
          </span>
        </label>

        {error && <ErrorNote>{error}</ErrorNote>}

        <div className="flex items-center gap-3">
          <Button type="submit" size="sm" loading={busy}>
            Save rules
          </Button>
          {saved && (
            <span role="status" className="text-sm text-[var(--color-success)]">
              Saved
            </span>
          )}
        </div>
      </form>
    </Card>
  );
}

export default function CourseCertificatesPage() {
  return <CourseCertificatesScreen />;
}
