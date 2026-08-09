'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
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
  Textarea,
} from '@/components/ui';
import { ClipboardIcon, QuizIcon } from '@/components/icons';

type QueuedAttempt = {
  attemptId: string;
  quizTitle: string;
  courseTitle: string;
  studentName: string;
  submittedAt: string;
  attemptNumber: number;
  pending: number;
};

type SubmissionFile = { key: string; name: string; size: number; mime: string };

type QueuedSubmission = {
  id: string;
  assignmentId: string;
  assignmentTitle: string;
  courseTitle: string;
  studentName: string;
  submittedAt: string;
  isLate: boolean;
  studentNote: string | null;
  files: SubmissionFile[];
  gradedAt: string | null;
  marks: string | null;
  maxMarks: string;
};

type Queue = { quizAttempts: QueuedAttempt[]; assignmentSubmissions: QueuedSubmission[] };

/** How long a student has been waiting. The number that decides what to do
 *  next, so it is the number shown. */
function waitedFor(iso: string): string {
  const hours = Math.floor((Date.now() - new Date(iso).getTime()) / (60 * 60 * 1000));
  if (hours < 1) return 'just now';
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

/**
 * The teacher's marking queue (Section 10, Section 11).
 *
 * Quiz attempts and assignment submissions are one list in a teacher's head —
 * "what is waiting on me" — so they are one screen, sorted oldest first. A
 * student who has been waiting three days is the one to serve next, and any
 * other order buries them.
 */
function GradingQueueScreen() {
  const [queue, setQueue] = useState<Queue | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setQueue(await api.get<Queue>('/teacher/grading'));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load the marking queue.');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const total = (queue?.quizAttempts.length ?? 0) + (queue?.assignmentSubmissions.length ?? 0);

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 sm:px-6">
      <h1 className="text-2xl font-semibold text-[var(--color-foreground)]">Marking</h1>
      <p className="mt-1 text-sm text-[var(--color-muted-foreground)]">
        {queue === null
          ? 'Loading what is waiting on you.'
          : total === 0
            ? 'Nothing waiting on you right now.'
            : `${total} item${total === 1 ? '' : 's'} waiting, oldest first.`}
      </p>

      {error && (
        <div className="mt-4">
          <ErrorNote onRetry={() => void load()}>{error}</ErrorNote>
        </div>
      )}

      {queue === null && !error && (
        <div className="mt-6 flex flex-col gap-3">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
          <span className="sr-only" role="status">
            Loading the marking queue
          </span>
        </div>
      )}

      {queue && total === 0 && (
        <div className="mt-6">
          <EmptyState
            title="All caught up"
            body="Written quiz answers and assignment submissions appear here as students send them in."
          />
        </div>
      )}

      {queue && queue.quizAttempts.length > 0 && (
        <section className="mt-8">
          <h2 className="flex items-center gap-2 text-lg font-semibold text-[var(--color-foreground)]">
            <QuizIcon className="size-5 text-[var(--color-muted-foreground)]" />
            Quiz answers
          </h2>

          <ul className="mt-3 flex flex-col gap-3">
            {queue.quizAttempts.map((row) => (
              <Card as="li" key={row.attemptId} className="p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-medium text-[var(--color-foreground)]">{row.studentName}</p>
                    <p className="text-sm text-[var(--color-muted-foreground)]">
                      {row.quizTitle} · {row.courseTitle} · attempt{' '}
                      <span className="tabular">{row.attemptNumber}</span>
                    </p>
                    <p className="mt-1 text-sm text-[var(--color-muted-foreground)]">
                      <span className="tabular">{row.pending}</span> answer
                      {row.pending === 1 ? '' : 's'} to mark · submitted{' '}
                      {waitedFor(row.submittedAt)}
                    </p>
                  </div>

                  <Link
                    href={`/teacher/grading/attempts/${row.attemptId}`}
                    className="inline-flex min-h-11 shrink-0 items-center rounded-[var(--radius-md)] bg-[var(--color-primary)] px-4 text-sm font-medium text-[var(--color-on-primary)]"
                  >
                    Mark
                  </Link>
                </div>
              </Card>
            ))}
          </ul>
        </section>
      )}

      {queue && queue.assignmentSubmissions.length > 0 && (
        <section className="mt-8">
          <h2 className="flex items-center gap-2 text-lg font-semibold text-[var(--color-foreground)]">
            <ClipboardIcon className="size-5 text-[var(--color-muted-foreground)]" />
            Assignments
          </h2>

          <ul className="mt-3 flex flex-col gap-3">
            {queue.assignmentSubmissions.map((row) => (
              <SubmissionCard key={row.id} submission={row} onGraded={() => void load()} />
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

/**
 * One assignment submission, marked in place.
 *
 * Inline rather than on its own route: an assignment is a file and a number,
 * and making a teacher navigate for that turns a two-minute batch into ten.
 * Quiz attempts get their own screen because they have several answers each.
 */
function SubmissionCard({
  submission,
  onGraded,
}: {
  submission: QueuedSubmission;
  onGraded: () => void;
}) {
  const [marks, setMarks] = useState('');
  const [feedback, setFeedback] = useState('');
  const [busy, setBusy] = useState(false);
  const [downloading, setDownloading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function download(file: SubmissionFile) {
    setDownloading(file.key);
    setError(null);
    try {
      // POST, and the key travels in the body: a signed-URL request with the
      // object key in the query string ends up in access logs and history.
      const grant = await api.post<{ url: string }>(
        `/teacher/submissions/${submission.id}/download`,
        { key: file.key },
      );
      window.open(grant.url, '_blank', 'noopener,noreferrer');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not open that file.');
    } finally {
      setDownloading(null);
    }
  }

  async function grade() {
    setBusy(true);
    setError(null);
    try {
      await api.post(`/teacher/submissions/${submission.id}/grade`, {
        marks: marks.trim(),
        ...(feedback.trim() ? { teacherFeedback: feedback.trim() } : {}),
      });
      onGraded();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the mark.');
      setBusy(false);
    }
  }

  const outOfRange =
    marks.trim() !== '' &&
    (Number.isNaN(Number(marks)) ||
      Number(marks) < 0 ||
      Number(marks) > Number(submission.maxMarks));

  return (
    <Card as="li" className="p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <p className="font-medium text-[var(--color-foreground)]">{submission.studentName}</p>
            {/* Late work is accepted and flagged, not refused (Section 11). The
                flag is what lets a teacher apply their own policy. */}
            {submission.isLate && <Badge tone="warning">Late</Badge>}
          </div>
          <p className="text-sm text-[var(--color-muted-foreground)]">
            {submission.assignmentTitle} · {submission.courseTitle}
          </p>
          <p className="mt-1 text-sm text-[var(--color-muted-foreground)]">
            Submitted {waitedFor(submission.submittedAt)}
          </p>
        </div>
      </div>

      {submission.studentNote && (
        <p className="mt-3 whitespace-pre-line rounded-[var(--radius-md)] bg-[var(--color-surface-sunken)] p-3 text-sm text-[var(--color-foreground)]">
          {submission.studentNote}
        </p>
      )}

      <ul className="mt-3 flex flex-wrap gap-2">
        {submission.files.map((file) => (
          <li key={file.key}>
            <Button
              size="sm"
              loading={downloading === file.key}
              onClick={() => void download(file)}
            >
              <ClipboardIcon className="size-4" />
              {file.name}
            </Button>
          </li>
        ))}
      </ul>

      {error && (
        <div className="mt-3">
          <ErrorNote>{error}</ErrorNote>
        </div>
      )}

      <div className="mt-4 grid gap-3 sm:grid-cols-[10rem_1fr]">
        <Field
          label={`Marks (of ${submission.maxMarks})`}
          error={outOfRange ? `Must be between 0 and ${submission.maxMarks}.` : undefined}
        >
          {(props) => (
            <Input
              {...props}
              inputMode="decimal"
              value={marks}
              onChange={(e) => setMarks(e.target.value)}
              className="tabular"
            />
          )}
        </Field>

        <Field label="Feedback (optional)">
          {(props) => (
            <Textarea
              {...props}
              rows={2}
              value={feedback}
              onChange={(e) => setFeedback(e.target.value)}
              placeholder="What was good, and what to fix next time."
            />
          )}
        </Field>
      </div>

      {/* ADR 0004: awarding a mark locks the submission. Stated before the
          click, not after. */}
      <p className="mt-2 text-sm text-[var(--color-muted-foreground)]">
        Marking this locks it — the student can no longer replace the work.
      </p>

      <Button
        className="mt-3"
        variant="primary"
        size="sm"
        loading={busy}
        disabled={marks.trim() === '' || outOfRange}
        onClick={() => void grade()}
      >
        Save mark
      </Button>
    </Card>
  );
}

export default function GradingQueuePage() {
  return <GradingQueueScreen />;
}
