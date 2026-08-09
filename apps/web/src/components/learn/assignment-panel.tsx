'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '@/lib/client/api-client';
import { Badge, Button, Card, ErrorNote, Skeleton, Textarea } from '@/components/ui';
import { ClipboardIcon, LockIcon, TrashIcon } from '@/components/icons';

/**
 * Student assignment panel (Section 11).
 *
 * Uploads go straight to R2 with a presigned PUT — the file never passes
 * through the API, which is what keeps a 10MB phone photo off a serverless
 * function with a 4.5MB request ceiling.
 *
 * The accepted types and size cap shown here come from the assignment itself
 * and are re-checked server-side at presign and again at submit. What is
 * rendered is a courtesy; what holds is the server.
 */

type StoredFile = { name: string; size: number; mime: string };

type Assignment = {
  id: string;
  title: string;
  instructions: string;
  dueAt: string | null;
  maxMarks: string;
  allowedMime: string[];
  maxFileMb: number;
  allowLate: boolean;
  submission: {
    id: string;
    submittedAt: string;
    isLate: boolean;
    studentNote: string | null;
    files: StoredFile[];
    marks: string | null;
    teacherFeedback: string | null;
    gradedAt: string | null;
    locked: boolean;
  } | null;
};

/** A file chosen locally and uploaded, waiting to be submitted. */
type StagedFile = { key: string; name: string; size: number; mime: string };

const MIME_LABEL: Record<string, string> = {
  'application/pdf': 'PDF',
  'image/jpeg': 'JPEG',
  'image/png': 'PNG',
  'image/webp': 'WebP',
};

function formatSize(bytes: number): string {
  return bytes < 1024 * 1024
    ? `${Math.round(bytes / 1024)} KB`
    : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString('en-GB', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function AssignmentPanel({ assignmentId }: { assignmentId: string }) {
  const [assignment, setAssignment] = useState<Assignment | null>(null);
  const [staged, setStaged] = useState<StagedFile[]>([]);
  const [note, setNote] = useState('');
  const [uploading, setUploading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const data = await api.get<Assignment>(`/assignments/${assignmentId}`);
      setAssignment(data);
      setNote(data.submission?.studentNote ?? '');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load this assignment.');
    }
  }, [assignmentId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function upload(files: FileList) {
    if (!assignment) return;
    setUploading(true);
    setError(null);

    try {
      for (const file of Array.from(files)) {
        const grant = await api.post<{
          url: string;
          key: string;
          requiredHeaders: Record<string, string>;
        }>(`/assignments/${assignment.id}/upload-url`, {
          filename: file.name,
          mime: file.type,
          size: file.size,
        });

        // Every header the presign signed must be replayed exactly, or the
        // signature does not match and R2 rejects the PUT.
        const res = await fetch(grant.url, {
          method: 'PUT',
          headers: grant.requiredHeaders,
          body: file,
        });
        if (!res.ok) throw new Error('The upload did not complete. Try again.');

        setStaged((current) => [
          ...current,
          { key: grant.key, name: file.name, size: file.size, mime: file.type },
        ]);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not upload that file.');
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  }

  async function submit() {
    if (!assignment || staged.length === 0) return;
    setSubmitting(true);
    setError(null);
    try {
      await api.post(`/assignments/${assignment.id}/submit`, {
        files: staged,
        ...(note.trim() ? { studentNote: note.trim() } : {}),
      });
      setStaged([]);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not submit your work.');
    } finally {
      setSubmitting(false);
    }
  }

  if (!assignment && !error) return <Skeleton className="h-48 w-full" />;
  if (!assignment) return <ErrorNote onRetry={() => void load()}>{error}</ErrorNote>;

  const submission = assignment.submission;
  const overdue = assignment.dueAt ? new Date(assignment.dueAt) < new Date() : false;
  const closed = overdue && !assignment.allowLate && !submission;

  return (
    <div className="flex flex-col gap-4">
      <Card className="p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <h2 className="text-lg font-semibold text-[var(--color-foreground)]">
            {assignment.title}
          </h2>
          <span className="tabular shrink-0 text-sm text-[var(--color-muted-foreground)]">
            {assignment.maxMarks} marks
          </span>
        </div>

        <p className="prose-measure mt-3 whitespace-pre-line text-sm text-[var(--color-foreground)]">
          {assignment.instructions}
        </p>

        <p className="mt-4 text-sm text-[var(--color-muted-foreground)]">
          {assignment.dueAt ? (
            <>
              Due {formatDate(assignment.dueAt)}
              {overdue && (
                <>
                  {' — '}
                  {assignment.allowLate
                    ? 'the deadline has passed, late work is still accepted and flagged'
                    : 'the deadline has passed'}
                </>
              )}
            </>
          ) : (
            'No deadline.'
          )}
          {' · '}
          {assignment.allowedMime.map((m) => MIME_LABEL[m] ?? m).join(', ')} up to{' '}
          <span className="tabular">{assignment.maxFileMb}</span>MB each
        </p>
      </Card>

      {submission && (
        <Card className="p-5">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-base font-semibold text-[var(--color-foreground)]">
              Your submission
            </h3>
            {submission.isLate && <Badge tone="warning">Late</Badge>}
            {submission.gradedAt ? (
              <Badge tone="success">Marked</Badge>
            ) : (
              <Badge tone="info">Waiting to be marked</Badge>
            )}
          </div>

          <p className="mt-1 text-sm text-[var(--color-muted-foreground)]">
            Submitted {formatDate(submission.submittedAt)}
          </p>

          <ul className="mt-3 flex flex-col gap-1">
            {submission.files.map((file) => (
              <li key={file.name} className="flex items-center gap-2 text-sm">
                <ClipboardIcon className="size-4 shrink-0 text-[var(--color-muted-foreground)]" />
                <span className="text-[var(--color-foreground)]">{file.name}</span>
                <span className="tabular text-xs text-[var(--color-muted-foreground)]">
                  {formatSize(file.size)}
                </span>
              </li>
            ))}
          </ul>

          {submission.studentNote && (
            <p className="mt-3 whitespace-pre-line rounded-[var(--radius-md)] bg-[var(--color-surface-sunken)] p-3 text-sm text-[var(--color-foreground)]">
              {submission.studentNote}
            </p>
          )}

          {submission.gradedAt && (
            <div className="mt-4 border-t border-[var(--color-border)] pt-4">
              <p className="tabular text-2xl font-semibold text-[var(--color-foreground)]">
                {submission.marks} / {assignment.maxMarks}
              </p>
              {submission.teacherFeedback && (
                <p className="prose-measure mt-2 rounded-[var(--radius-md)] bg-[var(--color-cyan-tint)] p-3 text-sm text-[var(--color-foreground)]">
                  <span className="font-medium">Your teacher: </span>
                  {submission.teacherFeedback}
                </p>
              )}
            </div>
          )}

          {/* ADR 0004: replacing work is open until a mark is awarded, then
              locked. Said plainly rather than left as a disabled button. */}
          {submission.locked && (
            <p className="mt-4 flex items-start gap-2 text-sm text-[var(--color-muted-foreground)]">
              <LockIcon className="mt-0.5 size-4 shrink-0" />
              This has been marked, so it can no longer be changed.
            </p>
          )}
        </Card>
      )}

      {error && <ErrorNote>{error}</ErrorNote>}

      {closed ? (
        <p className="rounded-[var(--radius-md)] bg-[var(--color-coral-tint)] p-3 text-sm text-[var(--color-foreground)]">
          The deadline has passed and this assignment does not accept late work.
        </p>
      ) : (
        !submission?.locked && (
          <Card className="p-5">
            <h3 className="text-base font-semibold text-[var(--color-foreground)]">
              {submission ? 'Replace your submission' : 'Upload your work'}
            </h3>
            {submission && (
              <p className="mt-1 text-sm text-[var(--color-muted-foreground)]">
                Uploading again replaces what you sent before. You can keep doing this until your
                teacher marks it.
              </p>
            )}

            <label className="mt-3 block">
              <span className="sr-only">Choose files to upload</span>
              <input
                ref={fileInput}
                type="file"
                multiple
                accept={assignment.allowedMime.join(',')}
                disabled={uploading}
                onChange={(e) => e.target.files && void upload(e.target.files)}
                className="block w-full text-sm text-[var(--color-foreground)] file:mr-3 file:min-h-11 file:rounded-[var(--radius-md)] file:border file:border-[var(--color-border-strong)] file:bg-[var(--color-surface)] file:px-4 file:text-sm file:font-medium file:text-[var(--color-foreground)]"
              />
            </label>

            {uploading && (
              <p role="status" className="mt-2 text-sm text-[var(--color-muted-foreground)]">
                Uploading…
              </p>
            )}

            {staged.length > 0 && (
              <>
                <ul className="mt-3 flex flex-col gap-1">
                  {staged.map((file) => (
                    <li key={file.key} className="flex items-center gap-2 text-sm">
                      <span className="min-w-0 flex-1 truncate text-[var(--color-foreground)]">
                        {file.name}
                      </span>
                      <span className="tabular text-xs text-[var(--color-muted-foreground)]">
                        {formatSize(file.size)}
                      </span>
                      <button
                        type="button"
                        aria-label={`Remove ${file.name}`}
                        onClick={() =>
                          setStaged((current) => current.filter((f) => f.key !== file.key))
                        }
                        className="inline-flex size-11 items-center justify-center rounded-[var(--radius-md)] text-[var(--color-muted-foreground)] hover:bg-[var(--color-muted)] hover:text-[var(--color-destructive)]"
                      >
                        <TrashIcon className="size-4" />
                      </button>
                    </li>
                  ))}
                </ul>

                <div className="mt-4 flex flex-col gap-3">
                  <label className="text-sm font-medium text-[var(--color-foreground)]">
                    Note for your teacher (optional)
                    <Textarea
                      rows={2}
                      value={note}
                      onChange={(e) => setNote(e.target.value)}
                      className="mt-1"
                    />
                  </label>

                  <Button
                    variant="primary"
                    className="self-start"
                    loading={submitting}
                    onClick={() => void submit()}
                  >
                    {submission ? 'Replace submission' : 'Submit work'}
                  </Button>
                </div>
              </>
            )}
          </Card>
        )
      )}
    </div>
  );
}
