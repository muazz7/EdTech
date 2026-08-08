'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { api } from '@/lib/client/api-client';
import { AuthProvider } from '@/components/auth-provider';
import { SiteHeader } from '@/components/site-header';
import { Badge, Card, EmptyState, ErrorNote, Skeleton } from '@/components/ui';
import { LessonTypeIcon } from '@/components/icons';

type FreeResource = {
  lessonId: string;
  title: string;
  type: string;
  durationSeconds: number | null;
  courseSlug: string;
  courseTitle: string;
  subject: string | null;
  level: string | null;
  teacherName: string;
};

/**
 * The Free Resource Center (Section 2.3) — the conversion funnel.
 *
 * Deliberately reachable and watchable signed out. Asking someone to create an
 * account before they have seen anything is where most of them leave.
 */
function FreeScreen() {
  const [resources, setResources] = useState<FreeResource[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setResources(await api.get<FreeResource[]>('/free-resources'));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load the free lessons.');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="mx-auto max-w-3xl px-4 py-8 sm:px-6">
      <h1 className="text-2xl font-semibold text-[var(--color-foreground)]">Free lessons</h1>
      <p className="prose-measure mt-2 text-sm text-[var(--color-muted-foreground)]">
        Real lessons from real courses, open to everyone. No payment needed.
      </p>

      {error && (
        <div className="mt-4">
          <ErrorNote onRetry={() => void load()}>{error}</ErrorNote>
        </div>
      )}

      {resources === null && !error && (
        <div className="mt-6 flex flex-col gap-3">
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-20 w-full" />
          <span className="sr-only" role="status">
            Loading free lessons
          </span>
        </div>
      )}

      {resources?.length === 0 && (
        <div className="mt-6">
          <EmptyState
            title="No free lessons yet"
            body="Teachers mark lessons as free previews. Check back soon."
          />
        </div>
      )}

      {resources && resources.length > 0 && (
        <ul className="mt-6 flex flex-col gap-3">
          {resources.map((resource) => (
            <Card as="li" key={resource.lessonId}>
              <Link
                href={`/learn/lessons/${resource.lessonId}`}
                className="flex items-center gap-3 p-4 transition-colors duration-150 hover:bg-[var(--color-muted)]"
              >
                <LessonTypeIcon
                  type={resource.type}
                  className="size-5 shrink-0 text-[var(--color-muted-foreground)]"
                />

                <div className="min-w-0 flex-1">
                  <p className="font-medium text-[var(--color-foreground)]">{resource.title}</p>
                  <p className="text-sm text-[var(--color-muted-foreground)]">
                    {resource.courseTitle} · {resource.teacherName}
                  </p>
                </div>

                <div className="flex shrink-0 flex-col items-end gap-1">
                  {resource.level && <Badge tone="info">{resource.level}</Badge>}
                  {resource.durationSeconds && (
                    <span className="tabular text-xs text-[var(--color-muted-foreground)]">
                      {Math.round(resource.durationSeconds / 60)} min
                    </span>
                  )}
                </div>
              </Link>
            </Card>
          ))}
        </ul>
      )}
    </div>
  );
}

export default function FreeResourcesPage() {
  return (
    <AuthProvider>
      <SiteHeader />
      <FreeScreen />
    </AuthProvider>
  );
}
