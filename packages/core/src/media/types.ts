/**
 * The vendor boundary (Section 3.4).
 *
 * VdoCipher is the chosen DRM vendor, but Bunny.net Stream is a live
 * alternative pending a quote, and at Tier 3-4 volumes the delivery cost
 * difference could exceed $1,000/year. Every call site talks to this interface
 * so switching is one adapter file, not a hundred edits.
 *
 * Nothing here leaks a vendor concept upward: no `clientPayload` shape, no
 * vendor status strings. Callers see our own vocabulary.
 */

/** Our status vocabulary, not the vendor's. */
export type VideoStatus = 'uploading' | 'transcoding' | 'ready' | 'failed';

export type VideoDetails = {
  status: VideoStatus;
  durationSeconds: number | null;
  /** Vendor's own message when status is 'failed', for the teacher-facing
   *  notification. Never shown raw to a student. */
  errorMessage?: string;
};

/**
 * Opaque credentials the client uses to upload directly to the vendor.
 *
 * The file never touches our server (Section 4). Shape is vendor-specific and
 * passed through untouched — the web and Flutter clients hand it straight to
 * the vendor SDK.
 */
export type UploadCredentials = {
  videoId: string;
  /** Passed verbatim to the client. Do not interpret. */
  clientPayload: Record<string, unknown>;
};

/**
 * A single-use, short-lived playback grant.
 *
 * Never return a bare video id to a client. Section 4.1 flow A: the OTP grants
 * one playback session on one device, so intercepting it is worth almost
 * nothing.
 */
export type PlaybackGrant = {
  otp: string;
  playbackInfo: string;
  expiresInSeconds: number;
};

/**
 * Watermark identity burned into every frame.
 *
 * Section 17.4: because pointing a second phone at the screen is unpreventable
 * by any technology at any price, attribution IS the product. A leaked frame
 * must carry the account that leaked it.
 */
export type WatermarkIdentity = {
  name: string;
  phone: string;
  ip: string | null;
  /** Short session hash, so two leaks from one account can be tied to
   *  different sessions. */
  sessionHash: string;
};

export interface VideoProvider {
  readonly name: string;

  /** Issue credentials for a direct client-to-vendor upload. */
  createUpload(title: string): Promise<UploadCredentials>;

  /** Polled by the cron in Section 9.1 every 5 minutes. */
  getVideo(videoId: string): Promise<VideoDetails>;

  /**
   * Issue a playback grant. Called immediately before playback, never at page
   * load — a student whose subscription lapses mid-session must lose access on
   * their next play (Section 7).
   */
  createPlaybackGrant(
    videoId: string,
    watermark: WatermarkIdentity,
    options?: { ttlSeconds?: number; maxResolution?: number },
  ): Promise<PlaybackGrant>;

  /** Storage is billed continuously, so orphans cost money all year
   *  (Section 20.5). */
  deleteVideo(videoId: string): Promise<void>;
}
