'use client';

import { useCallback, useRef, useState } from 'react';
import Link from 'next/link';
import { ApiClientError, api } from '@/lib/client/api-client';
import { Badge, Button, Card, EmptyState, ErrorNote, Field, Input, Select } from '@/components/ui';
import { UploadPanel } from './upload-panel';
import {
  ChevronDownIcon,
  ChevronUpIcon,
  GripIcon,
  LessonTypeIcon,
  LockIcon,
  PlusIcon,
  TrashIcon,
} from '@/components/icons';

export type LessonNode = {
  id: string;
  moduleId: string;
  title: string;
  type: 'video' | 'pdf' | 'note' | 'image' | 'quiz' | 'assignment';
  displayOrder: number;
  isFree: boolean;
  isPublished: boolean;
  videoStatus: string | null;
  durationSeconds: number | null;
  pageCount: number | null;
  hasFile: boolean;
};

export type ModuleNode = {
  id: string;
  title: string;
  description: string | null;
  displayOrder: number;
  lessons: LessonNode[];
};

/**
 * Curriculum builder with reordering at both levels (Section 2.2).
 *
 * Reordering is exposed THREE ways on purpose:
 *
 *   1. Move up / move down buttons — the primary control. Keyboard reachable,
 *      works on touch, and announced to screen readers. Drag-and-drop alone
 *      excludes keyboard users entirely and is unusable on a phone with HTML5
 *      drag events.
 *   2. Native HTML5 drag — an enhancement for mouse users. Zero bytes of
 *      library, which matters on the connections Section 1.4 describes.
 *   3. An aria-live region announcing every move, so the result is not
 *      information conveyed by visual position alone.
 *
 * Moves are optimistic and roll back on failure. The server rejects any order
 * that is not exactly the current children, so a stale client cannot corrupt
 * the sequence — it gets a 422 and the previous order is restored.
 */
export function CurriculumBuilder({
  courseId,
  modules,
  onChange,
}: {
  courseId: string;
  modules: ModuleNode[];
  onChange: (next: ModuleNode[]) => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const [addingModule, setAddingModule] = useState(false);
  const dragRef = useRef<{ kind: 'module' | 'lesson'; moduleId?: string; index: number } | null>(
    null,
  );

  const persistModuleOrder = useCallback(
    async (next: ModuleNode[], previous: ModuleNode[]) => {
      onChange(next);
      try {
        await api.post(`/teacher/courses/${courseId}/reorder-modules`, {
          orderedIds: next.map((m) => m.id),
        });
      } catch (err) {
        // Roll back rather than leave the screen disagreeing with the database.
        onChange(previous);
        setError(err instanceof Error ? err.message : 'Could not save the new order.');
      }
    },
    [courseId, onChange],
  );

  const persistLessonOrder = useCallback(
    async (moduleId: string, next: ModuleNode[], previous: ModuleNode[]) => {
      onChange(next);
      const target = next.find((m) => m.id === moduleId);
      if (!target) return;
      try {
        await api.post(`/teacher/modules/${moduleId}/reorder`, {
          orderedIds: target.lessons.map((l) => l.id),
        });
      } catch (err) {
        onChange(previous);
        setError(err instanceof Error ? err.message : 'Could not save the new order.');
      }
    },
    [onChange],
  );

  function moveModule(index: number, direction: -1 | 1) {
    const target = index + direction;
    if (target < 0 || target >= modules.length) return;

    const next = [...modules];
    const [moved] = next.splice(index, 1);
    if (!moved) return;
    next.splice(target, 0, moved);

    setAnnouncement(`Moved module ${moved.title} to position ${target + 1} of ${next.length}.`);
    void persistModuleOrder(next, modules);
  }

  function moveLesson(moduleId: string, index: number, direction: -1 | 1) {
    const moduleIndex = modules.findIndex((m) => m.id === moduleId);
    const current = modules[moduleIndex];
    if (!current) return;

    const target = index + direction;
    if (target < 0 || target >= current.lessons.length) return;

    const lessons = [...current.lessons];
    const [moved] = lessons.splice(index, 1);
    if (!moved) return;
    lessons.splice(target, 0, moved);

    const next = [...modules];
    next[moduleIndex] = { ...current, lessons };

    setAnnouncement(`Moved lesson ${moved.title} to position ${target + 1} of ${lessons.length}.`);
    void persistLessonOrder(moduleId, next, modules);
  }

  function dropOnModule(index: number) {
    const drag = dragRef.current;
    dragRef.current = null;
    if (!drag || drag.kind !== 'module' || drag.index === index) return;

    // One splice, whatever the distance. Stepping repeatedly would apply the
    // move more than once for a multi-position drag.
    const next = [...modules];
    const [moved] = next.splice(drag.index, 1);
    if (!moved) return;
    next.splice(index, 0, moved);

    setAnnouncement(`Moved module ${moved.title} to position ${index + 1} of ${next.length}.`);
    void persistModuleOrder(next, modules);
  }

  function dropOnLesson(moduleId: string, index: number) {
    const drag = dragRef.current;
    dragRef.current = null;
    if (!drag || drag.kind !== 'lesson' || drag.moduleId !== moduleId || drag.index === index) return;

    const moduleIndex = modules.findIndex((m) => m.id === moduleId);
    const current = modules[moduleIndex];
    if (!current) return;

    const lessons = [...current.lessons];
    const [moved] = lessons.splice(drag.index, 1);
    if (!moved) return;
    lessons.splice(index, 0, moved);

    const next = [...modules];
    next[moduleIndex] = { ...current, lessons };
    void persistLessonOrder(moduleId, next, modules);
  }

  return (
    <section className="mt-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold text-[var(--color-foreground)]">Curriculum</h2>
        <Button onClick={() => setAddingModule((v) => !v)} aria-expanded={addingModule}>
          <PlusIcon className="size-4" />
          Add module
        </Button>
      </div>

      {/* Every reorder is announced. Position is otherwise conveyed only
          visually, which excludes screen reader users from the whole feature. */}
      <p aria-live="polite" className="sr-only">
        {announcement}
      </p>

      {error && (
        <div className="mt-4">
          <ErrorNote onRetry={() => setError(null)}>{error}</ErrorNote>
        </div>
      )}

      {addingModule && (
        <AddModuleForm
          courseId={courseId}
          onCancel={() => setAddingModule(false)}
          onAdded={(created) => {
            setAddingModule(false);
            onChange([...modules, { ...created, lessons: [] }]);
          }}
        />
      )}

      {modules.length === 0 && !addingModule && (
        <div className="mt-4">
          <EmptyState
            title="No modules yet"
            body="A course is organised into modules, and each module holds lessons. Add your first module to begin."
            action={
              <Button variant="primary" onClick={() => setAddingModule(true)}>
                Add module
              </Button>
            }
          />
        </div>
      )}

      <ol className="mt-4 flex flex-col gap-4">
        {modules.map((module, moduleIndex) => (
          <Card
            as="li"
            key={module.id}
            className="p-4"
            // Drag is an enhancement layered on top of the buttons below.
          >
            <div
              draggable
              onDragStart={() => {
                dragRef.current = { kind: 'module', index: moduleIndex };
              }}
              onDragOver={(e) => {
                if (dragRef.current?.kind === 'module') e.preventDefault();
              }}
              onDrop={() => dropOnModule(moduleIndex)}
              className="flex items-start gap-3"
            >
              <GripIcon className="mt-1 size-5 shrink-0 cursor-grab text-[var(--color-muted-foreground)]" />

              <div className="min-w-0 flex-1">
                <h3 className="text-base font-semibold text-[var(--color-foreground)]">
                  <span className="tabular text-[var(--color-muted-foreground)]">
                    {moduleIndex + 1}.
                  </span>{' '}
                  {module.title}
                </h3>
                {module.description && (
                  <p className="mt-1 text-sm text-[var(--color-muted-foreground)]">
                    {module.description}
                  </p>
                )}
              </div>

              <MoveControls
                label={`module ${module.title}`}
                canUp={moduleIndex > 0}
                canDown={moduleIndex < modules.length - 1}
                onUp={() => moveModule(moduleIndex, -1)}
                onDown={() => moveModule(moduleIndex, 1)}
              />

              <DeleteButton
                label={`module ${module.title}`}
                confirmBody={
                  module.lessons.length > 0
                    ? `This deletes ${module.lessons.length} lesson(s) and their uploaded files. This cannot be undone.`
                    : 'This cannot be undone.'
                }
                onConfirm={async () => {
                  await api.del(`/teacher/modules/${module.id}`);
                  onChange(modules.filter((m) => m.id !== module.id));
                }}
              />
            </div>

            <LessonList
              module={module}
              onMove={(index, direction) => moveLesson(module.id, index, direction)}
              onDragStart={(index) => {
                dragRef.current = { kind: 'lesson', moduleId: module.id, index };
              }}
              onDrop={(index) => dropOnLesson(module.id, index)}
              onChanged={(lessons) => {
                const next = [...modules];
                next[moduleIndex] = { ...module, lessons };
                onChange(next);
              }}
            />
          </Card>
        ))}
      </ol>
    </section>
  );
}

/**
 * The accessible reorder control. Disabled at the ends rather than hidden, so
 * the row's control count does not change as items move — a shifting number of
 * buttons is disorienting for keyboard and screen reader users alike.
 */
function MoveControls({
  label,
  canUp,
  canDown,
  onUp,
  onDown,
}: {
  label: string;
  canUp: boolean;
  canDown: boolean;
  onUp: () => void;
  onDown: () => void;
}) {
  return (
    <div className="flex shrink-0 flex-col">
      <button
        type="button"
        onClick={onUp}
        disabled={!canUp}
        // Icon-only, so it needs its own accessible name.
        aria-label={`Move ${label} up`}
        className="flex size-11 items-center justify-center rounded-[var(--radius-sm)] text-[var(--color-foreground)] transition-colors duration-150 hover:bg-[var(--color-muted)] disabled:opacity-35"
      >
        <ChevronUpIcon className="size-4" />
      </button>
      <button
        type="button"
        onClick={onDown}
        disabled={!canDown}
        aria-label={`Move ${label} down`}
        className="flex size-11 items-center justify-center rounded-[var(--radius-sm)] text-[var(--color-foreground)] transition-colors duration-150 hover:bg-[var(--color-muted)] disabled:opacity-35"
      >
        <ChevronDownIcon className="size-4" />
      </button>
    </div>
  );
}

/** Destructive actions confirm first and state what will be lost. */
function DeleteButton({
  label,
  confirmBody,
  onConfirm,
}: {
  label: string;
  confirmBody: string;
  onConfirm: () => Promise<void>;
}) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  if (!confirming) {
    return (
      <button
        type="button"
        onClick={() => setConfirming(true)}
        aria-label={`Delete ${label}`}
        className="flex size-11 shrink-0 items-center justify-center rounded-[var(--radius-sm)] text-[var(--color-destructive)] transition-colors duration-150 hover:bg-[var(--color-muted)]"
      >
        <TrashIcon className="size-4" />
      </button>
    );
  }

  return (
    <div className="flex shrink-0 flex-col items-end gap-2 rounded-[var(--radius-md)] border border-[var(--color-destructive)] p-2">
      <p className="max-w-56 text-xs text-[var(--color-foreground)]">{confirmBody}</p>
      <div className="flex gap-2">
        {/* Cancel first and visually dominant: the destructive option should not
            be the one under the thumb. */}
        <Button size="sm" onClick={() => setConfirming(false)} disabled={busy}>
          Cancel
        </Button>
        <Button
          size="sm"
          variant="danger"
          loading={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await onConfirm();
            } finally {
              setBusy(false);
              setConfirming(false);
            }
          }}
        >
          Delete
        </Button>
      </div>
    </div>
  );
}

function LessonList({
  module,
  onMove,
  onDragStart,
  onDrop,
  onChanged,
}: {
  module: ModuleNode;
  onMove: (index: number, direction: -1 | 1) => void;
  onDragStart: (index: number) => void;
  onDrop: (index: number) => void;
  onChanged: (lessons: LessonNode[]) => void;
}) {
  const [adding, setAdding] = useState(false);
  // One lesson open at a time: two upload forms visible at once invites
  // starting a second transfer that competes for the same connection.
  const [expandedId, setExpandedId] = useState<string | null>(null);

  return (
    <div className="mt-3 border-t border-[var(--color-border)] pt-3 pl-8">
      {module.lessons.length === 0 && !adding && (
        <p className="text-sm text-[var(--color-muted-foreground)]">No lessons in this module yet.</p>
      )}

      <ol className="flex flex-col">
        {module.lessons.map((lesson, index) => (
          <li
            key={lesson.id}
            draggable
            onDragStart={() => onDragStart(index)}
            onDragOver={(e) => e.preventDefault()}
            onDrop={() => onDrop(index)}
            className="border-b border-[var(--color-border)] py-2 last:border-b-0"
          >
            <div className="flex items-center gap-3">
              <LessonTypeIcon
                type={lesson.type}
                className="size-4 shrink-0 text-[var(--color-muted-foreground)]"
              />

              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-[var(--color-foreground)]">{lesson.title}</p>
                <div className="mt-1 flex flex-wrap items-center gap-2">
                  <LessonStatus lesson={lesson} />
                </div>
              </div>

              {/* Files are behind a disclosure rather than always open: a module
                  with twenty lessons would otherwise be twenty upload forms. */}
              <button
                type="button"
                onClick={() => setExpandedId(expandedId === lesson.id ? null : lesson.id)}
                aria-expanded={expandedId === lesson.id}
                aria-controls={`upload-${lesson.id}`}
                className="min-h-11 shrink-0 rounded-[var(--radius-sm)] px-3 text-sm font-medium text-[var(--color-primary)] transition-colors duration-150 hover:bg-[var(--color-cyan-tint)]"
              >
                {expandedId === lesson.id ? 'Close' : 'Files'}
              </button>

              <MoveControls
                label={`lesson ${lesson.title}`}
                canUp={index > 0}
                canDown={index < module.lessons.length - 1}
                onUp={() => onMove(index, -1)}
                onDown={() => onMove(index, 1)}
              />

              <DeleteButton
                label={`lesson ${lesson.title}`}
                confirmBody="This deletes the lesson and any uploaded video or file. This cannot be undone."
                onConfirm={async () => {
                  await api.del(`/teacher/lessons/${lesson.id}`);
                  onChanged(module.lessons.filter((l) => l.id !== lesson.id));
                }}
              />
            </div>

            {expandedId === lesson.id && (
              <div id={`upload-${lesson.id}`}>
                {/* Teachers resolve as 'owner' in checkLessonAccess, so this
                    opens the real student viewer with real DRM and a real
                    watermark — not a mock preview. It is the Phase 1 exit
                    criterion: upload a lecture and watch it protected. */}
                <Link
                  href={`/learn/lessons/${lesson.id}`}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-3 inline-flex min-h-11 items-center rounded-[var(--radius-md)] px-3 text-sm font-medium text-[var(--color-primary)] transition-colors duration-150 hover:bg-[var(--color-cyan-tint)]"
                >
                  Preview as student
                  <span className="sr-only"> (opens in a new tab)</span>
                </Link>

                <UploadPanel
                  lesson={lesson}
                  onUpdated={(patch) =>
                    onChanged(
                      module.lessons.map((l) => (l.id === lesson.id ? { ...l, ...patch } : l)),
                    )
                  }
                />

                <PublishToggle
                  lesson={lesson}
                  onUpdated={(patch) =>
                    onChanged(
                      module.lessons.map((l) => (l.id === lesson.id ? { ...l, ...patch } : l)),
                    )
                  }
                />
              </div>
            )}
          </li>
        ))}
      </ol>

      {adding ? (
        <AddLessonForm
          moduleId={module.id}
          onCancel={() => setAdding(false)}
          onAdded={(created) => {
            setAdding(false);
            onChanged([...module.lessons, created]);
          }}
        />
      ) : (
        <Button size="sm" variant="ghost" className="mt-2" onClick={() => setAdding(true)}>
          <PlusIcon className="size-4" />
          Add lesson
        </Button>
      )}
    </div>
  );
}

/**
 * Publish and free-preview switches.
 *
 * Publishing a video the vendor has not finished processing is refused by the
 * server (409). The button is disabled here too, with the reason stated, so the
 * teacher is not left clicking something that keeps failing.
 */
function PublishToggle({
  lesson,
  onUpdated,
}: {
  lesson: LessonNode;
  onUpdated: (patch: Partial<LessonNode>) => void;
}) {
  const [busy, setBusy] = useState<'publish' | 'free' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const videoNotReady = lesson.type === 'video' && lesson.videoStatus !== 'ready';
  const missingFile = lesson.type !== 'video' && lesson.type !== 'quiz' && !lesson.hasFile;
  const blocked = videoNotReady || missingFile;

  async function patch(body: Partial<LessonNode>, which: 'publish' | 'free') {
    setBusy(which);
    setError(null);
    try {
      onUpdated(await api.patch<LessonNode>(`/teacher/lessons/${lesson.id}`, body));
    } catch (err) {
      setError(
        err instanceof ApiClientError ? err.message : 'Could not update the lesson.',
      );
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="mt-2 flex flex-wrap items-center gap-3 rounded-[var(--radius-md)] bg-[var(--color-surface-sunken)] px-3 py-2">
      <Button
        size="sm"
        variant={lesson.isPublished ? 'secondary' : 'primary'}
        loading={busy === 'publish'}
        disabled={blocked && !lesson.isPublished}
        onClick={() => void patch({ isPublished: !lesson.isPublished }, 'publish')}
      >
        {lesson.isPublished ? 'Unpublish lesson' : 'Publish lesson'}
      </Button>

      <label className="flex min-h-11 items-center gap-2 text-sm text-[var(--color-foreground)]">
        <input
          type="checkbox"
          checked={lesson.isFree}
          disabled={busy === 'free'}
          onChange={(e) => void patch({ isFree: e.target.checked }, 'free')}
          className="size-4"
        />
        Free preview
      </label>

      {blocked && !lesson.isPublished && (
        <p className="text-sm text-[var(--color-muted-foreground)]">
          {videoNotReady
            ? 'Upload a video and wait for processing before publishing.'
            : 'Attach a file before publishing.'}
        </p>
      )}

      {error && (
        <div className="w-full">
          <ErrorNote>{error}</ErrorNote>
        </div>
      )}
    </div>
  );
}

/** Status pairs an icon or word with colour — never colour alone. */
function LessonStatus({ lesson }: { lesson: LessonNode }) {
  const badges = [];

  if (lesson.isPublished) badges.push(<Badge key="pub" tone="success">Published</Badge>);
  else badges.push(<Badge key="draft" tone="info">Draft</Badge>);

  if (lesson.isFree) {
    badges.push(
      <Badge key="free" tone="neutral">
        Free preview
      </Badge>,
    );
  }

  if (lesson.type === 'video') {
    if (lesson.videoStatus === 'ready') {
      badges.push(
        <Badge key="v" tone="success">
          Video ready
        </Badge>,
      );
    } else if (lesson.videoStatus === 'transcoding') {
      // The cron polls every 5 minutes, so say so rather than leaving the
      // teacher refreshing.
      badges.push(
        <Badge key="v" tone="warning">
          Processing, checked every 5 min
        </Badge>,
      );
    } else if (lesson.videoStatus === 'failed') {
      badges.push(
        <Badge key="v" tone="danger">
          Processing failed
        </Badge>,
      );
    } else {
      badges.push(
        <Badge key="v" tone="neutral">
          No video uploaded
        </Badge>,
      );
    }
  } else if (!lesson.hasFile) {
    badges.push(
      <Badge key="f" tone="neutral">
        No file uploaded
      </Badge>,
    );
  }

  if (!lesson.isPublished && lesson.type === 'video' && lesson.videoStatus !== 'ready') {
    badges.push(
      <span
        key="lock"
        className="inline-flex items-center gap-1 text-xs text-[var(--color-muted-foreground)]"
      >
        <LockIcon className="size-3.5" />
        Cannot publish until processed
      </span>,
    );
  }

  return <>{badges}</>;
}

function AddModuleForm({
  courseId,
  onCancel,
  onAdded,
}: {
  courseId: string;
  onCancel: () => void;
  onAdded: (module: Omit<ModuleNode, 'lessons'>) => void;
}) {
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <Card className="mt-4 p-4">
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true);
          setError(null);
          try {
            const created = await api.post<Omit<ModuleNode, 'lessons'>>(
              `/teacher/courses/${courseId}/modules`,
              { title },
            );
            onAdded(created);
          } catch (err) {
            setError(err instanceof Error ? err.message : 'Could not add the module.');
          } finally {
            setBusy(false);
          }
        }}
        className="flex flex-col gap-3"
        noValidate
      >
        <Field label="Module title" required>
          {(props) => (
            <Input
              {...props}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Chapter 1: Vectors"
              autoFocus
              required
            />
          )}
        </Field>

        {error && <ErrorNote>{error}</ErrorNote>}

        <div className="flex gap-2">
          <Button type="submit" variant="primary" size="sm" loading={busy}>
            Add module
          </Button>
          <Button type="button" size="sm" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
        </div>
      </form>
    </Card>
  );
}

function AddLessonForm({
  moduleId,
  onCancel,
  onAdded,
}: {
  moduleId: string;
  onCancel: () => void;
  onAdded: (lesson: LessonNode) => void;
}) {
  const [title, setTitle] = useState('');
  const [type, setType] = useState<LessonNode['type']>('video');
  const [isFree, setIsFree] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <Card className="mt-3 p-4">
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true);
          setError(null);
          try {
            const created = await api.post<LessonNode>(`/teacher/modules/${moduleId}/lessons`, {
              title,
              type,
              isFree,
            });
            onAdded({ ...created, hasFile: false });
          } catch (err) {
            setError(err instanceof Error ? err.message : 'Could not add the lesson.');
          } finally {
            setBusy(false);
          }
        }}
        className="flex flex-col gap-3"
        noValidate
      >
        <Field label="Lesson title" required>
          {(props) => (
            <Input
              {...props}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Introduction to vectors"
              autoFocus
              required
            />
          )}
        </Field>

        <Field
          label="Lesson type"
          hint="Notes are uploaded as PDFs or photos of handwritten pages. This cannot be changed once a file is attached."
        >
          {(props) => (
            <Select
              {...props}
              value={type}
              onChange={(e) => setType(e.target.value as LessonNode['type'])}
            >
              <option value="video">Video lecture</option>
              <option value="pdf">PDF document</option>
              <option value="note">Note (PDF or photos)</option>
              <option value="image">Image</option>
              <option value="quiz">Quiz</option>
              <option value="assignment">Assignment</option>
            </Select>
          )}
        </Field>

        <label className="flex min-h-11 items-center gap-2 text-sm text-[var(--color-foreground)]">
          <input
            type="checkbox"
            checked={isFree}
            onChange={(e) => setIsFree(e.target.checked)}
            className="size-4"
          />
          Free preview — anyone can view this without paying
        </label>

        {error && <ErrorNote>{error}</ErrorNote>}

        <div className="flex gap-2">
          <Button type="submit" variant="primary" size="sm" loading={busy}>
            Add lesson
          </Button>
          <Button type="button" size="sm" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
        </div>
      </form>
    </Card>
  );
}
