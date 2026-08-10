'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/client/api-client';
import { Badge, Button, Card, EmptyState, ErrorNote, Skeleton } from '@/components/ui';
import { DeviceIcon, LockIcon } from '@/components/icons';

type Signal = { code: string; label: string; detail: string };

type Flagged = {
  studentId: string;
  studentName: string;
  phone: string | null;
  signals: Signal[];
  signalCount: number;
};

type Activity = {
  recentIps: Array<{ ip: string; events: number; lastSeenAt: string }>;
  deviceCount: number;
  deviceLimit: number;
  recentCourses: Array<{
    course_title: string;
    lessons: number;
    hours: number;
    last_seen: string;
  }>;
};

/**
 * Piracy signals review queue (Section 17.5).
 *
 * The screen is built to make a human decision easy, not to make a machine
 * decision for them. There is no ban button and no score: a count of tripped
 * signals sits next to the evidence for each one, because the reviewer is
 * deciding whether to phone a student and needs to know what actually happened.
 *
 * Every signal here has an innocent explanation — a shared family phone, a
 * student revising the night before an exam, a village with one broadband line.
 * The copy says so next to each, because a reviewer who forgets that bans a
 * paying customer.
 */
function PiracyScreen() {
  const [rows, setRows] = useState<Flagged[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setRows(await api.get<Flagged[]>('/admin/piracy'));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load the review queue.');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="mx-auto max-w-3xl px-4 py-8 sm:px-6">
      <h1 className="text-2xl font-semibold text-[var(--color-foreground)]">Piracy signals</h1>
      <p className="prose-measure mt-2 text-sm text-[var(--color-muted-foreground)]">
        Accounts whose behaviour in the last 24 hours matched one of the Section 17.5 patterns.
        Nothing here is automatic — these are prompts to look, not verdicts.
      </p>

      <Card className="mt-4 border-[var(--color-warning)] p-4">
        <p className="prose-measure text-sm text-[var(--color-foreground)]">
          <span className="font-medium">Do not ban from this screen.</span> Every signal below has
          an innocent explanation, and a student wrongly locked out during exam season is a refund
          and a public complaint. Phone them first.
        </p>
      </Card>

      {error && (
        <div className="mt-4">
          <ErrorNote onRetry={() => void load()}>{error}</ErrorNote>
        </div>
      )}

      {rows === null && !error && <Skeleton className="mt-6 h-32 w-full" />}

      {rows?.length === 0 && (
        <div className="mt-6">
          <EmptyState
            title="Nothing flagged"
            body="No account tripped a signal in the last 24 hours."
          />
        </div>
      )}

      {rows && rows.length > 0 && (
        <ul className="mt-6 flex flex-col gap-3">
          {rows.map((row) => (
            <Card as="li" key={row.studentId} className="p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-medium text-[var(--color-foreground)]">{row.studentName}</p>
                  {row.phone && (
                    <p className="tabular text-sm text-[var(--color-muted-foreground)]">
                      {row.phone}
                    </p>
                  )}
                </div>

                <div className="flex shrink-0 items-center gap-2">
                  {/* A count, not a weighted score. A weighted score invites
                      tuning the weights until the answer is the one you
                      wanted. */}
                  <Badge tone={row.signalCount >= 3 ? 'danger' : 'warning'}>
                    {row.signalCount} signal{row.signalCount === 1 ? '' : 's'}
                  </Badge>
                  <Button
                    size="sm"
                    onClick={() => setOpenId(openId === row.studentId ? null : row.studentId)}
                    aria-expanded={openId === row.studentId}
                  >
                    {openId === row.studentId ? 'Close' : 'Evidence'}
                  </Button>
                </div>
              </div>

              <ul className="mt-3 flex flex-col gap-2">
                {row.signals.map((signal) => (
                  <li key={signal.code} className="text-sm">
                    <span className="font-medium text-[var(--color-foreground)]">
                      {signal.label}
                    </span>
                    <span className="block text-[var(--color-muted-foreground)]">
                      {signal.detail}
                    </span>
                  </li>
                ))}
              </ul>

              {openId === row.studentId && <ActivityDetail studentId={row.studentId} />}
            </Card>
          ))}
        </ul>
      )}
    </div>
  );
}

function ActivityDetail({ studentId }: { studentId: string }) {
  const [activity, setActivity] = useState<Activity | null>(null);

  useEffect(() => {
    void api
      .get<Activity>(`/admin/piracy/${studentId}`)
      .then(setActivity)
      .catch(() => setActivity(null));
  }, [studentId]);

  if (!activity) return <Skeleton className="mt-3 h-24 w-full" />;

  return (
    <div className="mt-4 border-t border-[var(--color-border)] pt-4">
      <div className="flex items-center gap-2 text-sm text-[var(--color-foreground)]">
        <DeviceIcon className="size-4 text-[var(--color-muted-foreground)]" />
        <span className="tabular">{activity.deviceCount}</span> of{' '}
        <span className="tabular">{activity.deviceLimit}</span> devices used this month
      </div>

      {activity.recentIps.length > 0 && (
        <div className="mt-3">
          <p className="text-sm font-medium text-[var(--color-foreground)]">
            Networks in the last 7 days
          </p>
          <ul className="mt-1 flex flex-col gap-1">
            {activity.recentIps.map((row) => (
              <li key={row.ip} className="tabular text-sm text-[var(--color-muted-foreground)]">
                {/* Last octet masked. "How many networks" is the question; "which
                    house" is not. */}
                {row.ip} · {row.events} events
              </li>
            ))}
          </ul>
        </div>
      )}

      {activity.recentCourses.length > 0 && (
        <div className="mt-3">
          <p className="text-sm font-medium text-[var(--color-foreground)]">
            Watching in the last 7 days
          </p>
          <ul className="mt-1 flex flex-col gap-1">
            {activity.recentCourses.map((row) => (
              <li key={row.course_title} className="text-sm text-[var(--color-muted-foreground)]">
                {row.course_title} — <span className="tabular">{row.lessons}</span> lessons,{' '}
                <span className="tabular">{row.hours}</span>h
              </li>
            ))}
          </ul>
        </div>
      )}

      <p className="mt-4 flex items-start gap-2 text-sm text-[var(--color-muted-foreground)]">
        <LockIcon className="mt-0.5 size-4 shrink-0" />
        To act on this, revoke the entitlement from the student roster or clear their device budget
        — both are deliberate manual steps, and both are audited.
      </p>
    </div>
  );
}

export default function PiracyPage() {
  return <PiracyScreen />;
}
