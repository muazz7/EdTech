'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { ASSIGNMENT_MIME_TYPES } from '@edtech/shared';
import { ApiClientError, api } from '@/lib/client/api-client';
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
import { ClipboardIcon } from '@/components/icons';

type Assignment = {
  id: string;
  courseId: string;
  lessonId: string | null;
  title: string;
  instructions: string;
  dueAt: string | null;
  maxMarks: string;
  allowedMime: string[];
  maxFileMb: number;
  allowLate: boolean;
  isPublished: boolean;
  submissionCount: number;
  ungradedCount: number;
};

const MIME_LABEL: Record<string, string> = {
  'application/pdf': 'PDF',
  'image/jpeg': 'JPEG photo',
  'image/png': 'PNG image',
  'image/webp': 'WebP image',
};

/** `datetime-local` wants `YYYY-MM-DDTHH:mm` in local time; the API speaks
 *  ISO-8601 UTC. */
function toLocalInput(iso: string | null): string {
  if (!iso) return '';
  const date = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * Assignment brief editor (Section 11).
 *
 * The accepted file types and size cap set here are enforced on the server at
 * presign time, not just in the student's file picker. That distinction is the
 * whole reason these fields exist rather than being hardcoded.
 */
function AssignmentEditorScreen() {
  const params = useParams<{ id: string }>();
  const lessonId = params.id;

  const [assignment, setAssignment] = useState<Assignment | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setAssignment(await api.get<Assignment | null>(`/teacher/lessons/${lessonId}/assignment`));
    } catch (err) {
      if (err instanceof ApiClientError && err.status === 404) {
        setError('That lesson does not exist, or it belongs to another teacher.');
      } else {
        setError(err instanceof Error ? err.message : 'Could not load the assignment.');
      }
    } finally {
      setLoaded(true);
    }
  }, [lessonId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function create() {
    setError(null);
    try {
      await api.post(`/teacher/lessons/${lessonId}/assignment`, {
        title: 'New assignment',
        instructions: 'Describe what students should do and upload.',
        maxMarks: '100',
        maxFileMb: 10,
        allowLate: true,
      });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create the assignment.');
    }
  }

  if (!loaded) {
    return (
      <div className="mx-auto flex max-w-3xl flex-col gap-4 px-4 py-8 sm:px-6">
        <Skeleton className="h-9 w-64" />
        <Skeleton className="h-40 w-full" />
        <span className="sr-only" role="status">
          Loading assignment
        </span>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl px-4 py-8 sm:px-6">
      <nav aria-label="Breadcrumb" className="text-sm">
        <Link
          href={assignment ? `/teacher/courses/${assignment.courseId}` : '/teacher'}
          className="rounded-[var(--radius-sm)] text-[var(--color-primary)] hover:underline"
        >
          Back to the course
        </Link>
      </nav>

      {error && (
        <div className="mt-4">
          <ErrorNote onRetry={() => void load()}>{error}</ErrorNote>
        </div>
      )}

      {!assignment && !error && (
        <div className="mt-6">
          <EmptyState
            title="No assignment on this lesson yet"
            body="Create one, then write the brief. Students see nothing until you publish it."
            action={
              <Button variant="primary" onClick={() => void create()}>
                <ClipboardIcon className="size-4" />
                Create assignment
              </Button>
            }
          />
        </div>
      )}

      {assignment && (
        <>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <h1 className="text-2xl font-semibold text-[var(--color-foreground)]">
              {assignment.title}
            </h1>
            {assignment.isPublished ? (
              <Badge tone="success">Published</Badge>
            ) : (
              <Badge tone="info">Draft</Badge>
            )}
          </div>

          <p className="mt-1 text-sm text-[var(--color-muted-foreground)]">
            <span className="tabular">{assignment.submissionCount}</span> submission
            {assignment.submissionCount === 1 ? '' : 's'}
            {assignment.ungradedCount > 0 && (
              <>
                {' · '}
                <span className="tabular">{assignment.ungradedCount}</span> waiting to be marked
              </>
            )}
          </p>

          <AssignmentForm assignment={assignment} onSaved={setAssignment} />
        </>
      )}
    </div>
  );
}

function AssignmentForm({
  assignment,
  onSaved,
}: {
  assignment: Assignment;
  onSaved: (next: Assignment) => void;
}) {
  const [title, setTitle] = useState(assignment.title);
  const [instructions, setInstructions] = useState(assignment.instructions);
  const [dueAt, setDueAt] = useState(toLocalInput(assignment.dueAt));
  const [maxMarks, setMaxMarks] = useState(assignment.maxMarks);
  const [maxFileMb, setMaxFileMb] = useState(String(assignment.maxFileMb));
  const [allowLate, setAllowLate] = useState(assignment.allowLate);
  const [mimes, setMimes] = useState<string[]>(assignment.allowedMime);
  const [busy, setBusy] = useState<'save' | 'publish' | null>(null);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function patch(next: Assignment) {
    onSaved({
      ...next,
      submissionCount: assignment.submissionCount,
      ungradedCount: assignment.ungradedCount,
    });
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setBusy('save');
    setError(null);
    setSaved(false);
    try {
      patch(
        await api.patch<Assignment>(`/teacher/assignments/${assignment.id}`, {
          title: title.trim(),
          instructions: instructions.trim(),
          // Sent as UTC. A due date stored in the browser's local time would
          // shift for a student in another timezone.
          dueAt: dueAt ? new Date(dueAt).toISOString() : null,
          maxMarks: maxMarks.trim(),
          maxFileMb: Number(maxFileMb),
          allowLate,
          allowedMime: mimes,
        }),
      );
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the assignment.');
    } finally {
      setBusy(null);
    }
  }

  async function togglePublished() {
    setBusy('publish');
    setError(null);
    try {
      patch(
        await api.patch<Assignment>(`/teacher/assignments/${assignment.id}`, {
          isPublished: !assignment.isPublished,
        }),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not change the assignment state.');
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <Card className="mt-6 p-5">
        <form onSubmit={save} className="flex flex-col gap-4" noValidate>
          <Field label="Title" required>
            {(props) => (
              <Input {...props} value={title} onChange={(e) => setTitle(e.target.value)} />
            )}
          </Field>

          <Field
            label="Instructions"
            required
            hint="What to do, what to upload, and how it will be marked."
          >
            {(props) => (
              <Textarea
                {...props}
                rows={6}
                value={instructions}
                onChange={(e) => setInstructions(e.target.value)}
              />
            )}
          </Field>

          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Due" hint="Leave empty for no deadline.">
              {(props) => (
                <Input
                  {...props}
                  type="datetime-local"
                  value={dueAt}
                  onChange={(e) => setDueAt(e.target.value)}
                />
              )}
            </Field>

            <Field label="Total marks">
              {(props) => (
                <Input
                  {...props}
                  inputMode="decimal"
                  value={maxMarks}
                  onChange={(e) => setMaxMarks(e.target.value)}
                  className="tabular"
                />
              )}
            </Field>

            <Field label="Max file size (MB)">
              {(props) => (
                <Input
                  {...props}
                  inputMode="numeric"
                  value={maxFileMb}
                  onChange={(e) => setMaxFileMb(e.target.value)}
                  className="tabular"
                />
              )}
            </Field>
          </div>

          <fieldset className="flex flex-col gap-2">
            <legend className="text-sm font-medium text-[var(--color-foreground)]">
              Accepted file types
              <span className="ml-2 font-normal text-[var(--color-muted-foreground)]">
                Checked on the server when the student asks for an upload slot.
              </span>
            </legend>

            <div className="flex flex-wrap gap-3">
              {ASSIGNMENT_MIME_TYPES.map((mime) => (
                <label key={mime} className="flex min-h-11 items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={mimes.includes(mime)}
                    onChange={(e) =>
                      setMimes((current) =>
                        e.target.checked
                          ? [...current, mime]
                          : current.filter((m) => m !== mime),
                      )
                    }
                    className="size-4"
                  />
                  {MIME_LABEL[mime] ?? mime}
                </label>
              ))}
            </div>

            {mimes.length === 0 && (
              <p role="alert" className="text-sm text-[var(--color-destructive)]">
                Pick at least one file type, or students cannot upload anything.
              </p>
            )}
          </fieldset>

          <label className="flex items-start gap-3 text-sm">
            <input
              type="checkbox"
              checked={allowLate}
              onChange={(e) => setAllowLate(e.target.checked)}
              className="mt-1 size-4"
            />
            <span>
              <span className="font-medium text-[var(--color-foreground)]">
                Accept late submissions
              </span>
              <span className="block text-[var(--color-muted-foreground)]">
                Late work is still accepted and flagged to you, rather than refused outright.
              </span>
            </span>
          </label>

          {error && <ErrorNote>{error}</ErrorNote>}

          <div className="flex items-center gap-3">
            <Button
              type="submit"
              size="sm"
              loading={busy === 'save'}
              disabled={mimes.length === 0 || !title.trim() || !instructions.trim()}
            >
              Save assignment
            </Button>
            {saved && (
              <span role="status" className="text-sm text-[var(--color-success)]">
                Saved
              </span>
            )}
          </div>
        </form>
      </Card>

      <Card className="mt-6 p-5">
        <h2 className="text-base font-semibold text-[var(--color-foreground)]">Visibility</h2>
        <p className="prose-measure mt-1 text-sm text-[var(--color-muted-foreground)]">
          {assignment.isPublished
            ? 'Students with access to this course can see the brief and upload. Unpublishing hides it; submissions already made are kept.'
            : 'Only you can see this assignment. Publish it when the brief is ready.'}
        </p>

        {/* Section 11 marks work late against the due date at submission time,
            so a teacher moving the deadline after the fact is worth flagging. */}
        {assignment.isPublished && assignment.submissionCount > 0 && (
          <p className="mt-3 text-sm text-[var(--color-muted-foreground)]">
            <span className="tabular">{assignment.submissionCount}</span> student
            {assignment.submissionCount === 1 ? ' has' : 's have'} already submitted. Changing the
            due date does not re-flag work that is already in.
          </p>
        )}

        <div className="mt-4 flex flex-wrap gap-2">
          <Button
            size="sm"
            variant={assignment.isPublished ? 'secondary' : 'primary'}
            loading={busy === 'publish'}
            onClick={() => void togglePublished()}
          >
            {assignment.isPublished ? 'Unpublish assignment' : 'Publish assignment'}
          </Button>

          {assignment.submissionCount > 0 && (
            <Link
              href="/teacher/grading"
              className="inline-flex min-h-9 items-center rounded-[var(--radius-md)] border border-[var(--color-border-strong)] px-3 text-sm font-medium text-[var(--color-foreground)] transition-colors duration-150 hover:bg-[var(--color-muted)]"
            >
              Go to marking
            </Link>
          )}
        </div>
      </Card>
    </>
  );
}

export default function AssignmentEditorPage() {
  return <AssignmentEditorScreen />;
}
