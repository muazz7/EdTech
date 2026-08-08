'use client';

import { api } from './api-client';

/**
 * Direct-to-vendor uploads (Section 4: no media byte passes through our
 * server).
 *
 * XMLHttpRequest rather than fetch throughout: fetch still cannot report upload
 * progress in browsers, and a teacher pushing a 700 MB lecture over a
 * Bangladeshi connection needs to see it moving. A silent five-minute wait is
 * indistinguishable from a hang, and they will refresh and start again.
 */

export type ProgressFn = (percent: number) => void;

export type UploadHandle = {
  promise: Promise<void>;
  abort: () => void;
};

/** Shared XHR driver. Resolves on 2xx, rejects with a readable message. */
function send(
  method: 'PUT' | 'POST',
  url: string,
  body: XMLHttpRequestBodyInit,
  headers: Record<string, string>,
  onProgress?: ProgressFn,
): UploadHandle {
  const xhr = new XMLHttpRequest();

  const promise = new Promise<void>((resolve, reject) => {
    xhr.open(method, url, true);
    for (const [key, value] of Object.entries(headers)) xhr.setRequestHeader(key, value);

    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && onProgress) {
        onProgress((event.loaded / event.total) * 100);
      }
    };

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress?.(100);
        resolve();
        return;
      }
      // R2 and VdoCipher both answer with XML on failure. The raw body is
      // useless to a teacher, so it is logged and a plain sentence surfaces.
      console.error(`[upload] ${method} ${url} -> ${xhr.status}`, xhr.responseText?.slice(0, 400));
      reject(
        new Error(
          xhr.status === 403
            ? 'The upload permission expired. Try again.'
            : `Upload failed (${xhr.status}). Check your connection and try again.`,
        ),
      );
    };

    xhr.onerror = () =>
      reject(new Error('The connection dropped during upload. Check your network and try again.'));
    xhr.ontimeout = () => reject(new Error('The upload timed out. Try again.'));
    xhr.onabort = () => reject(new Error('Upload cancelled.'));

    xhr.send(body);
  });

  return { promise, abort: () => xhr.abort() };
}

// ── Video ───────────────────────────────────────────────────────────────────

type VideoCredentials = {
  videoId: string;
  clientPayload: Record<string, string> & { uploadLink: string };
};

/**
 * Section 4.1 flow C. Credentials come from our API; the bytes go straight to
 * the vendor.
 *
 * The vendor's upload is an S3 browser POST, where the policy fields must
 * precede the file in the form. Appending `file` first makes S3 reject the
 * request with a policy error that reads like a signature problem, which is a
 * genuinely miserable thing to debug — hence the explicit ordering below.
 */
export function uploadVideo(
  lessonId: string,
  file: File,
  onProgress: ProgressFn,
): { start: () => Promise<void>; abort: () => void } {
  let inner: UploadHandle | null = null;

  const start = async () => {
    const credentials = await api.post<VideoCredentials>(
      `/teacher/lessons/${lessonId}/video-credentials`,
    );

    const { uploadLink, ...policyFields } = credentials.clientPayload;

    const form = new FormData();
    for (const [key, value] of Object.entries(policyFields)) {
      if (key === 'videoId') continue;
      form.append(key, value);
    }
    // Must be last.
    form.append('file', file);

    // No Content-Type header: the browser sets multipart/form-data with the
    // boundary, and overriding it corrupts the body.
    inner = send('POST', uploadLink, form, {}, onProgress);
    await inner.promise;

    // Only now does the video id reach our database, so an abandoned upload
    // leaves no lesson claiming a video that was never finished.
    await api.post(`/teacher/lessons/${lessonId}/video-complete`, {
      videoId: credentials.videoId,
    });
  };

  return { start, abort: () => inner?.abort() };
}

// ── Documents ───────────────────────────────────────────────────────────────

type PresignedUpload = {
  url: string;
  key: string;
  requiredHeaders: Record<string, string>;
  mime: string;
  size: number;
};

/**
 * Presigned PUT to R2.
 *
 * `requiredHeaders` must be sent exactly as issued — Content-Type and
 * Content-Length are part of the signature (Section 9.2), so a mismatch is a
 * 403 rather than a silently different object.
 */
export function uploadDocument(
  lessonId: string,
  file: File,
  onProgress: ProgressFn,
  pageCount?: number,
): { start: () => Promise<void>; abort: () => void } {
  let inner: UploadHandle | null = null;

  const start = async () => {
    const signed = await api.post<PresignedUpload>(
      `/teacher/lessons/${lessonId}/asset-upload-url`,
      { filename: file.name, mime: file.type, size: file.size },
    );

    // Content-Length is set by the browser from the body and cannot be assigned
    // from script; sending it explicitly is a no-op that some browsers warn
    // about. The signature still covers it because the body length matches.
    const headers = Object.fromEntries(
      Object.entries(signed.requiredHeaders).filter(
        ([key]) => key.toLowerCase() !== 'content-length',
      ),
    );

    inner = send('PUT', signed.url, file, headers, onProgress);
    await inner.promise;

    await api.put(`/teacher/lessons/${lessonId}/asset-upload-url`, {
      key: signed.key,
      mime: file.type,
      size: file.size,
      ...(pageCount ? { pageCount } : {}),
    });
  };

  return { start, abort: () => inner?.abort() };
}

// ── Payment proof ───────────────────────────────────────────────────────────

/**
 * The payment screenshot (Section 8.1, max 5 MB).
 *
 * The R2 key is minted server-side from a fresh uuid, so one student cannot aim
 * their upload at another student's proof and overwrite the evidence in a
 * dispute. Returns the key for the submission form to attach.
 */
export async function uploadPaymentProof(file: File, onProgress: ProgressFn): Promise<string> {
  const signed = await api.post<PresignedUpload>('/payments/proof-upload-url', {
    mime: file.type,
    size: file.size,
  });

  const headers = Object.fromEntries(
    Object.entries(signed.requiredHeaders).filter(
      ([key]) => key.toLowerCase() !== 'content-length',
    ),
  );

  await send('PUT', signed.url, file, headers, onProgress).promise;
  return signed.key;
}

// ── Multi-page notes (ADR 0001) ─────────────────────────────────────────────

export type NotePageFile = { file: File; pageNumber: number };

type NotePagePresign = {
  pageNumber: number;
  url: string;
  key: string;
  requiredHeaders: Record<string, string>;
};

/**
 * Photographed handwritten pages (ADR 0001). Uploaded one at a time rather than
 * in parallel: a phone photo set is often 20+ files, and saturating an uneven
 * connection makes every one of them slower and more likely to fail.
 *
 * Progress is reported across the whole set, not per file, because a bar that
 * resets to zero twenty times reads as broken.
 */
export function uploadNotePages(
  lessonId: string,
  pages: NotePageFile[],
  onProgress: ProgressFn,
): { start: () => Promise<void>; abort: () => void } {
  let inner: UploadHandle | null = null;
  let cancelled = false;

  const start = async () => {
    const presigned = await api.post<NotePagePresign[]>(
      `/teacher/lessons/${lessonId}/note-pages`,
      {
        pages: pages.map((p) => ({
          pageNumber: p.pageNumber,
          mime: p.file.type,
          size: p.file.size,
        })),
      },
    );

    const byPage = new Map(presigned.map((p) => [p.pageNumber, p]));
    const totalBytes = pages.reduce((sum, p) => sum + p.file.size, 0);
    let uploadedBytes = 0;

    const committed: Array<{
      pageNumber: number;
      key: string;
      mime: string;
      size: number;
    }> = [];

    for (const page of pages) {
      if (cancelled) throw new Error('Upload cancelled.');

      const target = byPage.get(page.pageNumber);
      if (!target) throw new Error(`No upload slot for page ${page.pageNumber}.`);

      const headers = Object.fromEntries(
        Object.entries(target.requiredHeaders).filter(
          ([key]) => key.toLowerCase() !== 'content-length',
        ),
      );

      const startedAt = uploadedBytes;
      inner = send('PUT', target.url, page.file, headers, (percent) => {
        onProgress(((startedAt + (percent / 100) * page.file.size) / totalBytes) * 100);
      });
      await inner.promise;

      uploadedBytes = startedAt + page.file.size;
      committed.push({
        pageNumber: page.pageNumber,
        key: target.key,
        mime: page.file.type,
        size: page.file.size,
      });
    }

    // One commit for the whole set: it replaces rather than merges, so a
    // partial commit would leave a note with pages missing from the middle.
    await api.put(`/teacher/lessons/${lessonId}/note-pages`, { pages: committed });
  };

  return {
    start,
    abort: () => {
      cancelled = true;
      inner?.abort();
    },
  };
}
