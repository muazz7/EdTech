'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { formatPoisha } from '@edtech/shared';
import { ApiClientError, api } from '@/lib/client/api-client';
import { AuthProvider, useAuth } from '@/components/auth-provider';
import { SiteHeader } from '@/components/site-header';
import { Badge, Card, ErrorNote, Skeleton } from '@/components/ui';
import { LessonTypeIcon, LockIcon } from '@/components/icons';

type CourseDetail = {
  id: string;
  slug: string;
  title: string;
  subtitle: string | null;
  description: string | null;
  subject: string | null;
  level: string | null;
  pricePoisha: number;
  teacherName: string;
  teacherInstitution: string | null;
};

type CurriculumLesson = {
  id: string;
  title: string;
  type: string;
  isFree: boolean;
  locked: boolean;
  durationSeconds: number | null;
};

type Curriculum = {
  courseId: string;
  entitled: boolean;
  via: string | null;
  modules: Array<{ id: string; title: string; lessons: CurriculumLesson[] }>;
};

function formatDuration(seconds: number): string {
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/**
 * Public course page.
 *
 * The full curriculum is visible to everyone, locked lessons included — the
 * curriculum IS the sales pitch, and a paywall that hides what it is selling
 * does not convert. Durations only appear for lessons the visitor can actually
 * open, so a paid course's runtime is not readable for free.
 */
function CourseScreen() {
  const params = useParams<{ slug: string }>();
  const { state } = useAuth();

  const [course, setCourse] = useState<CourseDetail | null>(null);
  const [curriculum, setCurriculum] = useState<Curriculum | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [detail, tree] = await Promise.all([
        api.get<CourseDetail>(`/courses/${params.slug}`),
        api.get<Curriculum>(`/courses/${params.slug}/curriculum`),
      ]);
      setCourse(detail);
      setCurriculum(tree);
    } catch (err) {
      if (err instanceof ApiClientError && err.status === 404) {
        setNotFound(true);
        return;
      }
      setError(err instanceof Error ? err.message : 'Could not load this course.');
    }
  }, [params.slug]);

  useEffect(() => {
    // Waits for the auth check so the lock flags reflect the signed-in student
    // rather than briefly showing everything locked and then correcting.
    if (state.status !== 'loading') void load();
  }, [state.status, load]);

  if (notFound) {
    return (
      <div className="mx-auto max-w-xl px-4 py-16 text-center sm:px-6">
        <h1 className="text-xl font-semibold text-[var(--color-foreground)]">Course not found</h1>
        <p className="mt-2 text-sm text-[var(--color-muted-foreground)]">
          It may have been unpublished.
        </p>
        <Link href="/" className="mt-4 inline-flex min-h-11 items-center text-[var(--color-primary)]">
          Browse all courses
        </Link>
      </div>
    );
  }

  const totalLessons = curriculum?.modules.reduce((sum, m) => sum + m.lessons.length, 0) ?? 0;
  const freeLessons =
    curriculum?.modules.flatMap((m) => m.lessons).filter((l) => l.isFree).length ?? 0;

  return (
    <div className="mx-auto max-w-3xl px-4 py-8 sm:px-6">
      {error && <ErrorNote onRetry={() => void load()}>{error}</ErrorNote>}

      {!course && !error && (
        <div className="flex flex-col gap-3">
          <Skeleton className="h-9 w-3/4" />
          <Skeleton className="h-40 w-full" />
          <span className="sr-only" role="status">
            Loading course
          </span>
        </div>
      )}

      {course && (
        <>
          <div className="flex flex-wrap items-center gap-2">
            {course.level && <Badge tone="info">{course.level}</Badge>}
            {course.subject && <Badge tone="neutral">{course.subject}</Badge>}
            {curriculum?.entitled && <Badge tone="success">You have access</Badge>}
          </div>

          <h1 className="mt-2 text-2xl font-semibold text-[var(--color-foreground)]">
            {course.title}
          </h1>
          {course.subtitle && (
            <p className="prose-measure mt-1 text-[var(--color-muted-foreground)]">
              {course.subtitle}
            </p>
          )}

          <p className="mt-2 text-sm text-[var(--color-muted-foreground)]">
            {course.teacherName}
            {course.teacherInstitution && <> · {course.teacherInstitution}</>}
          </p>

          {course.description && (
            <p className="prose-measure mt-4 whitespace-pre-line text-[var(--color-foreground)]">
              {course.description}
            </p>
          )}

          <Card className="mt-6 flex flex-wrap items-center justify-between gap-4 p-5">
            <div>
              <p className="tabular text-2xl font-semibold text-[var(--color-foreground)]">
                {course.pricePoisha === 0 ? 'Free' : formatPoisha(course.pricePoisha)}
              </p>
              <p className="mt-1 text-sm text-[var(--color-muted-foreground)]">
                <span className="tabular">{totalLessons}</span> lesson
                {totalLessons === 1 ? '' : 's'}
                {freeLessons > 0 && (
                  <>
                    {' · '}
                    <span className="tabular">{freeLessons}</span> free to watch now
                  </>
                )}
              </p>
            </div>

            {curriculum?.entitled ? (
              <Link
                href="/my-courses"
                className="inline-flex min-h-11 items-center rounded-[var(--radius-md)] bg-[var(--color-primary)] px-5 text-sm font-medium text-[var(--color-on-primary)]"
              >
                Go to my courses
              </Link>
            ) : course.pricePoisha > 0 ? (
              <Link
                href={`/purchase/${course.id}`}
                className="inline-flex min-h-11 items-center rounded-[var(--radius-md)] bg-[var(--color-primary)] px-5 text-sm font-medium text-[var(--color-on-primary)]"
              >
                Buy this course
              </Link>
            ) : null}
          </Card>

          {curriculum && (
            <section className="mt-8">
              <h2 className="text-lg font-semibold text-[var(--color-foreground)]">
                What you will learn
              </h2>

              <ol className="mt-4 flex flex-col gap-4">
                {curriculum.modules.map((module, index) => (
                  <Card as="li" key={module.id} className="p-4">
                    <h3 className="text-base font-medium text-[var(--color-foreground)]">
                      <span className="tabular text-[var(--color-muted-foreground)]">
                        {index + 1}.
                      </span>{' '}
                      {module.title}
                    </h3>

                    <ul className="mt-2 flex flex-col">
                      {module.lessons.map((lesson) => (
                        <li
                          key={lesson.id}
                          className="flex items-center gap-3 border-b border-[var(--color-border)] py-2 last:border-b-0"
                        >
                          <LessonTypeIcon
                            type={lesson.type}
                            className="size-4 shrink-0 text-[var(--color-muted-foreground)]"
                          />

                          {lesson.locked ? (
                            <span className="min-w-0 flex-1 text-sm text-[var(--color-muted-foreground)]">
                              {lesson.title}
                            </span>
                          ) : (
                            <Link
                              href={`/learn/lessons/${lesson.id}`}
                              className="min-w-0 flex-1 text-sm font-medium text-[var(--color-primary)] hover:underline"
                            >
                              {lesson.title}
                            </Link>
                          )}

                          {lesson.isFree && !curriculum.entitled && (
                            <Badge tone="warning">Free</Badge>
                          )}
                          {lesson.durationSeconds !== null && (
                            <span className="tabular shrink-0 text-xs text-[var(--color-muted-foreground)]">
                              {formatDuration(lesson.durationSeconds)}
                            </span>
                          )}
                          {lesson.locked && (
                            <LockIcon className="size-4 shrink-0 text-[var(--color-muted-foreground)]" />
                          )}
                        </li>
                      ))}
                    </ul>
                  </Card>
                ))}
              </ol>
            </section>
          )}

          {!curriculum?.entitled && course.pricePoisha > 0 && (
            <div className="mt-8 flex justify-center">
              <Link
                href={`/purchase/${course.id}`}
                className="inline-flex min-h-11 items-center rounded-[var(--radius-md)] bg-[var(--color-primary)] px-6 text-sm font-medium text-[var(--color-on-primary)]"
              >
                Buy for {formatPoisha(course.pricePoisha)}
              </Link>
            </div>
          )}
        </>
      )}
    </div>
  );
}

export default function CoursePage() {
  return (
    <AuthProvider>
      <SiteHeader />
      <CourseScreen />
    </AuthProvider>
  );
}
