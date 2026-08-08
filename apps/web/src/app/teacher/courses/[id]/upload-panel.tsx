'use client';

import { useRef, useState } from 'react';
import { api } from '@/lib/client/api-client';
import { uploadDocument, uploadNotePages, uploadVideo, type NotePageFile } from '@/lib/client/uploads';
import { Badge, Button, ErrorNote, ProgressBar } from '@/components/ui';
import { TrashIcon } from '@/components/icons';
import type { LessonNode } from './curriculum';

/**
 * Attaches media to a lesson.
 *
 * Three flows behind one panel, chosen by lesson type:
 *   video  -> vendor credentials, direct multipart POST, then video-complete
 *   pdf     -> presigned PUT to R2, then record the key
 *   note    -> either a single PDF or N photographed pages (ADR 0001)
 *   image   -> presigned PUT to R2
 *
 * Uploads cannot be resumed, so the interface is built to avoid needing to:
 * the file is validated against the server's limits BEFORE any bytes move, the
 * progress bar is honest, and cancel is always available.
 */

const MAX_DOCUMENT_BYTES = 25 * 1024 * 1024;
const MAX_NOTE_PAGE_BYTES = 15 * 1024 * 1024;
const DOCUMENT_MIME = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'];
const IMAGE_MIME = ['image/jpeg', 'image/png', 'image/webp'];

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

type Phase =
  | { name: 'idle' }
  | { name: 'uploading'; percent: number }
  | { name: 'finishing' }
  | { name: 'done' };

export function UploadPanel({
  lesson,
  onUpdated,
}: {
  lesson: LessonNode;
  onUpdated: (patch: Partial<LessonNode>) => void;
}) {
  const [phase, setPhase] = useState<Phase>({ name: 'idle' });
  const [error, setError] = useState<string | null>(null);
  const [notePages, setNotePagesState] = useState<NotePageFile[]>([]);
  const abortRef = useRef<(() => void) | null>(null);

  const busy = phase.name === 'uploading' || phase.name === 'finishing';

  function reset() {
    abortRef.current = null;
    setPhase({ name: 'idle' });
  }

  async function run(
    handle: { start: () => Promise<void>; abort: () => void },
    onDone: () => void,
  ) {
    setError(null);
    abortRef.current = handle.abort;
    setPhase({ name: 'uploading', percent: 0 });

    try {
      await handle.start();
      setPhase({ name: 'finishing' });
      onDone();
      setPhase({ name: 'done' });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed.');
      setPhase({ name: 'idle' });
    } finally {
      abortRef.current = null;
    }
  }

  // ── Video ────────────────────────────────────────────────────────────────

  function pickVideo(file: File) {
    if (!file.type.startsWith('video/')) {
      setError('Choose a video file.');
      return;
    }
    void run(
      uploadVideo(lesson.id, file, (percent) => setPhase({ name: 'uploading', percent })),
      () =>
        onUpdated({
          videoStatus: 'transcoding',
          hasFile: true,
        }),
    );
  }

  async function removeVideo() {
    setError(null);
    setPhase({ name: 'finishing' });
    try {
      await api.del(`/teacher/lessons/${lesson.id}/video-complete`);
      onUpdated({ videoStatus: 'uploading', hasFile: false, isPublished: false });
      setPhase({ name: 'idle' });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not remove the video.');
      setPhase({ name: 'idle' });
    }
  }

  // ── Document ─────────────────────────────────────────────────────────────

  function pickDocument(file: File) {
    // Validated here as well as server-side, so a 25 MB rejection does not
    // arrive after a five-minute upload.
    if (!DOCUMENT_MIME.includes(file.type)) {
      setError('Choose a PDF, JPEG, PNG or WebP file.');
      return;
    }
    if (file.size > MAX_DOCUMENT_BYTES) {
      setError(`That file is ${formatBytes(file.size)}. The limit is 25 MB.`);
      return;
    }
    void run(
      uploadDocument(lesson.id, file, (percent) => setPhase({ name: 'uploading', percent })),
      () => onUpdated({ hasFile: true }),
    );
  }

  // ── Note pages ───────────────────────────────────────────────────────────

  function pickNotePages(files: FileList) {
    const chosen = Array.from(files);

    const badType = chosen.find((f) => !IMAGE_MIME.includes(f.type));
    if (badType) {
      setError(`"${badType.name}" is not a JPEG, PNG or WebP image.`);
      return;
    }
    const tooBig = chosen.find((f) => f.size > MAX_NOTE_PAGE_BYTES);
    if (tooBig) {
      setError(`"${tooBig.name}" is ${formatBytes(tooBig.size)}. The limit is 15 MB per page.`);
      return;
    }

    setError(null);
    // Sorted by filename so a phone's IMG_0001..IMG_0020 lands in the order the
    // pages were shot. The teacher can still reorder before uploading.
    setNotePagesState(
      [...chosen]
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
        .map((file, index) => ({ file, pageNumber: index + 1 })),
    );
  }

  function movePage(index: number, direction: -1 | 1) {
    const target = index + direction;
    if (target < 0 || target >= notePages.length) return;
    const next = [...notePages];
    const [moved] = next.splice(index, 1);
    if (!moved) return;
    next.splice(target, 0, moved);
    setNotePagesState(next.map((p, i) => ({ ...p, pageNumber: i + 1 })));
  }

  function uploadPages() {
    void run(
      uploadNotePages(lesson.id, notePages, (percent) =>
        setPhase({ name: 'uploading', percent }),
      ),
      () => {
        onUpdated({ hasFile: true, pageCount: notePages.length });
        setNotePagesState([]);
      },
    );
  }

  // ── Render ───────────────────────────────────────────────────────────────

  return (
    <div className="mt-3 rounded-[var(--radius-md)] bg-[var(--color-surface-sunken)] p-3">
      {error && (
        <div className="mb-3">
          <ErrorNote>{error}</ErrorNote>
        </div>
      )}

      {busy ? (
        <div className="flex flex-col gap-2">
          <ProgressBar
            value={phase.name === 'uploading' ? phase.percent : 100}
            label={`Uploading to ${lesson.title}`}
          />
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm text-[var(--color-muted-foreground)]" role="status">
              {phase.name === 'finishing'
                ? 'Finishing up, do not close this tab'
                : 'Uploading. Keep this tab open.'}
            </p>
            {/* Cancel stays available for the whole transfer: a teacher who
                picked the wrong 700 MB file should not have to wait it out. */}
            <Button
              size="sm"
              onClick={() => abortRef.current?.()}
              disabled={phase.name === 'finishing'}
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <>
          {lesson.type === 'video' && (
            <VideoControls
              lesson={lesson}
              onPick={pickVideo}
              onRemove={() => void removeVideo()}
              onDone={phase.name === 'done'}
              onReset={reset}
            />
          )}

          {(lesson.type === 'pdf' || lesson.type === 'image') && (
            <FilePicker
              label={lesson.hasFile ? 'Replace file' : 'Choose file'}
              accept={lesson.type === 'image' ? IMAGE_MIME.join(',') : DOCUMENT_MIME.join(',')}
              hint={
                lesson.hasFile
                  ? 'A file is attached. Uploading a new one replaces it.'
                  : 'PDF, JPEG, PNG or WebP. Up to 25 MB.'
              }
              onPick={(files) => files[0] && pickDocument(files[0])}
            />
          )}

          {lesson.type === 'note' && (
            <NoteControls
              lesson={lesson}
              pages={notePages}
              onPickSingle={pickDocument}
              onPickPages={pickNotePages}
              onMovePage={movePage}
              onRemovePage={(index) =>
                setNotePagesState(
                  notePages
                    .filter((_, i) => i !== index)
                    .map((p, i) => ({ ...p, pageNumber: i + 1 })),
                )
              }
              onUpload={uploadPages}
              onClear={() => setNotePagesState([])}
            />
          )}

          {(lesson.type === 'quiz' || lesson.type === 'assignment') && (
            <p className="text-sm text-[var(--color-muted-foreground)]">
              {lesson.type === 'quiz' ? 'Quizzes' : 'Assignments'} are built in a later phase.
            </p>
          )}
        </>
      )}
    </div>
  );
}

function VideoControls({
  lesson,
  onPick,
  onRemove,
  onDone,
  onReset,
}: {
  lesson: LessonNode;
  onPick: (file: File) => void;
  onRemove: () => void;
  onDone: boolean;
  onReset: () => void;
}) {
  if (lesson.videoStatus === 'ready' || lesson.videoStatus === 'transcoding' || onDone) {
    return (
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          {lesson.videoStatus === 'ready' ? (
            <Badge tone="success">Video ready</Badge>
          ) : (
            <Badge tone="warning">Processing</Badge>
          )}
          <p className="mt-1 text-sm text-[var(--color-muted-foreground)]">
            {lesson.videoStatus === 'ready'
              ? 'This video is encrypted and watermarked on playback.'
              : 'The video is being encoded. This page checks again every few minutes; you can leave and come back.'}
          </p>
        </div>
        <Button size="sm" variant="danger" onClick={() => { onReset(); onRemove(); }}>
          <TrashIcon className="size-4" />
          Remove video
        </Button>
      </div>
    );
  }

  if (lesson.videoStatus === 'failed') {
    return (
      <div className="flex flex-col gap-2">
        <Badge tone="danger">Processing failed</Badge>
        <p className="text-sm text-[var(--color-muted-foreground)]">
          The video service could not process that file. Remove it and upload again, ideally as MP4
          (H.264).
        </p>
        <div>
          <Button size="sm" variant="danger" onClick={onRemove}>
            Remove and try again
          </Button>
        </div>
      </div>
    );
  }

  return (
    <FilePicker
      label="Choose video"
      accept="video/*"
      hint="MP4 works best. The file uploads straight to the video service — it never passes through this site. Keep the tab open until it finishes."
      onPick={(files) => files[0] && onPick(files[0])}
    />
  );
}

function NoteControls({
  lesson,
  pages,
  onPickSingle,
  onPickPages,
  onMovePage,
  onRemovePage,
  onUpload,
  onClear,
}: {
  lesson: LessonNode;
  pages: NotePageFile[];
  onPickSingle: (file: File) => void;
  onPickPages: (files: FileList) => void;
  onMovePage: (index: number, direction: -1 | 1) => void;
  onRemovePage: (index: number) => void;
  onUpload: () => void;
  onClear: () => void;
}) {
  if (pages.length > 0) {
    return (
      <div className="flex flex-col gap-3">
        <p className="text-sm text-[var(--color-foreground)]">
          {pages.length} page(s) ready. Check the order before uploading.
        </p>

        <ol className="flex flex-col gap-1">
          {pages.map((page, index) => (
            <li
              key={`${page.file.name}-${index}`}
              className="flex items-center gap-2 rounded-[var(--radius-sm)] bg-[var(--color-surface)] px-2 py-1"
            >
              <span className="tabular w-8 shrink-0 text-sm text-[var(--color-muted-foreground)]">
                {page.pageNumber}.
              </span>
              <span className="min-w-0 flex-1 truncate text-sm text-[var(--color-foreground)]">
                {page.file.name}
              </span>
              <span className="tabular shrink-0 text-xs text-[var(--color-muted-foreground)]">
                {formatBytes(page.file.size)}
              </span>
              <button
                type="button"
                onClick={() => onMovePage(index, -1)}
                disabled={index === 0}
                aria-label={`Move page ${page.pageNumber} earlier`}
                className="min-h-9 shrink-0 px-2 text-sm text-[var(--color-primary)] disabled:opacity-35"
              >
                Up
              </button>
              <button
                type="button"
                onClick={() => onMovePage(index, 1)}
                disabled={index === pages.length - 1}
                aria-label={`Move page ${page.pageNumber} later`}
                className="min-h-9 shrink-0 px-2 text-sm text-[var(--color-primary)] disabled:opacity-35"
              >
                Down
              </button>
              <button
                type="button"
                onClick={() => onRemovePage(index)}
                aria-label={`Remove page ${page.pageNumber}`}
                className="min-h-9 shrink-0 px-2 text-sm text-[var(--color-destructive)]"
              >
                Remove
              </button>
            </li>
          ))}
        </ol>

        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="primary" onClick={onUpload}>
            Upload {pages.length} page(s)
          </Button>
          <Button size="sm" onClick={onClear}>
            Clear
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {lesson.hasFile && (
        <p className="text-sm text-[var(--color-muted-foreground)]">
          {lesson.pageCount ? `${lesson.pageCount} page(s) attached.` : 'A file is attached.'}{' '}
          Uploading again replaces what is there.
        </p>
      )}

      <FilePicker
        label="Upload a PDF"
        accept="application/pdf"
        hint="A single PDF of the note."
        onPick={(files) => files[0] && onPickSingle(files[0])}
      />

      <FilePicker
        label="Upload photographed pages"
        accept={IMAGE_MIME.join(',')}
        multiple
        hint="Photos of handwritten pages. Select them all at once; they are ordered by filename and you can adjust before uploading. Up to 15 MB per page."
        onPick={onPickPages}
      />
    </div>
  );
}

/**
 * A styled file input. The native input is visually hidden but kept in the tab
 * order and labelled, so keyboard and screen reader users get the real control
 * rather than a div pretending to be a button.
 */
function FilePicker({
  label,
  accept,
  hint,
  multiple,
  onPick,
}: {
  label: string;
  accept: string;
  hint: string;
  multiple?: boolean;
  onPick: (files: FileList) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <div className="flex flex-col gap-1.5">
      <label className="inline-flex w-fit min-h-11 cursor-pointer items-center gap-2 rounded-[var(--radius-md)] border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-4 text-sm font-medium text-[var(--color-foreground)] transition-colors duration-150 hover:bg-[var(--color-cyan-tint)] focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-[var(--color-ring)]">
        {label}
        <input
          ref={inputRef}
          type="file"
          accept={accept}
          multiple={multiple}
          className="sr-only"
          onChange={(event) => {
            const files = event.target.files;
            if (files && files.length > 0) onPick(files);
            // Reset so picking the same file twice still fires a change event.
            event.target.value = '';
          }}
        />
      </label>
      <p className="prose-measure text-sm text-[var(--color-muted-foreground)]">{hint}</p>
    </div>
  );
}
