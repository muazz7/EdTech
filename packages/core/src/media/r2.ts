import { AwsClient } from 'aws4fetch';
import { ApiError, ERROR_CODES, R2_SIGNED_URL_TTL_SECONDS } from '@edtech/shared';

/**
 * Cloudflare R2 (Section 9.2).
 *
 * One private bucket. No public access, no custom public domain. R2 charges
 * zero egress, which is why it beats S3 here by a wide margin.
 *
 * aws4fetch rather than the AWS SDK: R2 is S3-compatible and all we need is
 * SigV4 presigning. The SDK is tens of megabytes of cold start for that.
 */

function config() {
  const accountId = process.env.R2_ACCOUNT_ID;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  const bucket = process.env.R2_BUCKET;

  if (!accountId || !accessKeyId || !secretAccessKey || !bucket) {
    throw new ApiError(503, ERROR_CODES.UPSTREAM_FAILED, 'File storage is not configured.');
  }

  return {
    bucket,
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    client: new AwsClient({
      accessKeyId,
      secretAccessKey,
      service: 's3',
      region: 'auto',
    }),
  };
}

function ttl(override?: number): number {
  return override ?? Number(process.env.R2_SIGNED_URL_TTL) ?? R2_SIGNED_URL_TTL_SECONDS;
}

/**
 * Object key layout (Section 9.2). Centralised so keys cannot drift, and so a
 * caller cannot accidentally build a key that escapes its prefix.
 */
export const r2Keys = {
  courseThumb: (courseId: string) => `courses/${courseId}/thumb.webp`,
  lessonDoc: (courseId: string, lessonId: string, filename: string) =>
    `courses/${courseId}/lessons/${lessonId}/${sanitiseSegment(filename)}`,
  notePage: (courseId: string, lessonId: string, page: number, ext: string) =>
    `courses/${courseId}/lessons/${lessonId}/notes/page-${String(page).padStart(3, '0')}.${sanitiseSegment(ext)}`,
  paymentProof: (paymentId: string, ext: string) =>
    `payments/${paymentId}/proof.${sanitiseSegment(ext)}`,
  submission: (submissionId: string, filename: string) =>
    `submissions/${submissionId}/${sanitiseSegment(filename)}`,
  certificate: (certificateNo: string) => `certificates/${certificateNo}.pdf`,
};

/** Strips path traversal and anything that would let a client-supplied filename
 *  reach outside its intended prefix. */
export function sanitiseSegment(value: string): string {
  return value
    .replace(/[\\/]+/g, '_')
    .replace(/\.\.+/g, '_')
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .slice(0, 120);
}

/**
 * Presigned PUT for a direct client-to-R2 upload.
 *
 * Content-Type and Content-Length are SIGNED, not merely suggested: Section 9.2
 * requires them pinned so a client cannot declare a 2 MB JPEG and then upload a
 * 2 GB MP4, or declare an image and upload an executable. The client must send
 * exactly these headers or R2 rejects the request.
 */
export async function presignUpload(params: {
  key: string;
  contentType: string;
  contentLength: number;
  ttlSeconds?: number;
}): Promise<{ url: string; key: string; requiredHeaders: Record<string, string> }> {
  const { bucket, endpoint, client } = config();
  const url = new URL(`${endpoint}/${bucket}/${params.key}`);
  url.searchParams.set('X-Amz-Expires', String(ttl(params.ttlSeconds)));

  const signed = await client.sign(
    new Request(url, {
      method: 'PUT',
      headers: {
        'content-type': params.contentType,
        'content-length': String(params.contentLength),
      },
    }),
    {
      aws: {
        signQuery: true,
        // Without this the headers are not part of the signature and the pin
        // above is decoration.
        allHeaders: true,
      },
    },
  );

  return {
    url: signed.url,
    key: params.key,
    requiredHeaders: {
      'Content-Type': params.contentType,
      'Content-Length': String(params.contentLength),
    },
  };
}

/**
 * Presigned GET, issued only after checkLessonAccess passes.
 *
 * Section 9.2: do NOT reuse one URL for a whole session. Issue a fresh one per
 * document open. A 15-minute URL pasted into a group chat is a 15-minute leak;
 * a long-lived one is a permanent leak.
 *
 * `inline` keeps the browser from treating it as a download, which matters for
 * the canvas viewer — though the real protection is that the bytes go into a
 * canvas, never to an <a download>.
 */
export async function presignDownload(params: {
  key: string;
  ttlSeconds?: number;
  filename?: string;
  contentType?: string;
}): Promise<{ url: string; expiresInSeconds: number }> {
  const { bucket, endpoint, client } = config();
  const seconds = ttl(params.ttlSeconds);

  const url = new URL(`${endpoint}/${bucket}/${params.key}`);
  url.searchParams.set('X-Amz-Expires', String(seconds));
  url.searchParams.set(
    'response-content-disposition',
    params.filename ? `inline; filename="${sanitiseSegment(params.filename)}"` : 'inline',
  );
  if (params.contentType) {
    url.searchParams.set('response-content-type', params.contentType);
  }

  const signed = await client.sign(new Request(url, { method: 'GET' }), {
    aws: { signQuery: true },
  });

  return { url: signed.url, expiresInSeconds: seconds };
}

/** Storage is billed continuously, so orphans from failed and duplicate
 *  uploads cost money all year (Section 20.5). */
export async function deleteObject(key: string): Promise<void> {
  const { bucket, endpoint, client } = config();
  const res = await client.fetch(`${endpoint}/${bucket}/${key}`, { method: 'DELETE' });
  if (!res.ok && res.status !== 404) {
    throw new ApiError(502, ERROR_CODES.UPSTREAM_FAILED, 'Could not delete the file.');
  }
}

export async function objectExists(key: string): Promise<boolean> {
  const { bucket, endpoint, client } = config();
  const res = await client.fetch(`${endpoint}/${bucket}/${key}`, { method: 'HEAD' });
  return res.ok;
}
