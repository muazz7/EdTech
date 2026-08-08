'use client';

import { useCallback, useEffect, useRef } from 'react';
import { HEARTBEAT_INTERVAL_SECONDS } from '@edtech/shared';
import { ApiClientError, api } from '@/lib/client/api-client';

/**
 * Reports watch progress to POST /lessons/:id/progress (Section 14).
 *
 * Shared by the video player and the document viewer because the server rule is
 * the same for both: `position` is a number of seconds that only ever advances
 * as fast as real time. For video that is the playhead; for a document it is
 * accumulated dwell. Reporting a page number instead would make the anti-gaming
 * comparison meaningless.
 *
 * Events are batched rather than sent per heartbeat (Section 18): one request
 * every 30 seconds per watching student, not one every 15.
 */

export type ProgressEventName = 'play' | 'pause' | 'seek' | 'heartbeat' | 'ended';

type QueuedEvent = {
  event: ProgressEventName;
  position: number;
  playbackRate?: number;
  at: number;
};

export type ProgressSnapshot = {
  lastPosition: number;
  secondsWatched: number;
  isComplete: boolean;
  discarded: number;
};

/** Two heartbeats per request. */
const FLUSH_INTERVAL_MS = HEARTBEAT_INTERVAL_SECONDS * 2 * 1000;

/** The server rejects a batch larger than this, so the queue is trimmed here
 *  rather than losing the whole request. Oldest go first: the newest events
 *  carry the position that matters. */
const MAX_QUEUED_EVENTS = 50;

export type ProgressReporter = {
  /** Queues an event. Cheap — nothing leaves the page until a flush. */
  track: (event: ProgressEventName, position: number, playbackRate?: number) => void;
  /** Sends whatever is queued now. Safe to call when there is nothing to send. */
  flush: () => void;
};

export function useProgressReporter({
  lessonId,
  enabled,
  onSaved,
}: {
  lessonId: string;
  /** False for a teacher previewing their own lesson, and for lesson types with
   *  no notion of progress. A teacher is not a student, and writing
   *  lesson_progress rows for them would corrupt every completion statistic the
   *  course reports. */
  enabled: boolean;
  onSaved?: (snapshot: ProgressSnapshot) => void;
}): ProgressReporter {
  const queue = useRef<QueuedEvent[]>([]);
  const position = useRef(0);
  const lastSentPosition = useRef<number | null>(null);
  const inFlight = useRef(false);
  /** Set when the server says this student may not report against this lesson.
   *  Without it an expired entitlement would retry every 30 seconds forever. */
  const stopped = useRef(false);
  const savedCallback = useRef(onSaved);
  savedCallback.current = onSaved;

  const send = useCallback(
    (keepalive: boolean) => {
      if (!enabled || stopped.current) return;
      // A paused player still ticks the interval. Nothing changed means nothing
      // to say.
      if (queue.current.length === 0 && lastSentPosition.current === position.current) return;
      if (inFlight.current && !keepalive) return;

      const events = queue.current.slice(-MAX_QUEUED_EVENTS);
      const body = {
        position: Math.max(0, Math.round(position.current)),
        ...(events.length > 0 ? { events } : {}),
      };

      // Cleared before the request resolves, so a slow network drops one batch
      // rather than replaying it on top of the next one — double-counting watch
      // time is worse than losing 30 seconds of it.
      queue.current = [];
      lastSentPosition.current = body.position;
      inFlight.current = true;

      const request = keepalive
        ? api.postKeepalive<ProgressSnapshot>(`/lessons/${lessonId}/progress`, body)
        : api.post<ProgressSnapshot>(`/lessons/${lessonId}/progress`, body);

      void request
        .then((snapshot) => savedCallback.current?.(snapshot))
        .catch((err: unknown) => {
          if (err instanceof ApiClientError && (err.status === 403 || err.status === 404)) {
            stopped.current = true;
            return;
          }
          // Anything else is transient. Progress reporting must never interrupt
          // playback, so this is logged and forgotten.
          console.warn('[progress] report failed:', err);
        })
        .finally(() => {
          inFlight.current = false;
        });
    },
    [lessonId, enabled],
  );

  const track = useCallback(
    (event: ProgressEventName, at: number, playbackRate?: number) => {
      if (!enabled || stopped.current) return;
      position.current = Math.max(0, at);
      queue.current.push({
        event,
        position: Math.round(position.current),
        ...(playbackRate !== undefined ? { playbackRate } : {}),
        at: Date.now(),
      });
      if (queue.current.length > MAX_QUEUED_EVENTS) {
        queue.current = queue.current.slice(-MAX_QUEUED_EVENTS);
      }
    },
    [enabled],
  );

  const flush = useCallback(() => send(false), [send]);

  // Reset when the student navigates to another lesson: the queue holds
  // positions that mean nothing against a different lesson id.
  useEffect(() => {
    queue.current = [];
    lastSentPosition.current = null;
    stopped.current = false;
  }, [lessonId]);

  useEffect(() => {
    if (!enabled) return;

    const timer = setInterval(() => send(false), FLUSH_INTERVAL_MS);

    // visibilitychange, not beforeunload: mobile browsers background a tab and
    // may kill it without ever firing unload, and this is the last moment
    // guaranteed to run on iOS.
    const onHide = () => {
      if (document.visibilityState === 'hidden') send(true);
    };
    const onPageHide = () => send(true);
    document.addEventListener('visibilitychange', onHide);
    window.addEventListener('pagehide', onPageHide);

    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('pagehide', onPageHide);
      send(true);
    };
  }, [enabled, send]);

  return { track, flush };
}
