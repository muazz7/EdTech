'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/client/api-client';
import {
  Badge,
  Button,
  Card,
  ErrorNote,
  Field,
  Input,
  Skeleton,
  Textarea,
} from '@/components/ui';
import { CheckCircleIcon, LockIcon } from '@/components/icons';

/**
 * Doubts on a lesson (Section 12).
 *
 * Public by default, and the copy says so before the student types: the same
 * question gets asked forty times, and one answered public thread is worth more
 * to everyone than forty private ones. The private switch exists for the
 * questions a student would not ask in front of the class.
 *
 * No realtime. The list refreshes when a thread is opened or a reply is posted,
 * which is entirely sufficient and saves a whole subsystem.
 */

type ThreadSummary = {
  id: string;
  title: string;
  body: string;
  isResolved: boolean;
  isPinned: boolean;
  isPublic: boolean;
  replyCount: number;
  createdAt: string;
  authorName: string;
  isMine: boolean;
};

type Reply = {
  id: string;
  body: string;
  isTeacherAnswer: boolean;
  createdAt: string;
  authorName: string;
};

type ThreadDetail = ThreadSummary & { replies: Reply[]; canModerate: boolean };

function when(iso: string): string {
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (minutes < 60) return `${Math.max(1, minutes)} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

export function DoubtsPanel({ lessonId }: { lessonId: string }) {
  const [threads, setThreads] = useState<ThreadSummary[] | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setThreads(await api.get<ThreadSummary[]>(`/lessons/${lessonId}/doubts`));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load the questions.');
    }
  }, [lessonId]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <section className="mt-10">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold text-[var(--color-foreground)]">Questions</h2>
        <Button size="sm" onClick={() => setAsking((v) => !v)} aria-expanded={asking}>
          Ask a question
        </Button>
      </div>

      {error && (
        <div className="mt-3">
          <ErrorNote onRetry={() => void load()}>{error}</ErrorNote>
        </div>
      )}

      {asking && (
        <AskForm
          lessonId={lessonId}
          onCancel={() => setAsking(false)}
          onPosted={(created) => {
            setAsking(false);
            setOpenId(created);
            void load();
          }}
        />
      )}

      {threads === null && !error && <Skeleton className="mt-4 h-24 w-full" />}

      {threads?.length === 0 && !asking && (
        <p className="mt-3 text-sm text-[var(--color-muted-foreground)]">
          No questions on this lesson yet. Ask the first one — your teacher answers here, and other
          students can see the answer too.
        </p>
      )}

      {threads && threads.length > 0 && (
        <ul className="mt-4 flex flex-col gap-3">
          {threads.map((thread) => (
            <Card as="li" key={thread.id} className="p-4">
              <button
                type="button"
                onClick={() => setOpenId(openId === thread.id ? null : thread.id)}
                aria-expanded={openId === thread.id}
                className="w-full text-left"
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <p className="font-medium text-[var(--color-foreground)]">{thread.title}</p>
                  <div className="flex shrink-0 flex-wrap items-center gap-2">
                    {thread.isPinned && <Badge tone="info">Pinned</Badge>}
                    {thread.isResolved && <Badge tone="success">Answered</Badge>}
                    {!thread.isPublic && (
                      <span className="flex items-center gap-1 text-xs text-[var(--color-muted-foreground)]">
                        <LockIcon className="size-3.5" />
                        Private
                      </span>
                    )}
                  </div>
                </div>

                <p className="mt-1 text-sm text-[var(--color-muted-foreground)]">
                  {thread.isMine ? 'You' : thread.authorName} · {when(thread.createdAt)} ·{' '}
                  <span className="tabular">{thread.replyCount}</span> repl
                  {thread.replyCount === 1 ? 'y' : 'ies'}
                </p>
              </button>

              {openId === thread.id && <ThreadView threadId={thread.id} onChanged={() => void load()} />}
            </Card>
          ))}
        </ul>
      )}
    </section>
  );
}

function ThreadView({ threadId, onChanged }: { threadId: string; onChanged: () => void }) {
  const [thread, setThread] = useState<ThreadDetail | null>(null);
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reported, setReported] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      setThread(await api.get<ThreadDetail>(`/doubts/${threadId}`));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not open this question.');
    }
  }, [threadId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function reply() {
    setBusy(true);
    setError(null);
    try {
      await api.post(`/doubts/${threadId}/replies`, { body: body.trim() });
      setBody('');
      await load();
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not post your reply.');
    } finally {
      setBusy(false);
    }
  }

  async function report() {
    try {
      await api.post('/doubts/report', { threadId, reason: 'Reported from the lesson page' });
      setReported(true);
    } catch {
      // A duplicate report is answered as success by the server; anything else
      // is not worth an error banner over a report button.
      setReported(true);
    }
  }

  if (!thread) return <Skeleton className="mt-3 h-20 w-full" />;

  return (
    <div className="mt-3 border-t border-[var(--color-border)] pt-3">
      <p className="prose-measure whitespace-pre-line text-sm text-[var(--color-foreground)]">
        {thread.body}
      </p>

      {thread.replies.length > 0 && (
        <ul className="mt-4 flex flex-col gap-3">
          {thread.replies.map((item) => (
            <li
              key={item.id}
              className={`rounded-[var(--radius-md)] p-3 ${
                item.isTeacherAnswer
                  ? 'bg-[var(--color-cyan-tint)]'
                  : 'bg-[var(--color-surface-sunken)]'
              }`}
            >
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-sm font-medium text-[var(--color-foreground)]">
                  {item.authorName}
                </p>
                {/* The teacher's answer is marked in words as well as by
                    background colour, which is not perceivable to everyone. */}
                {item.isTeacherAnswer && (
                  <span className="flex items-center gap-1 text-xs font-medium text-[var(--color-success)]">
                    <CheckCircleIcon className="size-3.5" />
                    Teacher
                  </span>
                )}
                <span className="text-xs text-[var(--color-muted-foreground)]">
                  {when(item.createdAt)}
                </span>
              </div>
              <p className="prose-measure mt-1 whitespace-pre-line text-sm text-[var(--color-foreground)]">
                {item.body}
              </p>
            </li>
          ))}
        </ul>
      )}

      {error && (
        <div className="mt-3">
          <ErrorNote>{error}</ErrorNote>
        </div>
      )}

      <div className="mt-4 flex flex-col gap-2">
        <label className="text-sm font-medium text-[var(--color-foreground)]">
          Reply
          <Textarea
            rows={2}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            className="mt-1"
            placeholder="Add to this question, or answer it."
          />
        </label>

        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="primary"
            loading={busy}
            disabled={body.trim().length === 0}
            onClick={() => void reply()}
          >
            Post reply
          </Button>

          {!thread.isMine && (
            <Button size="sm" disabled={reported} onClick={() => void report()}>
              {reported ? 'Reported' : 'Report'}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

function AskForm({
  lessonId,
  onCancel,
  onPosted,
}: {
  lessonId: string;
  onCancel: () => void;
  onPosted: (threadId: string) => void;
}) {
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [isPublic, setIsPublic] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const created = await api.post<{ id: string }>(`/lessons/${lessonId}/doubts`, {
        title: title.trim(),
        body: body.trim(),
        isPublic,
      });
      onPosted(created.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not post your question.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="mt-4 p-4">
      <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
        <Field label="Your question" required>
          {(props) => (
            <Input
              {...props}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Why does the sign flip in step three?"
            />
          )}
        </Field>

        <Field label="Details" required hint="What you tried, and where you got stuck.">
          {(props) => (
            <Textarea {...props} rows={4} value={body} onChange={(e) => setBody(e.target.value)} />
          )}
        </Field>

        <label className="flex items-start gap-3 text-sm">
          <input
            type="checkbox"
            checked={!isPublic}
            onChange={(e) => setIsPublic(!e.target.checked)}
            className="mt-1 size-4"
          />
          <span>
            <span className="font-medium text-[var(--color-foreground)]">
              Ask this privately
            </span>
            <span className="block text-[var(--color-muted-foreground)]">
              By default other students on this course can see your question and the answer — which
              usually means someone else has already asked it. Private questions go only to your
              teacher.
            </span>
          </span>
        </label>

        {error && <ErrorNote>{error}</ErrorNote>}

        <div className="flex gap-2">
          <Button
            type="submit"
            variant="primary"
            loading={busy}
            disabled={title.trim().length < 5 || body.trim().length < 5}
          >
            Post question
          </Button>
          <Button type="button" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </form>
    </Card>
  );
}
