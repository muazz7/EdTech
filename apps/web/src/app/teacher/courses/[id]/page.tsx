'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { formatPoisha } from '@edtech/shared';
import { ApiClientError, api } from '@/lib/client/api-client';
import {
  Badge,
  Button,
  Card,
  ErrorNote,
  Field,
  Input,
  Skeleton,
} from '@/components/ui';
import { CurriculumBuilder, type ModuleNode } from './curriculum';

type CourseSummary = {
  id: string;
  title: string;
  slug: string;
  state: 'draft' | 'published' | 'archived';
  pricePoisha: number;
  isInAllAccess: boolean;
};

export default function CourseBuilderPage() {
  const params = useParams<{ id: string }>();
  const courseId = params.id;

  const [modules, setModules] = useState<ModuleNode[] | null>(null);
  const [course, setCourse] = useState<CourseSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      // The curriculum endpoint returns the tree; the list endpoint carries the
      // course's own fields. Two calls rather than widening the tree response,
      // so the builder does not re-download course metadata on every reorder.
      const [tree, list] = await Promise.all([
        api.get<ModuleNode[]>(`/teacher/courses/${courseId}`),
        api.get<CourseSummary[]>('/teacher/courses'),
      ]);
      setModules(tree);
      setCourse(list.find((c) => c.id === courseId) ?? null);
    } catch (err) {
      if (err instanceof ApiClientError && err.status === 404) {
        setError('That course does not exist, or it belongs to another teacher.');
      } else {
        setError(err instanceof Error ? err.message : 'Could not load the course.');
      }
    }
  }, [courseId]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6">
      {/* Breadcrumb: the builder is three levels deep and the back path must be
          obvious, not just the browser button. */}
      <nav aria-label="Breadcrumb" className="text-sm">
        <Link
          href="/teacher"
          className="rounded-[var(--radius-sm)] text-[var(--color-primary)] hover:underline"
        >
          Your courses
        </Link>
        <span className="mx-2 text-[var(--color-muted-foreground)]" aria-hidden="true">
          /
        </span>
        <span className="text-[var(--color-muted-foreground)]">
          {course?.title ?? 'Course'}
        </span>
      </nav>

      {error && (
        <div className="mt-4">
          <ErrorNote onRetry={() => void load()}>{error}</ErrorNote>
        </div>
      )}

      {!course && !error && (
        <div className="mt-4 flex flex-col gap-3">
          <Skeleton className="h-9 w-72" />
          <Skeleton className="h-28 w-full" />
          <span className="sr-only" role="status">
            Loading course
          </span>
        </div>
      )}

      {course && (
        <>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <h1 className="text-2xl font-semibold text-[var(--color-foreground)]">
              {course.title}
            </h1>
            {course.state === 'published' ? (
              <Badge tone="success">Published</Badge>
            ) : (
              <Badge tone="info">Draft</Badge>
            )}
          </div>

          <CourseSettings course={course} onSaved={setCourse} />
        </>
      )}

      {modules && (
        <CurriculumBuilder courseId={courseId} modules={modules} onChange={setModules} />
      )}
    </div>
  );
}

function CourseSettings({
  course,
  onSaved,
}: {
  course: CourseSummary;
  onSaved: (next: CourseSummary) => void;
}) {
  const [priceBdt, setPriceBdt] = useState((course.pricePoisha / 100).toString());
  const [busy, setBusy] = useState<'price' | 'state' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  async function savePrice(event: React.FormEvent) {
    event.preventDefault();
    setBusy('price');
    setError(null);
    setSaved(false);
    try {
      const next = await api.patch<CourseSummary>(`/teacher/courses/${course.id}`, {
        pricePoisha: Math.round(Number(priceBdt) * 100),
      });
      onSaved(next);
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the price.');
    } finally {
      setBusy(null);
    }
  }

  async function togglePublished() {
    const nextState = course.state === 'published' ? 'draft' : 'published';
    setBusy('state');
    setError(null);
    try {
      onSaved(
        await api.patch<CourseSummary>(`/teacher/courses/${course.id}`, { state: nextState }),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not change the course state.');
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card className="mt-6 p-5">
      <h2 className="text-base font-semibold text-[var(--color-foreground)]">Course settings</h2>

      <div className="mt-4 grid gap-6 sm:grid-cols-2">
        <form onSubmit={savePrice} className="flex flex-col gap-3" noValidate>
          <Field
            label="Price (BDT)"
            hint="Zero makes the course free. Every price change is recorded with your name and the time."
          >
            {(props) => (
              <Input
                {...props}
                type="number"
                inputMode="decimal"
                min="0"
                step="1"
                value={priceBdt}
                onChange={(e) => {
                  setPriceBdt(e.target.value);
                  setSaved(false);
                }}
                className="tabular"
              />
            )}
          </Field>

          <div className="flex items-center gap-3">
            <Button
              type="submit"
              size="sm"
              loading={busy === 'price'}
              disabled={Math.round(Number(priceBdt) * 100) === course.pricePoisha}
            >
              Save price
            </Button>
            {/* Brief confirmation that the write landed. Without it the teacher
                cannot tell a saved form from an ignored one. */}
            {saved && (
              <span role="status" className="text-sm text-[var(--color-success)]">
                Saved — now {formatPoisha(course.pricePoisha)}
              </span>
            )}
          </div>
        </form>

        <div className="flex flex-col gap-3">
          <div>
            <h3 className="text-sm font-medium text-[var(--color-foreground)]">Visibility</h3>
            <p className="mt-1 text-sm text-[var(--color-muted-foreground)]">
              {course.state === 'published'
                ? 'Students can find this course in the catalog. Unpublishing hides it; anyone who already bought it keeps their access.'
                : 'Only you can see this course. Publish it when the curriculum is ready.'}
            </p>
          </div>

          <Button
            size="sm"
            variant={course.state === 'published' ? 'secondary' : 'primary'}
            loading={busy === 'state'}
            onClick={() => void togglePublished()}
          >
            {course.state === 'published' ? 'Unpublish course' : 'Publish course'}
          </Button>
        </div>
      </div>

      {error && (
        <div className="mt-4">
          <ErrorNote>{error}</ErrorNote>
        </div>
      )}
    </Card>
  );
}
