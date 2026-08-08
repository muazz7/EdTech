import { VDOCIPHER_PLAYBACK_TTL_SECONDS } from '@edtech/shared';
import { ApiError, ERROR_CODES } from '@edtech/shared';
import { buildVdocipherAnnotation } from './watermark.js';
import type {
  PlaybackGrant,
  UploadCredentials,
  VideoDetails,
  VideoProvider,
  VideoStatus,
  WatermarkIdentity,
} from './types.js';

const API_BASE = 'https://dev.vdocipher.com/api';

/**
 * VdoCipher adapter. The only file that knows this vendor exists.
 *
 * VDOCIPHER_API_SECRET is server-only (Section 17.6). If it reaches a client,
 * the entire content library is exposed — it can mint playback grants for any
 * video and delete the library.
 */

function apiSecret(): string {
  const secret = process.env.VDOCIPHER_API_SECRET;
  if (!secret) {
    throw new ApiError(
      503,
      ERROR_CODES.UPSTREAM_FAILED,
      'Video service is not configured.',
    );
  }
  return secret;
}

async function call<T>(
  path: string,
  init: { method: string; body?: unknown; query?: Record<string, string> },
): Promise<T> {
  const url = new URL(`${API_BASE}${path}`);
  for (const [k, v] of Object.entries(init.query ?? {})) url.searchParams.set(k, v);

  const res = await fetch(url, {
    method: init.method,
    headers: {
      Authorization: `Apisecret ${apiSecret()}`,
      Accept: 'application/json',
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: init.body ? JSON.stringify(init.body) : undefined,
    // A hung vendor call must not burn the Vercel function ceiling.
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    // Vendor detail is logged, never returned — it can contain account context.
    console.error(`[vdocipher] ${init.method} ${path} -> ${res.status} ${detail.slice(0, 300)}`);
    throw new ApiError(
      502,
      ERROR_CODES.UPSTREAM_FAILED,
      'The video service is unavailable. Try again shortly.',
    );
  }

  return (await res.json()) as T;
}

/**
 * VdoCipher reports status as 'PRE-Upload', 'Queued', 'Processing', 'ready',
 * 'Failure' and has changed casing before. Normalising here keeps those strings
 * out of the database and out of every comparison in the app.
 */
function normaliseStatus(raw: string | undefined): VideoStatus {
  const value = (raw ?? '').toLowerCase();
  if (value === 'ready') return 'ready';
  if (value.includes('fail') || value.includes('error')) return 'failed';
  if (value.includes('pre-upload') || value.includes('preupload')) return 'uploading';
  return 'transcoding';
}

export class VdocipherProvider implements VideoProvider {
  readonly name = 'vdocipher';

  async createUpload(title: string): Promise<UploadCredentials> {
    const json = await call<{
      videoId: string;
      clientPayload: Record<string, unknown>;
    }>('/videos', { method: 'PUT', query: { title } });

    return { videoId: json.videoId, clientPayload: json.clientPayload };
  }

  async getVideo(videoId: string): Promise<VideoDetails> {
    const json = await call<{
      status?: string;
      length?: number;
      posters?: unknown;
      error_desc?: string;
    }>(`/videos/${encodeURIComponent(videoId)}`, { method: 'GET' });

    const status = normaliseStatus(json.status);
    return {
      status,
      durationSeconds: typeof json.length === 'number' ? Math.round(json.length) : null,
      ...(status === 'failed' && json.error_desc ? { errorMessage: json.error_desc } : {}),
    };
  }

  async createPlaybackGrant(
    videoId: string,
    watermark: WatermarkIdentity,
    options?: { ttlSeconds?: number; maxResolution?: number },
  ): Promise<PlaybackGrant> {
    const ttl =
      options?.ttlSeconds ??
      Number(process.env.VDOCIPHER_PLAYBACK_TTL) ??
      VDOCIPHER_PLAYBACK_TTL_SECONDS;

    const json = await call<{ otp: string; playbackInfo: string }>(
      `/videos/${encodeURIComponent(videoId)}/otp`,
      {
        method: 'POST',
        body: {
          ttl,
          annotate: buildVdocipherAnnotation(watermark),
          // Section 17.2: desktop browsers commonly run Widevine L3, which has
          // publicly documented key-extraction tooling. Capping resolution
          // makes a successful extraction much less valuable — a 480p leak is
          // worth far less than 1080p. Section 20.5 also names capping quality
          // as the single biggest bandwidth cost lever.
          ...(options?.maxResolution ? { forcedBitrates: options.maxResolution } : {}),
        },
      },
    );

    return { otp: json.otp, playbackInfo: json.playbackInfo, expiresInSeconds: ttl };
  }

  async deleteVideo(videoId: string): Promise<void> {
    await call(`/videos`, { method: 'DELETE', query: { videos: videoId } });
  }
}

let cached: VideoProvider | undefined;

/** Single accessor so swapping the vendor is one line here. */
export function videoProvider(): VideoProvider {
  cached ??= new VdocipherProvider();
  return cached;
}

/** Test seam: inject a fake provider so gate tests need no vendor account. */
export function __setVideoProvider(provider: VideoProvider | undefined): void {
  cached = provider;
}
