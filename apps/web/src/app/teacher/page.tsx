'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { formatPoisha } from '@edtech/shared';
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
import { ChevronRightIcon, PlusIcon } from '@/components/icons';

type CourseRow = {
  id: string;
  slug: string;
  title: string;
  subtitle: string | null;
  state: 'draft' | 'published' | 'archived';
  pricePoisha: number;
  isInAllAccess: boolean;
  subject: string | null;
  level: string | null;
  updatedAt: string;
};

/** Derives a slug from the title so the teacher does not have to think about
 *  URL syntax. Editable, and permanent once created. */
function slugify(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 120);
}

export default function TeacherCoursesPage() {
  const [courses, setCourses] = useState<CourseRow[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      setCourses(await api.get<CourseRow[]>('/teacher/courses'));
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Could not load your courses.');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold text-[var(--color-foreground)]">Your courses</h1>
        {/* One primary action per screen. */}
        <Button variant="primary" onClick={() => setCreating((v) => !v)} aria-expanded={creating}>
          <PlusIcon className="size-4" />
          New course
        </Button>
      </div>

      {creating && (
        <CreateCourseForm
          onCancel={() => setCreating(false)}
          onCreated={async () => {
            setCreating(false);
            await load();
          }}
        />
      )}

      {loadError && (
        <div className="mt-6">
          <ErrorNote onRetry={() => void load()}>{loadError}</ErrorNote>
        </div>
      )}

      {courses === null && !loadError && (
        <div className="mt-6 flex flex-col gap-3">
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-20 w-full" />
          <span className="sr-only" role="status">
            Loading courses
          </span>
        </div>
      )}

      {courses?.length === 0 && (
        <div className="mt-6">
          <EmptyState
            title="No courses yet"
            body="Create your first course, add modules and lessons, then upload a lecture. Nothing is visible to students until you publish it."
            action={
              <Button variant="primary" onClick={() => setCreating(true)}>
                Create a course
              </Button>
            }
          />
        </div>
      )}

      {courses && courses.length > 0 && (
        <ul className="mt-6 flex flex-col gap-3">
          {courses.map((course) => (
            <Card as="li" key={course.id}>
              <Link
                href={`/teacher/courses/${course.id}`}
                className="flex items-center gap-4 p-4 transition-colors duration-150 hover:bg-[var(--color-muted)]"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    {/* Wraps rather than truncates: a Bangla course title
                        truncated at 40 chars is often unreadable. */}
                    <h2 className="text-base font-semibold text-[var(--color-foreground)]">
                      {course.title}
                    </h2>
                    <StateBadge state={course.state} />
                    {!course.isInAllAccess && <Badge tone="warning">Not in all-access</Badge>}
                  </div>

                  {course.subtitle && (
                    <p className="mt-1 text-sm text-[var(--color-muted-foreground)]">
                      {course.subtitle}
                    </p>
                  )}

                  <p className="mt-1 text-sm text-[var(--color-muted-foreground)]">
                    <span className="tabular">{formatPoisha(course.pricePoisha)}</span>
                    {course.level && <> · {course.level}</>}
                    {course.subject && <> · {course.subject}</>}
                  </p>
                </div>

                <ChevronRightIcon className="size-5 shrink-0 text-[var(--color-muted-foreground)]" />
              </Link>
            </Card>
          ))}
        </ul>
      )}
    </div>
  );
}

function StateBadge({ state }: { state: CourseRow['state'] }) {
  if (state === 'published') return <Badge tone="success">Published</Badge>;
  if (state === 'archived') return <Badge tone="neutral">Archived</Badge>;
  return <Badge tone="info">Draft</Badge>;
}

function CreateCourseForm({
  onCancel,
  onCreated,
}: {
  onCancel: () => void;
  onCreated: () => Promise<void>;
}) {
  const [title, setTitle] = useState('');
  const [slug, setSlug] = useState('');
  const [slugEdited, setSlugEdited] = useState(false);
  const [subtitle, setSubtitle] = useState('');
  const [priceBdt, setPriceBdt] = useState('0');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [slugError, setSlugError] = useState<string | null>(null);

  const effectiveSlug = slugEdited ? slug : slugify(title);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setSlugError(null);

    try {
      await api.post('/teacher/courses', {
        title,
        slug: effectiveSlug,
        subtitle: subtitle || undefined,
        // BDT in the field, poisha on the wire. Money is integer poisha
        // everywhere below this line (Appendix B).
        pricePoisha: Math.round(Number(priceBdt) * 100),
      });
      await onCreated();
    } catch (err) {
      if (err instanceof ApiClientError && err.code === 'CONFLICT') {
        setSlugError('That URL slug is already taken. Try another.');
      } else if (err instanceof ApiClientError && err.status === 422) {
        const fields = err.details as Record<string, string[]> | undefined;
        setSlugError(fields?.slug?.[0] ?? null);
        setError(fields?.slug ? null : 'Check the highlighted fields.');
      } else {
        setError(err instanceof Error ? err.message : 'Could not create the course.');
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="mt-6 p-5">
      <h2 className="text-base font-semibold text-[var(--color-foreground)]">New course</h2>

      <form onSubmit={submit} className="mt-4 flex flex-col gap-4" noValidate>
        <Field label="Title" required>
          {(props) => (
            <Input
              {...props}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="HSC Physics 1st Paper"
              required
            />
          )}
        </Field>

        <Field
          label="URL slug"
          hint="Used in the course link. Cannot be changed after the course is created."
          error={slugError ?? undefined}
          required
        >
          {(props) => (
            <Input
              {...props}
              value={effectiveSlug}
              onChange={(e) => {
                setSlugEdited(true);
                setSlug(slugify(e.target.value));
              }}
              placeholder="hsc-physics-1st-paper"
              required
            />
          )}
        </Field>

        <Field label="Subtitle" hint="Optional. One line shown under the title.">
          {(props) => (
            <Textarea
              {...props}
              value={subtitle}
              onChange={(e) => setSubtitle(e.target.value)}
              rows={2}
            />
          )}
        </Field>

        <Field
          label="Price (BDT)"
          hint="Single-course lifetime price. Zero makes the course free. You can change this later; every change is recorded."
        >
          {(props) => (
            <Input
              {...props}
              type="number"
              inputMode="decimal"
              min="0"
              step="1"
              value={priceBdt}
              onChange={(e) => setPriceBdt(e.target.value)}
              className="tabular"
            />
          )}
        </Field>

        {error && <ErrorNote>{error}</ErrorNote>}

        <div className="flex flex-wrap gap-2">
          <Button type="submit" variant="primary" loading={busy}>
            {busy ? 'Creating' : 'Create course'}
          </Button>
          <Button type="button" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
        </div>
      </form>
    </Card>
  );
}
