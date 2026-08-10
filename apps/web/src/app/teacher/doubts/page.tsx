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
import { CheckCircleIcon, LockIcon } from '@/components/icons';

type Thread = {
  id: string;
  title: string;
  body: string;
  lessonId: string;
  lessonTitle: string;
  courseTitle: string;
  studentName: string;
  isResolved: boolean;
  isPinned: boolean;
  isPublic: boolean;
  replyCount: number;
  hiddenAt: string | null;
  createdAt: string;
  reportCount: number;
};

type Report = {
  id: string;
  threadId: string | null;
  replyId: string | null;
  reason: string;
  createdAt: string;
  reporterName: string;
  threadTitle: string | null;
};

type Reply = {
  id: string;
  body: string;
  isTeacherAnswer: boolean;
  createdAt: string;
  authorName: string;
};

function waitedFor(iso: string): string {
  const hours = Math.floor((Date.now() - new Date(iso).getTime()) / (60 * 60 * 1000));
  if (hours < 1) return 'just now';
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

/**
 * The teacher's doubt inbox (Section 12).
 *
 * Unanswered first, then oldest. A student who asked three days ago and got
 * nothing is the one to serve next, and any other order buries them.
 *
 * Answering here is the point of the screen, so the reply box is on the row
 * rather than behind a navigation — a teacher clearing twenty questions should
 * not make forty page transitions to do it.
 */
function DoubtsInboxScreen() {
  const [threads, setThreads] = useState<Thread[] | null>(null);
  const [reports, setReports] = useState<Report[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [showResolved, setShowResolved] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const data = await api.get<{ threads: Thread[]; reports: Report[] }>('/teacher/doubts');
      setThreads(data.threads);
      setReports(data.reports);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load your questions.');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const visible = (threads ?? []).filter((t) => showResolved || (!t.isResolved && !t.hiddenAt));
  const waiting = (threads ?? []).filter((t) => !t.isResolved && !t.hiddenAt).length;

  return (
    <div className="mx-auto max-w-3xl px-4 py-8 sm:px-6">
      <h1 className="text-2xl font-semibold text-[var(--color-foreground)]">Questions</h1>
      <p className="mt-1 text-sm text-[var(--color-muted-foreground)]">
        {threads === null
          ? 'Loading what students have asked.'
          : waiting === 0
            ? 'Nothing waiting on you.'
            : `${waiting} question${waiting === 1 ? '' : 's'} waiting, oldest first.`}
      </p>

      {error && (
        <div className="mt-4">
          <ErrorNote onRetry={() => void load()}>{error}</ErrorNote>
        </div>
      )}

      {/* Reports first: a flagged post is time-sensitive in a way an unanswered
          question is not. */}
      {reports.length > 0 && (
        <Card className="mt-4 border-[var(--color-warning)] p-4">
          <h2 className="text-base font-semibold text-[var(--color-foreground)]">
            {reports.length} reported post{reports.length === 1 ? '' : 's'}
          </h2>
          <ul className="mt-2 flex flex-col gap-2">
            {reports.map((report) => (
              <li key={report.id} className="text-sm text-[var(--color-muted-foreground)]">
                <span className="text-[var(--color-foreground)]">
                  {report.threadTitle ?? 'A reply'}
                </span>{' '}
                — {report.reason} (reported by {report.reporterName}, {waitedFor(report.createdAt)})
              </li>
            ))}
          </ul>
        </Card>
      )}

      <label className="mt-4 flex items-center gap-2 text-sm text-[var(--color-foreground)]">
        <input
          type="checkbox"
          checked={showResolved}
          onChange={(e) => setShowResolved(e.target.checked)}
          className="size-4"
        />
        Show answered and hidden questions
      </label>

      {threads === null && !error && <Skeleton className="mt-4 h-32 w-full" />}

      {threads && visible.length === 0 && (
        <div className="mt-6">
          <EmptyState
            title={waiting === 0 ? 'All caught up' : 'Nothing to show'}
            body="Questions students ask on your lessons appear here, unanswered first."
          />
        </div>
      )}

      {visible.length > 0 && (
        <ul className="mt-4 flex flex-col gap-3">
          {visible.map((thread) => (
            <ThreadRow key={thread.id} thread={thread} onChanged={() => void load()} />
          ))}
        </ul>
      )}
    </div>
  );
}

function ThreadRow({ thread, onChanged }: { thread: Thread; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const [replies, setReplies] = useState<Reply[] | null>(null);
  const [body, setBody] = useState('');
  const [hideReason, setHideReason] = useState('');
  const [hiding, setHiding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadReplies = useCallback(async () => {
    try {
      const data = await api.get<{ replies: Reply[] }>(`/doubts/${thread.id}`);
      setReplies(data.replies);
    } catch {
      setReplies([]);
    }
  }, [thread.id]);

  useEffect(() => {
    if (open && replies === null) void loadReplies();
  }, [open, replies, loadReplies]);

  async function act(fn: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That did not work.');
    } finally {
      setBusy(false);
    }
  }

  async function answer() {
    await act(async () => {
      await api.post(`/doubts/${thread.id}/replies`, { body: body.trim() });
      setBody('');
      // Answering usually means answered, but not always — a follow-up question
      // is still open. The teacher decides, so this only refreshes.
      await loadReplies();
    });
  }

  return (
    <Card as="li" className="p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <p className="font-medium text-[var(--color-foreground)]">{thread.title}</p>
            {thread.isPinned && <Badge tone="info">Pinned</Badge>}
            {thread.isResolved && <Badge tone="success">Answered</Badge>}
            {thread.hiddenAt && <Badge tone="danger">Hidden</Badge>}
            {thread.reportCount > 0 && (
              <Badge tone="warning">
                {thread.reportCount} report{thread.reportCount === 1 ? '' : 's'}
              </Badge>
            )}
            {!thread.isPublic && (
              <span className="flex items-center gap-1 text-xs text-[var(--color-muted-foreground)]">
                <LockIcon className="size-3.5" />
                Private
              </span>
            )}
          </div>

          <p className="mt-1 text-sm text-[var(--color-muted-foreground)]">
            {thread.studentName} · {thread.courseTitle} · {thread.lessonTitle} ·{' '}
            {waitedFor(thread.createdAt)}
          </p>
        </div>

        <Button size="sm" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
          {open ? 'Close' : 'Answer'}
        </Button>
      </div>

      <p className="prose-measure mt-2 whitespace-pre-line text-sm text-[var(--color-foreground)]">
        {thread.body}
      </p>

      {open && (
        <div className="mt-4 border-t border-[var(--color-border)] pt-4">
          {replies === null ? (
            <Skeleton className="h-16 w-full" />
          ) : (
            replies.length > 0 && (
              <ul className="mb-4 flex flex-col gap-2">
                {replies.map((reply) => (
                  <li
                    key={reply.id}
                    className={`rounded-[var(--radius-md)] p-3 text-sm ${
                      reply.isTeacherAnswer
                        ? 'bg-[var(--color-cyan-tint)]'
                        : 'bg-[var(--color-surface-sunken)]'
                    }`}
                  >
                    <span className="font-medium text-[var(--color-foreground)]">
                      {reply.authorName}
                    </span>
                    {reply.isTeacherAnswer && (
                      <span className="ml-2 inline-flex items-center gap-1 text-xs font-medium text-[var(--color-success)]">
                        <CheckCircleIcon className="size-3.5" />
                        You
                      </span>
                    )}
                    <p className="prose-measure mt-1 whitespace-pre-line text-[var(--color-foreground)]">
                      {reply.body}
                    </p>
                  </li>
                ))}
              </ul>
            )
          )}

          <label className="text-sm font-medium text-[var(--color-foreground)]">
            Your answer
            <Textarea
              rows={3}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              className="mt-1"
              placeholder="Answer once here and every student on the course can read it."
            />
          </label>

          {error && (
            <div className="mt-2">
              <ErrorNote>{error}</ErrorNote>
            </div>
          )}

          <div className="mt-3 flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="primary"
              loading={busy}
              disabled={body.trim().length === 0}
              onClick={() => void answer()}
            >
              Post answer
            </Button>

            <Button
              size="sm"
              onClick={() =>
                void act(() =>
                  api.post(`/doubts/${thread.id}/moderate`, { isResolved: !thread.isResolved }),
                )
              }
            >
              {thread.isResolved ? 'Reopen' : 'Mark answered'}
            </Button>

            <Button
              size="sm"
              onClick={() =>
                void act(() =>
                  api.post(`/doubts/${thread.id}/moderate`, { isPinned: !thread.isPinned }),
                )
              }
            >
              {thread.isPinned ? 'Unpin' : 'Pin to lesson'}
            </Button>

            {!thread.hiddenAt && (
              <Button size="sm" onClick={() => setHiding(true)}>
                Hide
              </Button>
            )}

            <Link
              href={`/learn/lessons/${thread.lessonId}`}
              target="_blank"
              rel="noreferrer"
              className="inline-flex min-h-9 items-center rounded-[var(--radius-md)] px-3 text-sm font-medium text-[var(--color-primary)] hover:bg-[var(--color-cyan-tint)]"
            >
              Open the lesson
              <span className="sr-only"> (opens in a new tab)</span>
            </Link>
          </div>

          {hiding && (
            <div className="mt-3 rounded-[var(--radius-md)] bg-[var(--color-surface-sunken)] p-3">
              {/* Hiding is not deleting: the question stays on the record, and
                  the student may well ask why it disappeared. */}
              <p className="prose-measure text-sm text-[var(--color-foreground)]">
                Hiding removes this from the lesson for everyone. It is not deleted — the reason is
                recorded with your name.
              </p>
              <div className="mt-2">
                <Field label="Reason" required>
                  {(props) => (
                    <Input
                      {...props}
                      value={hideReason}
                      onChange={(e) => setHideReason(e.target.value)}
                      placeholder="Off topic"
                    />
                  )}
                </Field>
              </div>
              <div className="mt-2 flex gap-2">
                <Button
                  size="sm"
                  variant="danger"
                  loading={busy}
                  disabled={hideReason.trim().length < 3}
                  onClick={() =>
                    void act(async () => {
                      await api.post('/teacher/doubts/hide', {
                        threadId: thread.id,
                        reason: hideReason.trim(),
                      });
                      setHiding(false);
                    })
                  }
                >
                  Hide question
                </Button>
                <Button size="sm" onClick={() => setHiding(false)}>
                  Cancel
                </Button>
              </div>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

export default function TeacherDoubtsPage() {
  return <DoubtsInboxScreen />;
}
