'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { DOCUMENT_DWELL_COMPLETE_SECONDS } from '@edtech/shared';
import { api } from '@/lib/client/api-client';
import { Button, ErrorNote, Skeleton } from '@/components/ui';
import { fetchBytes, stampWatermark, type DocumentWatermark } from './watermark';
import { useProgressReporter, type ProgressSnapshot } from './use-progress-reporter';

/**
 * Canvas viewer for PDFs, images and uploaded note pages (Section 9.2,
 * ADR 0001).
 *
 * Everything is rendered into a canvas with the watermark composited into the
 * pixels. No <img src>, no <embed>, no <a download> — the signed URL never
 * reaches the DOM, and there is no text layer to select or copy out.
 *
 * pdf.js is imported dynamically so a student opening a video or a photographed
 * note never downloads the PDF engine. It is by far the heaviest dependency in
 * this app, and Section 1.4 names uneven bandwidth as a shaping constraint.
 */

type AssetGrant = {
  url: string;
  expiresInSeconds: number;
  watermark: DocumentWatermark;
  mimeType: string | null;
  pageCount: number | null;
};

type NotePagesGrant = {
  pages: Array<{ page: number; url: string; width: number | null; height: number | null }>;
  watermark: DocumentWatermark;
  expiresInSeconds: number;
};

/** Caps the backing store so a 4000px scan does not allocate an enormous
 *  bitmap on a low-end phone. */
const MAX_CANVAS_WIDTH = 1600;

/** How often dwell is added up. Short enough that a student who reads for 20
 *  seconds and leaves still gets credited for it. */
const DWELL_TICK_SECONDS = 5;

export function DocumentViewer({
  lessonId,
  kind,
  trackProgress = true,
  onProgress,
}: {
  lessonId: string;
  kind: 'asset' | 'note-pages';
  /** False for a teacher previewing their own lesson. */
  trackProgress?: boolean;
  onProgress?: (snapshot: ProgressSnapshot) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState<string | null>(null);
  const [pageCount, setPageCount] = useState(0);
  const [attempt, setAttempt] = useState(0);

  const render = useCallback(async () => {
    const container = containerRef.current;
    if (!container) return;

    setStatus('loading');
    setError(null);
    container.replaceChildren();

    try {
      if (kind === 'note-pages') {
        const grant = await api.get<NotePagesGrant>(`/lessons/${lessonId}/note-pages`);
        setPageCount(grant.pages.length);
        for (const page of grant.pages) {
          const blob = await fetchBytes(page.url);
          await drawImage(container, blob, grant.watermark, page.page);
        }
      } else {
        const grant = await api.get<AssetGrant>(`/lessons/${lessonId}/asset`);
        const blob = await fetchBytes(grant.url);

        if (grant.mimeType === 'application/pdf') {
          const count = await drawPdf(container, blob, grant.watermark);
          setPageCount(count);
        } else {
          setPageCount(1);
          await drawImage(container, blob, grant.watermark, 1);
        }
      }

      setStatus('ready');
    } catch (err) {
      setStatus('error');
      setError(err instanceof Error ? err.message : 'Could not open this file.');
    }
  }, [lessonId, kind]);

  useEffect(() => {
    void render();
  }, [render, attempt]);

  useDwellProgress({
    lessonId,
    enabled: trackProgress && status === 'ready',
    ...(onProgress ? { onProgress } : {}),
  });

  return (
    <div className="flex flex-col gap-3">
      {status === 'loading' && (
        <div className="flex flex-col gap-3">
          <Skeleton className="aspect-[1/1.414] w-full" />
          <span className="sr-only" role="status">
            Loading document
          </span>
        </div>
      )}

      {status === 'error' && error && (
        <ErrorNote onRetry={() => setAttempt((n) => n + 1)}>{error}</ErrorNote>
      )}

      <div
        ref={containerRef}
        // Blocks the casual right-click save. It stops a curious student, not a
        // determined one — the watermark is the actual defence.
        onContextMenu={(event) => event.preventDefault()}
        className="flex flex-col items-center gap-4 [&>canvas]:h-auto [&>canvas]:w-full [&>canvas]:max-w-3xl [&>canvas]:rounded-[var(--radius-md)] [&>canvas]:shadow-[var(--shadow-sm)] [&>canvas]:select-none"
      />

      {status === 'ready' && (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-[var(--color-muted-foreground)]">
            {pageCount} page{pageCount === 1 ? '' : 's'}
          </p>
          {/* Links expire in 15 minutes; a re-render fetches fresh ones rather
              than failing silently on a long reading session. */}
          <Button size="sm" onClick={() => setAttempt((n) => n + 1)}>
            Reload pages
          </Button>
        </div>
      )}

      <p className="text-xs text-[var(--color-muted-foreground)]">
        Your name and phone number are shown on every page. Sharing course material will end your
        access permanently.
      </p>
    </div>
  );
}

/**
 * Counts time spent with the document open and reports it as `position`.
 *
 * Section 14 completes a document on dwell, not on scroll depth: a one-page
 * formula sheet has no scroll to measure, and a student who reads it for a
 * minute has finished it. The number sent is seconds, matching what the server
 * expects for video, so the anti-gaming comparison in `recordProgress` stays
 * meaningful — dwell can never advance faster than the clock.
 *
 * Only counted while the tab is visible. A document left open in a background
 * tab overnight is not ten hours of study.
 */
function useDwellProgress({
  lessonId,
  enabled,
  onProgress,
}: {
  lessonId: string;
  enabled: boolean;
  onProgress?: (snapshot: ProgressSnapshot) => void;
}) {
  const dwell = useRef(0);
  const reporter = useProgressReporter({
    lessonId,
    enabled,
    ...(onProgress ? { onSaved: onProgress } : {}),
  });
  const reporterRef = useRef(reporter);
  reporterRef.current = reporter;

  useEffect(() => {
    dwell.current = 0;
  }, [lessonId]);

  useEffect(() => {
    if (!enabled) return;

    const tick = setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      dwell.current += DWELL_TICK_SECONDS;
      reporterRef.current.track('heartbeat', dwell.current);
    }, DWELL_TICK_SECONDS * 1000);

    // The reporter's own flush runs every 30 seconds, which would leave a
    // document that completes at 10 seconds of dwell looking unfinished to a
    // student who reads it and leaves. One extra flush just past the threshold
    // fixes that without doubling the request rate for everyone else.
    const settle = setTimeout(
      () => reporterRef.current.flush(),
      (DOCUMENT_DWELL_COMPLETE_SECONDS + DWELL_TICK_SECONDS) * 1000,
    );

    return () => {
      clearInterval(tick);
      clearTimeout(settle);
    };
  }, [enabled, lessonId]);
}

async function drawImage(
  container: HTMLElement,
  blob: Blob,
  mark: DocumentWatermark,
  pageNumber: number,
): Promise<void> {
  const bitmap = await createImageBitmap(blob);

  const scale = Math.min(1, MAX_CANVAS_WIDTH / bitmap.width);
  const width = Math.round(bitmap.width * scale);
  const height = Math.round(bitmap.height * scale);

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label', `Page ${pageNumber}`);

  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Your browser could not render this page.');

  ctx.drawImage(bitmap, 0, 0, width, height);
  stampWatermark(ctx, width, height, mark);
  bitmap.close();

  container.appendChild(canvas);
}

async function drawPdf(
  container: HTMLElement,
  blob: Blob,
  mark: DocumentWatermark,
): Promise<number> {
  // Dynamic: only a student opening a PDF pays for the engine.
  const pdfjs = await import('pdfjs-dist');

  // The worker keeps parsing off the main thread; without it a large PDF
  // freezes the page while it renders.
  pdfjs.GlobalWorkerOptions.workerSrc = new URL(
    'pdfjs-dist/build/pdf.worker.min.mjs',
    import.meta.url,
  ).toString();

  const data = new Uint8Array(await blob.arrayBuffer());
  const doc = await pdfjs.getDocument({ data }).promise;

  for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber++) {
    const page = await doc.getPage(pageNumber);
    const base = page.getViewport({ scale: 1 });
    const scale = Math.min(2, MAX_CANVAS_WIDTH / base.width);
    const viewport = page.getViewport({ scale });

    const canvas = document.createElement('canvas');
    canvas.width = Math.round(viewport.width);
    canvas.height = Math.round(viewport.height);
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', `Page ${pageNumber} of ${doc.numPages}`);

    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Your browser could not render this document.');

    await page.render({ canvas, canvasContext: ctx, viewport }).promise;
    // After the page, so the mark sits on top of the content rather than under
    // it — and so it is part of the same bitmap.
    stampWatermark(ctx, canvas.width, canvas.height, mark);

    container.appendChild(canvas);
    page.cleanup();
  }

  const count = doc.numPages;
  // cleanup(), not destroy(): the loading task owns teardown in this version of
  // pdf.js, and the document itself only exposes cleanup for releasing page
  // resources. Skipping it leaks the rendered bitmaps for the tab's lifetime.
  doc.cleanup();
  return count;
}
