'use client';

import { useEffect, useRef, useState } from 'react';
import { api } from '@/lib/client/api-client';
import { ErrorNote, Skeleton } from '@/components/ui';

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

type VdoPlayerApi = {
  getInstance: (config: {
    otp: string;
    playbackInfo: string;
    container: HTMLElement;
    configuration?: Record<string, unknown>;
  }) => unknown;
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

export function DrmPlayer({
  lessonId,
  videoStatus,
}: {
  lessonId: string;
  videoStatus: string | null;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (videoStatus !== 'ready') {
      setLoading(false);
      return;
    }

    let cancelled = false;

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
        window.VdoPlayer.getInstance({
          otp: grant.otp,
          playbackInfo: grant.playbackInfo,
          container,
        });
        setLoading(false);
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

      {/* The watermark is burned into the video by the vendor, not drawn here.
          Saying so is part of the deterrent (Section 17.4). */}
      <p className="text-xs text-[var(--color-muted-foreground)]">
        Your name and phone number are shown on this video. Sharing course material will end your
        access permanently.
      </p>
    </div>
  );
}
