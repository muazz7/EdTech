'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { api } from '@/lib/client/api-client';
import { AuthProvider, useAuth } from '@/components/auth-provider';
import { SiteHeader } from '@/components/site-header';
import { Badge, Card, EmptyState, ErrorNote, ProgressBar, Skeleton } from '@/components/ui';

type MyCourse = {
  id: string;
  slug: string;
  title: string;
  subtitle: string | null;
  level: string | null;
  subject: string | null;
  teacherName: string;
  totalLessons: number;
  completedLessons: number;
  percent: number;
  lastActivityAt: string | null;
};

type MyCoursesResponse = {
  courses: MyCourse[];
  hasAllAccess: boolean;
  planExpiresAt: string | null;
};

type CourseProgress = {
  nextLesson: { id: string; title: string } | null;
  resume: { lessonId: string; position: number } | null;
};

function daysUntil(iso: string): number {
  return Math.ceil((new Date(iso).getTime() - Date.now()) / (24 * 60 * 60 * 1000));
}

/**
 * My Courses (Section 2.3).
 *
 * Driven by live entitlements, so a lapsed subscription or a revoked grant
 * drops a course out rather than leaving a card that fails when tapped.
 */
function MyCoursesScreen() {
  const { state } = useAuth();
  const [data, setData] = useState<MyCoursesResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setData(await api.get<MyCoursesResponse>('/me/courses'));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load your courses.');
    }
  }, []);

  useEffect(() => {
    if (state.status === 'signed-in') void load();
  }, [state.status, load]);

  if (state.status === 'signed-out') {
    return (
      <div className="mx-auto max-w-md px-4 py-16 sm:px-6">
        <EmptyState
          title="Sign in to see your courses"
          body="Your courses and progress are tied to your account."
          action={
            <Link
              href="/login"
              className="inline-flex min-h-11 items-center rounded-[var(--radius-md)] bg-[var(--color-primary)] px-4 text-sm font-medium text-[var(--color-on-primary)]"
            >
              Sign in
            </Link>
          }
        />
      </div>
    );
  }

  const expiringSoon =
    data?.planExpiresAt && daysUntil(data.planExpiresAt) <= 7 ? daysUntil(data.planExpiresAt) : null;

  return (
    <div className="mx-auto max-w-3xl px-4 py-8 sm:px-6">
      <h1 className="text-2xl font-semibold text-[var(--color-foreground)]">My courses</h1>

      {/* Section 8.3 wants the expiry warning in the product, not only in an
          SMS — the student has to be able to act on it where they already are. */}
      {expiringSoon !== null && (
        <Card className="mt-4 border-[var(--color-warning)] p-4">
          <p className="text-sm text-[var(--color-foreground)]">
            Your plan {expiringSoon <= 0 ? 'has expired' : `expires in ${expiringSoon} day(s)`}.
            Renew to keep access — your progress is kept either way.
          </p>
        </Card>
      )}

      {error && (
        <div className="mt-4">
          <ErrorNote onRetry={() => void load()}>{error}</ErrorNote>
        </div>
      )}

      {(data === null || state.status === 'loading') && !error && (
        <div className="mt-6 flex flex-col gap-3">
          <Skeleton className="h-28 w-full" />
          <Skeleton className="h-28 w-full" />
          <span className="sr-only" role="status">
            Loading your courses
          </span>
        </div>
      )}

      {data?.courses.length === 0 && (
        <div className="mt-6">
          <EmptyState
            title="No courses yet"
            body="Courses you buy appear here with your progress. Free lessons are open to everyone."
            action={
              <Link
                href="/"
                className="inline-flex min-h-11 items-center rounded-[var(--radius-md)] bg-[var(--color-primary)] px-4 text-sm font-medium text-[var(--color-on-primary)]"
              >
                Browse courses
              </Link>
            }
          />
        </div>
      )}

      {data && data.courses.length > 0 && (
        <ul className="mt-6 flex flex-col gap-4">
          {data.courses.map((course) => (
            <CourseCard key={course.id} course={course} />
          ))}
        </ul>
      )}
    </div>
  );
}

function CourseCard({ course }: { course: MyCourse }) {
  const [progress, setProgress] = useState<CourseProgress | null>(null);

  useEffect(() => {
    // Loaded per card rather than joined into the list: "continue where you
    // left off" needs the next unfinished lesson, and computing that for every
    // course in one query would be a correlated subquery per row.
    void api
      .get<CourseProgress>(`/me/progress/${course.id}`)
      .then(setProgress)
      .catch(() => setProgress(null));
  }, [course.id]);

  const resumeId = progress?.nextLesson?.id ?? progress?.resume?.lessonId ?? null;

  return (
    <Card as="li" className="p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            {course.level && <Badge tone="info">{course.level}</Badge>}
            {course.percent === 100 && <Badge tone="success">Finished</Badge>}
          </div>
          <h2 className="mt-1 text-base font-semibold text-[var(--color-foreground)]">
            {course.title}
          </h2>
          <p className="text-sm text-[var(--color-muted-foreground)]">{course.teacherName}</p>
        </div>

        <Link
          href={
            resumeId ? `/learn/lessons/${resumeId}` : `/courses/${course.slug}`
          }
          className="inline-flex min-h-11 shrink-0 items-center rounded-[var(--radius-md)] bg-[var(--color-primary)] px-4 text-sm font-medium text-[var(--color-on-primary)]"
        >
          {course.completedLessons === 0 ? 'Start' : 'Continue'}
        </Link>
      </div>

      <div className="mt-4">
        <ProgressBar value={course.percent} label={`Progress in ${course.title}`} />
        <p className="mt-1 text-sm text-[var(--color-muted-foreground)]">
          <span className="tabular">{course.completedLessons}</span> of{' '}
          <span className="tabular">{course.totalLessons}</span> lessons
          {progress?.nextLesson && <> · next: {progress.nextLesson.title}</>}
        </p>
      </div>
    </Card>
  );
}

export default function MyCoursesPage() {
  return (
    <AuthProvider>
      <SiteHeader />
      <MyCoursesScreen />
    </AuthProvider>
  );
}
