'use client';

import { useEffect, useRef, useState } from 'react';
import { HEARTBEAT_INTERVAL_SECONDS } from '@edtech/shared';
import { api } from '@/lib/client/api-client';
import { Button, ErrorNote, Skeleton } from '@/components/ui';
import {
  useProgressReporter,
  type ProgressReporter,
  type ProgressSnapshot,
} from './use-progress-reporter';

/**
 * DRM video player (Section 4.1 flow A).
 *
 * The page never receives a video id — only a single-use OTP and a
 * playbackInfo blob, minted server-side immediately before playback after
 * checkLessonAccess passes. Intercepting the OTP buys one playback session on
 * one device.
 *
 * The vendor's player runs in its own iframe, which is what allows the browser
 * to mark the decoded surface non-capturable. Rendering the stream ourselves
 * would forfeit that, so the iframe is not an implementation detail to
 * optimise away.
 */

type PlaybackGrant = { otp: string; playbackInfo: string; expiresInSeconds: number };

/**
 * The vendor exposes a media element with the standard HTML5 surface on
 * `player.video`. Typed narrowly and read defensively — this is a third-party
 * global, so a shape change must degrade to "progress stops being recorded",
 * never to a player that fails to start.
 */
type VdoVideoElement = {
  currentTime: number;
  duration: number;
  playbackRate: number;
  addEventListener: (type: string, listener: () => void) => void;
  removeEventListener: (type: string, listener: () => void) => void;
};

type VdoPlayerInstance = { video?: VdoVideoElement };

type VdoPlayerApi = {
  getInstance: (config: {
    otp: string;
    playbackInfo: string;
    container: HTMLElement;
    configuration?: Record<string, unknown>;
  }) => VdoPlayerInstance | undefined;
};

declare global {
  interface Window {
    VdoPlayer?: VdoPlayerApi;
  }
}

const SDK_URL = 'https://player.vdocipher.com/v2/api.js';

/** Loads the vendor SDK once, even if several players mount. */
let sdkPromise: Promise<void> | null = null;

function loadSdk(): Promise<void> {
  if (window.VdoPlayer) return Promise.resolve();

  sdkPromise ??= new Promise<void>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${SDK_URL}"]`);
    if (existing) {
      existing.addEventListener('load', () => resolve());
      existing.addEventListener('error', () => reject(new Error('sdk')));
      return;
    }

    const script = document.createElement('script');
    script.src = SDK_URL;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => {
      sdkPromise = null;
      reject(new Error('sdk'));
    };
    document.head.appendChild(script);
  });

  return sdkPromise;
}

function formatClock(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  return `${minutes}:${String(rest).padStart(2, '0')}`;
}

export function DrmPlayer({
  lessonId,
  videoStatus,
  resumePosition = null,
  trackProgress = true,
  onProgress,
}: {
  lessonId: string;
  videoStatus: string | null;
  /** Seconds to seek to on load, from the student's saved progress. */
  resumePosition?: number | null;
  /** False for a teacher previewing their own lesson. */
  trackProgress?: boolean;
  onProgress?: (snapshot: ProgressSnapshot) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<VdoVideoElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);
  const [resumedFrom, setResumedFrom] = useState<number | null>(null);

  const reporter = useProgressReporter({
    lessonId,
    enabled: trackProgress && videoStatus === 'ready',
    ...(onProgress ? { onSaved: onProgress } : {}),
  });

  // Held in refs so a late-arriving resume position never re-runs the effect
  // below — that would mint a second OTP and restart playback.
  const resumeRef = useRef(resumePosition);
  resumeRef.current = resumePosition;
  const reporterRef = useRef(reporter);
  reporterRef.current = reporter;

  /** Set once the player is attached. Called again whenever the saved position
   *  arrives, because the progress request and the OTP request race and either
   *  can win. */
  const applyResumeRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    applyResumeRef.current?.();
  }, [resumePosition]);

  useEffect(() => {
    if (videoStatus !== 'ready') {
      setLoading(false);
      return;
    }

    let cancelled = false;
    let detach: (() => void) | null = null;

    void (async () => {
      setLoading(true);
      setError(null);

      try {
        // Order matters: the grant is requested only after the SDK is present,
        // so a slow script load does not burn the OTP's short TTL before the
        // player can consume it.
        await loadSdk();
        if (cancelled) return;

        const grant = await api.get<PlaybackGrant>(`/lessons/${lessonId}/playback`);
        if (cancelled) return;

        const container = containerRef.current;
        if (!container || !window.VdoPlayer) throw new Error('player');

        container.replaceChildren();
        const player = window.VdoPlayer.getInstance({
          otp: grant.otp,
          playbackInfo: grant.playbackInfo,
          container,
        });
        setLoading(false);

        const video = player?.video;
        if (!video || typeof video.addEventListener !== 'function') return;
        videoRef.current = video;

        const attached = attachProgress(video, reporterRef.current, resumeRef, setResumedFrom);
        applyResumeRef.current = attached.applyResume;
        detach = () => {
          applyResumeRef.current = null;
          attached.detach();
        };
        attached.applyResume();
      } catch (err) {
        if (cancelled) return;
        setLoading(false);
        const message =
          err instanceof Error && err.message === 'sdk'
            ? 'The video player could not load. Check your connection and reload.'
            : err instanceof Error
              ? err.message
              : 'Could not start this video.';
        setError(message);
      }
    })();

    return () => {
      cancelled = true;
      detach?.();
      videoRef.current = null;
    };
  }, [lessonId, videoStatus, attempt]);

  if (videoStatus !== 'ready') {
    return (
      <div className="rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] p-6">
        <p className="text-sm text-[var(--color-muted-foreground)]">
          {videoStatus === 'failed'
            ? 'This video could not be processed. The teacher has been notified.'
            : 'This video is still being prepared. Check back in a few minutes.'}
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {/* 16:9 reserved before the iframe arrives, so the page does not jump
          when it does (CLS). */}
      <div className="relative aspect-video w-full overflow-hidden rounded-[var(--radius-lg)] bg-black">
        <div ref={containerRef} className="absolute inset-0 [&>iframe]:size-full" />
        {loading && (
          <div className="absolute inset-0 flex items-center justify-center">
            <Skeleton className="size-full" />
            <span className="sr-only" role="status">
              Loading video
            </span>
          </div>
        )}
      </div>

      {error && <ErrorNote onRetry={() => setAttempt((n) => n + 1)}>{error}</ErrorNote>}

      {/* An automatic seek the student did not ask for needs a way back, or a
          resume that lands in the wrong place is a dead end. */}
      {resumedFrom !== null && (
        <div
          role="status"
          className="flex flex-wrap items-center justify-between gap-2 rounded-[var(--radius-md)] bg-[var(--color-cyan-tint)] px-3 py-2"
        >
          <p className="text-sm text-[var(--color-foreground)]">
            Resumed from <span className="tabular">{formatClock(resumedFrom)}</span>
          </p>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => {
              const video = videoRef.current;
              if (video) video.currentTime = 0;
              setResumedFrom(null);
            }}
          >
            Start over
          </Button>
        </div>
      )}

      {/* The watermark is burned into the video by the vendor, not drawn here.
          Saying so is part of the deterrent (Section 17.4). */}
      <p className="text-xs text-[var(--color-muted-foreground)]">
        Your name and phone number are shown on this video. Sharing course material will end your
        access permanently.
      </p>
    </div>
  );
}

/**
 * Subscribes to the vendor's media element and feeds the progress reporter.
 *
 * Heartbeats come from an interval rather than `timeupdate`, which fires 4-60
 * times a second depending on the browser. Section 14 wants one every 15
 * seconds, and throttling a firehose is more code than just running a clock.
 */
function attachProgress(
  video: VdoVideoElement,
  reporter: ProgressReporter,
  resumeSeconds: { current: number | null },
  onResumed: (seconds: number | null) => void,
): { detach: () => void; applyResume: () => void } {
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let resumeApplied = false;

  const stopHeartbeat = () => {
    if (heartbeat !== null) {
      clearInterval(heartbeat);
      heartbeat = null;
    }
  };

  /** Idempotent, and callable before either the metadata or the saved position
   *  has arrived — it simply does nothing until both are there. */
  const applyResume = () => {
    const seconds = resumeSeconds.current;
    if (resumeApplied || seconds === null) return;
    const duration = Number(video.duration);
    if (!Number.isFinite(duration) || duration <= 0) return;
    resumeApplied = true;

    // Not for the first few seconds (replaying them is cheaper than a seek),
    // and not near the end (dropping someone at the outro of a lesson they
    // already finished is worse than starting it again).
    if (seconds > 10 && seconds < duration - 15) {
      video.currentTime = seconds;
      onResumed(seconds);
    }
  };

  const onPlay = () => {
    reporter.track('play', video.currentTime, video.playbackRate);
    stopHeartbeat();
    heartbeat = setInterval(() => {
      reporter.track('heartbeat', video.currentTime, video.playbackRate);
    }, HEARTBEAT_INTERVAL_SECONDS * 1000);
  };

  const onPause = () => {
    stopHeartbeat();
    reporter.track('pause', video.currentTime, video.playbackRate);
    // A pause is the most likely moment for a student to leave, so this one is
    // sent rather than queued.
    reporter.flush();
  };

  const onSeeked = () => reporter.track('seek', video.currentTime, video.playbackRate);

  const onEnded = () => {
    stopHeartbeat();
    reporter.track('ended', video.currentTime, video.playbackRate);
    reporter.flush();
  };

  video.addEventListener('loadedmetadata', applyResume);
  video.addEventListener('play', onPlay);
  video.addEventListener('pause', onPause);
  video.addEventListener('seeked', onSeeked);
  video.addEventListener('ended', onEnded);

  return {
    applyResume,
    detach: () => {
      stopHeartbeat();
      video.removeEventListener('loadedmetadata', applyResume);
      video.removeEventListener('play', onPlay);
      video.removeEventListener('pause', onPause);
      video.removeEventListener('seeked', onSeeked);
      video.removeEventListener('ended', onEnded);
    },
  };
}
