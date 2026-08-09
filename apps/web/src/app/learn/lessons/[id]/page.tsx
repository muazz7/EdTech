'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { formatPoisha } from '@edtech/shared';
import { ApiClientError, api } from '@/lib/client/api-client';
import { AuthProvider, useAuth } from '@/components/auth-provider';
import { Badge, Card, EmptyState, ErrorNote, ProgressBar, Skeleton } from '@/components/ui';
import { CheckCircleIcon, LessonTypeIcon, LockIcon } from '@/components/icons';
import { DrmPlayer } from '@/components/learn/drm-player';
import { DocumentViewer } from '@/components/learn/document-viewer';
import { QuizPanel } from '@/components/learn/quiz-panel';
import { AssignmentPanel } from '@/components/learn/assignment-panel';
import type { ProgressSnapshot } from '@/components/learn/use-progress-reporter';

type LessonView = {
  id: string;
  courseId: string;
  courseTitle: string;
  moduleTitle: string;
  title: string;
  description: string | null;
  type: 'video' | 'pdf' | 'note' | 'image' | 'quiz' | 'assignment';
  isFree: boolean;
  durationSeconds: number | null;
  pageCount: number | null;
  videoStatus: string | null;
  /** Null while the teacher is still authoring — a published lesson can point
   *  at a draft quiz. */
  quizId: string | null;
  assignmentId: string | null;
  via: string;
  siblings: Array<{ id: string; title: string; type: string; isFree: boolean }>;
};

/** Attached to a 403 for a purchasable course, so the paywall can name and
 *  price what it is selling. */
type Paywall = {
  courseId: string;
  courseTitle: string;
  courseSlug: string;
  pricePoisha: number;
  isInAllAccess: boolean;
};

type CourseProgress = {
  lessons: Array<{ lessonId: string; lastPosition: number; isComplete: boolean }>;
  totalLessons: number;
  completedLessons: number;
  percent: number;
  nextLesson: { id: string; title: string } | null;
};

/** Explains WHY a lesson is locked, because "no access" and "your subscription
 *  lapsed" need different actions from the student. */
const LOCK_COPY: Record<string, { title: string; body: string }> = {
  NO_ENTITLEMENT: {
    title: 'This lesson is part of a paid course',
    body: 'Choose a plan to unlock it. Free preview lessons in this course are still available.',
  },
  ENTITLEMENT_EXPIRED: {
    title: 'Your access has expired',
    body: 'Renew to continue where you left off. Your progress and certificates are kept.',
  },
  ENTITLEMENT_REVOKED: {
    title: 'Access to this content was removed',
    body: 'Contact support if you think this is a mistake.',
  },
  CONTENT_UNPUBLISHED: {
    title: 'This lesson is not available',
    body: 'It may have been unpublished by the teacher.',
  },
};

function LessonScreen() {
  const params = useParams<{ id: string }>();
  const lessonId = params.id;
  const { state } = useAuth();

  const [lesson, setLesson] = useState<LessonView | null>(null);
  const [locked, setLocked] = useState<{
    title: string;
    body: string;
    paywall?: Paywall;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<CourseProgress | null>(null);

  const load = useCallback(async () => {
    setError(null);
    setLocked(null);
    try {
      setLesson(await api.get<LessonView>(`/lessons/${lessonId}`));
    } catch (err) {
      if (err instanceof ApiClientError && (err.status === 403 || err.status === 404)) {
        // A denial for a purchasable course carries the course and its price,
        // so the lock screen can offer a real route to buy rather than a dead
        // end that ends the sale.
        const paywall = err.details as Paywall | undefined;
        setLocked({
          ...(LOCK_COPY[err.code] ?? {
            title: 'This lesson is not available',
            body: err.message,
          }),
          ...(paywall?.courseId ? { paywall } : {}),
        });
        return;
      }
      setError(err instanceof Error ? err.message : 'Could not open this lesson.');
    }
  }, [lessonId]);

  useEffect(() => {
    if (state.status === 'signed-in') void load();
  }, [state.status, load]);

  // A second request rather than fields on the lesson: this is the whole
  // course's progress, and it drives the resume position, the bar and the
  // ticks beside the sibling lessons.
  const courseId = lesson?.courseId ?? null;
  const loadProgress = useCallback(() => {
    if (!courseId) return;
    void api
      .get<CourseProgress>(`/me/progress/${courseId}`)
      .then(setProgress)
      // Progress is an enhancement. Failing to load it must not stop the
      // student from watching the lesson they came for.
      .catch(() => setProgress(null));
  }, [courseId]);

  useEffect(loadProgress, [loadProgress]);

  const lessonProgress = progress?.lessons.find((row) => row.lessonId === lessonId) ?? null;
  const completedIds = new Set(
    progress?.lessons.filter((row) => row.isComplete).map((row) => row.lessonId) ?? [],
  );

  // A teacher opening their own lesson is previewing, not studying. Writing
  // lesson_progress rows for them would corrupt every completion figure the
  // course reports.
  const trackProgress = lesson?.via !== 'owner';

  const onProgress = useCallback(
    (snapshot: ProgressSnapshot) => {
      // Refetch only on the transition to complete: that is the one moment the
      // course-level numbers actually change.
      if (snapshot.isComplete && !lessonProgress?.isComplete) loadProgress();
    },
    [lessonProgress?.isComplete, loadProgress],
  );

  if (state.status === 'loading') {
    return (
      <div className="mx-auto max-w-4xl px-4 py-8 sm:px-6">
        <Skeleton className="h-8 w-72" />
        <Skeleton className="mt-4 aspect-video w-full" />
      </div>
    );
  }

  if (state.status === 'signed-out') {
    return (
      <div className="mx-auto max-w-md px-4 py-16 sm:px-6">
        <EmptyState
          title="Sign in to continue"
          body="This lesson is only available to signed-in students."
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

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 sm:px-6">
      {error && <ErrorNote onRetry={() => void load()}>{error}</ErrorNote>}

      {locked && (
        <Card className="flex flex-col items-center gap-3 p-8 text-center">
          <LockIcon className="size-6 text-[var(--color-muted-foreground)]" />
          <h1 className="text-lg font-semibold text-[var(--color-foreground)]">{locked.title}</h1>
          <p className="prose-measure text-sm text-[var(--color-muted-foreground)]">
            {locked.body}
          </p>

          {locked.paywall && (
            <>
              <p className="tabular mt-2 text-2xl font-semibold text-[var(--color-foreground)]">
                {formatPoisha(locked.paywall.pricePoisha)}
              </p>
              <Link
                href={`/purchase/${locked.paywall.courseId}`}
                className="inline-flex min-h-11 items-center rounded-[var(--radius-md)] bg-[var(--color-primary)] px-5 text-sm font-medium text-[var(--color-on-primary)]"
              >
                Buy {locked.paywall.courseTitle}
              </Link>
              <Link
                href="/account/payments"
                className="text-sm text-[var(--color-primary)]"
              >
                Already paid? Check your payment status
              </Link>
            </>
          )}
        </Card>
      )}

      {lesson && (
        <>
          <nav aria-label="Breadcrumb" className="text-sm text-[var(--color-muted-foreground)]">
            {lesson.courseTitle}
            <span className="mx-2" aria-hidden="true">
              /
            </span>
            {lesson.moduleTitle}
          </nav>

          <div className="mt-2 flex flex-wrap items-center gap-3">
            <LessonTypeIcon
              type={lesson.type}
              className="size-5 text-[var(--color-muted-foreground)]"
            />
            <h1 className="text-2xl font-semibold text-[var(--color-foreground)]">
              {lesson.title}
            </h1>
            {lesson.isFree && <Badge tone="info">Free preview</Badge>}
            {lesson.via === 'owner' && <Badge tone="warning">Teacher preview</Badge>}
            {lessonProgress?.isComplete && <Badge tone="success">Completed</Badge>}
          </div>

          {lesson.description && (
            <p className="prose-measure mt-2 text-sm text-[var(--color-muted-foreground)]">
              {lesson.description}
            </p>
          )}

          <div className="mt-6">
            {lesson.type === 'video' && (
              <DrmPlayer
                lessonId={lesson.id}
                videoStatus={lesson.videoStatus}
                resumePosition={lessonProgress?.isComplete ? null : (lessonProgress?.lastPosition ?? null)}
                trackProgress={trackProgress}
                onProgress={onProgress}
              />
            )}

            {(lesson.type === 'pdf' || lesson.type === 'image') && (
              <DocumentViewer
                lessonId={lesson.id}
                kind="asset"
                trackProgress={trackProgress}
                onProgress={onProgress}
              />
            )}

            {/* A note is either one PDF or N photographed pages (ADR 0001).
                pageCount tells them apart without another round trip. */}
            {lesson.type === 'note' && (
              <DocumentViewer
                lessonId={lesson.id}
                kind={lesson.pageCount && lesson.pageCount > 0 ? 'note-pages' : 'asset'}
                trackProgress={trackProgress}
                onProgress={onProgress}
              />
            )}

            {lesson.type === 'quiz' &&
              (lesson.quizId ? (
                <QuizPanel quizId={lesson.quizId} />
              ) : (
                <EmptyState
                  title="This quiz is not ready yet"
                  body="Your teacher is still writing the questions. Check back shortly."
                />
              ))}

            {lesson.type === 'assignment' &&
              (lesson.assignmentId ? (
                <AssignmentPanel assignmentId={lesson.assignmentId} />
              ) : (
                <EmptyState
                  title="This assignment is not ready yet"
                  body="Your teacher is still writing the brief. Check back shortly."
                />
              ))}
          </div>

          {/* Course-level progress, not this lesson's. A bar that only moves
              while the video plays tells the student nothing they cannot
              already see in the scrubber. */}
          {trackProgress && progress && progress.totalLessons > 0 && (
            <div className="mt-6">
              <ProgressBar value={progress.percent} label={`Progress in ${lesson.courseTitle}`} />
              <div className="mt-1 flex flex-wrap items-center justify-between gap-2">
                <p className="text-sm text-[var(--color-muted-foreground)]">
                  <span className="tabular">{progress.completedLessons}</span> of{' '}
                  <span className="tabular">{progress.totalLessons}</span> lessons complete
                </p>
                {progress.nextLesson && progress.nextLesson.id !== lesson.id && (
                  <Link
                    href={`/learn/lessons/${progress.nextLesson.id}`}
                    className="text-sm font-medium text-[var(--color-primary)] hover:underline"
                  >
                    Next: {progress.nextLesson.title}
                  </Link>
                )}
              </div>
            </div>
          )}

          {lesson.siblings.length > 1 && (
            <section className="mt-10">
              <h2 className="text-sm font-semibold text-[var(--color-foreground)]">
                More in {lesson.moduleTitle}
              </h2>
              <ul className="mt-3 flex flex-col gap-2">
                {lesson.siblings.map((sibling) => (
                  <li key={sibling.id}>
                    <Link
                      href={`/learn/lessons/${sibling.id}`}
                      aria-current={sibling.id === lesson.id ? 'page' : undefined}
                      className={`flex min-h-11 items-center gap-3 rounded-[var(--radius-md)] px-3 text-sm transition-colors duration-150 ${
                        sibling.id === lesson.id
                          ? 'bg-[var(--color-cyan-tint)] font-medium text-[var(--color-foreground)]'
                          : 'text-[var(--color-foreground)] hover:bg-[var(--color-muted)]'
                      }`}
                    >
                      <LessonTypeIcon
                        type={sibling.type}
                        className="size-4 shrink-0 text-[var(--color-muted-foreground)]"
                      />
                      <span className="min-w-0 flex-1">{sibling.title}</span>
                      {sibling.isFree && <Badge tone="neutral">Free</Badge>}
                      {/* Icon plus text, never the tick alone: a green mark on
                          its own is invisible to a colourblind student. */}
                      {completedIds.has(sibling.id) && (
                        <span className="flex shrink-0 items-center gap-1 text-xs text-[var(--color-success)]">
                          <CheckCircleIcon className="size-4" />
                          Done
                        </span>
                      )}
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}
    </div>
  );
}

export default function LessonPage() {
  return (
    <AuthProvider>
      <LessonScreen />
    </AuthProvider>
  );
}
