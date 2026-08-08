'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { formatPoisha } from '@edtech/shared';
import { api } from '@/lib/client/api-client';
import { AuthProvider } from '@/components/auth-provider';
import { SiteHeader } from '@/components/site-header';
import { Badge, Card, EmptyState, ErrorNote, Field, Input, Select, Skeleton } from '@/components/ui';

type CatalogCourse = {
  id: string;
  slug: string;
  title: string;
  subtitle: string | null;
  subject: string | null;
  level: string | null;
  pricePoisha: number;
  isInAllAccess: boolean;
  teacherName: string;
  lessonCount: number;
  freeLessonCount: number;
};

type CatalogResponse = {
  courses: CatalogCourse[];
  page: number;
  perPage: number;
  total: number;
  facets: { levels: string[]; subjects: string[] };
};

/**
 * The public catalog.
 *
 * Works signed out — a visitor should be able to see what is on offer and watch
 * a free lesson before being asked for anything. The free-lesson count is shown
 * on every card because that is the funnel (Section 2.3).
 */
function CatalogScreen() {
  const [data, setData] = useState<CatalogResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [level, setLevel] = useState('');
  const [subject, setSubject] = useState('');

  const load = useCallback(async () => {
    setError(null);
    const params = new URLSearchParams();
    if (q) params.set('q', q);
    if (level) params.set('level', level);
    if (subject) params.set('subject', subject);

    try {
      setData(await api.get<CatalogResponse>(`/courses?${params.toString()}`));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load the courses.');
    }
  }, [q, level, subject]);

  useEffect(() => {
    // Debounced so typing a search term does not fire a request per keystroke
    // over a metered connection.
    const timer = setTimeout(() => void load(), q ? 350 : 0);
    return () => clearTimeout(timer);
  }, [load, q]);

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6">
      <h1 className="text-2xl font-semibold text-[var(--color-foreground)]">Courses</h1>
      <p className="prose-measure mt-2 text-sm text-[var(--color-muted-foreground)]">
        Recorded lessons from your teachers. Try a free lesson before you buy.
      </p>

      <div className="mt-5 grid gap-3 sm:grid-cols-3">
        <Field label="Search">
          {(props) => (
            <Input
              {...props}
              type="search"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Physics, Chemistry…"
            />
          )}
        </Field>

        <Field label="Level">
          {(props) => (
            <Select {...props} value={level} onChange={(e) => setLevel(e.target.value)}>
              <option value="">All levels</option>
              {data?.facets.levels.map((l) => (
                <option key={l} value={l}>
                  {l}
                </option>
              ))}
            </Select>
          )}
        </Field>

        <Field label="Subject">
          {(props) => (
            <Select {...props} value={subject} onChange={(e) => setSubject(e.target.value)}>
              <option value="">All subjects</option>
              {data?.facets.subjects.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </Select>
          )}
        </Field>
      </div>

      {error && (
        <div className="mt-6">
          <ErrorNote onRetry={() => void load()}>{error}</ErrorNote>
        </div>
      )}

      {data === null && !error && (
        <div className="mt-6 grid gap-4 sm:grid-cols-2">
          <Skeleton className="h-40 w-full" />
          <Skeleton className="h-40 w-full" />
          <span className="sr-only" role="status">
            Loading courses
          </span>
        </div>
      )}

      {data?.courses.length === 0 && (
        <div className="mt-6">
          <EmptyState
            title="No courses match"
            body={
              q || level || subject
                ? 'Try clearing the filters or searching for something else.'
                : 'No courses have been published yet. Check back soon.'
            }
          />
        </div>
      )}

      {data && data.courses.length > 0 && (
        <>
          <p className="mt-6 text-sm text-[var(--color-muted-foreground)]">
            <span className="tabular font-medium text-[var(--color-foreground)]">
              {data.total}
            </span>{' '}
            course{data.total === 1 ? '' : 's'}
          </p>

          <ul className="mt-3 grid gap-4 sm:grid-cols-2">
            {data.courses.map((course) => (
              <Card as="li" key={course.id}>
                <Link
                  href={`/courses/${course.slug}`}
                  className="flex h-full flex-col p-4 transition-colors duration-150 hover:bg-[var(--color-muted)]"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    {course.level && <Badge tone="info">{course.level}</Badge>}
                    {course.subject && <Badge tone="neutral">{course.subject}</Badge>}
                    {/* The funnel: say plainly that something is watchable now. */}
                    {course.freeLessonCount > 0 && (
                      <Badge tone="warning">{course.freeLessonCount} free</Badge>
                    )}
                  </div>

                  <h2 className="mt-2 text-base font-semibold text-[var(--color-foreground)]">
                    {course.title}
                  </h2>
                  {course.subtitle && (
                    <p className="mt-1 text-sm text-[var(--color-muted-foreground)]">
                      {course.subtitle}
                    </p>
                  )}

                  <p className="mt-1 text-sm text-[var(--color-muted-foreground)]">
                    {course.teacherName} ·{' '}
                    <span className="tabular">{course.lessonCount}</span> lesson
                    {course.lessonCount === 1 ? '' : 's'}
                  </p>

                  <p className="tabular mt-3 text-lg font-semibold text-[var(--color-foreground)]">
                    {course.pricePoisha === 0 ? 'Free' : formatPoisha(course.pricePoisha)}
                  </p>
                </Link>
              </Card>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

export default function HomePage() {
  return (
    <AuthProvider>
      <SiteHeader />
      <CatalogScreen />
    </AuthProvider>
  );
}
