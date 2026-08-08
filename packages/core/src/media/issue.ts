import { asc, eq } from 'drizzle-orm';
import { getDb, lessons, notePages, profiles } from '@edtech/db';
import {
  ApiError,
  ERROR_CODES,
  RATE_LIMITS,
  entitlementError,
  type Platform,
} from '@edtech/shared';
import { checkLessonAccess } from '../entitlements/check-lesson-access.js';
import { enforceRate } from '../rate-limit/limiter.js';
import { buildDocumentWatermark, sessionHash, type DocumentWatermark } from './watermark.js';
import { presignDownload } from './r2.js';
import { videoProvider } from './vdocipher.js';
import type { PlaybackGrant, WatermarkIdentity } from './types.js';

/**
 * Every path by which a byte of paid content becomes reachable goes through
 * this file. Two rules hold for all of them:
 *
 *   1. checkLessonAccess runs FIRST, server-side, on every call. Not at page
 *      load — here, immediately before the grant is minted (Section 7).
 *   2. The rate limit is applied here rather than in the route handler, so a
 *      new endpoint cannot forget it. Section 6.4 caps playback grants at
 *      60/user/hour and signed asset URLs at 120/user/hour; an account pulling
 *      more than that is ripping the catalog, which is also piracy signal
 *      material (Section 17.5).
 */

export type IssueContext = {
  userId: string;
  sessionId: string;
  ip: string | null;
  platform: Platform;
};

async function watermarkIdentity(ctx: IssueContext): Promise<WatermarkIdentity> {
  const db = getDb();
  const profile = await db.query.profiles.findFirst({
    where: eq(profiles.id, ctx.userId),
    columns: { fullName: true, phone: true },
  });

  if (!profile) throw new ApiError(401, ERROR_CODES.UNAUTHENTICATED);

  return {
    // A student who never completed their profile still gets attributable
    // content — falling back to the phone rather than an empty watermark.
    name: profile.fullName.trim() || (profile.phone ?? 'unknown'),
    phone: profile.phone ?? 'unknown',
    ip: ctx.ip,
    sessionHash: sessionHash(ctx.sessionId),
  };
}

/** Loads the lesson only after access is granted, so a denial cannot be told
 *  apart from a missing lesson by response shape. */
async function authorise(ctx: IssueContext, lessonId: string) {
  const access = await checkLessonAccess(ctx.userId, lessonId);
  if (!access.allowed) throw entitlementError(access.reason);

  const db = getDb();
  const lesson = await db.query.lessons.findFirst({
    where: eq(lessons.id, lessonId),
  });
  if (!lesson) throw new ApiError(404, ERROR_CODES.NOT_FOUND);

  return { lesson, via: access.via };
}

/**
 * Section 4.1 flow A. Returns a single-use OTP, never a bare video id.
 *
 * Desktop web is capped to 720p: Section 17.2 notes desktop browsers commonly
 * run Widevine L3, which has publicly documented key-extraction tooling, and no
 * vendor can eliminate that. A 480-720p leak is worth far less than 1080p, and
 * Section 20.5 names capping quality as the single biggest bandwidth cost lever.
 * Mobile runs hardware-backed L1 far more often, so it is left uncapped.
 */
export async function issuePlayback(
  ctx: IssueContext,
  lessonId: string,
): Promise<PlaybackGrant & { via: string }> {
  await enforceRate('playback-otp', ctx.userId, RATE_LIMITS.playbackOtpPerUser);

  const { lesson, via } = await authorise(ctx, lessonId);

  if (lesson.type !== 'video') {
    throw new ApiError(400, ERROR_CODES.VALIDATION_FAILED, 'This lesson is not a video.');
  }
  if (!lesson.vdocipherVideoId) {
    throw new ApiError(409, ERROR_CODES.CONFLICT, 'This video is not uploaded yet.');
  }
  if (lesson.videoStatus !== 'ready') {
    throw new ApiError(
      409,
      ERROR_CODES.CONFLICT,
      'This video is still processing. Try again in a few minutes.',
    );
  }

  const grant = await videoProvider().createPlaybackGrant(
    lesson.vdocipherVideoId,
    await watermarkIdentity(ctx),
    ctx.platform === 'web' ? { maxResolution: 720 } : undefined,
  );

  return { ...grant, via };
}

export type AssetGrant = {
  url: string;
  expiresInSeconds: number;
  watermark: DocumentWatermark;
  mimeType: string | null;
  pageCount: number | null;
};

/**
 * Section 4.1 flow B. A single-file document: PDF, image, or a single-page
 * uploaded note (ADR 0001).
 *
 * The watermark text is built server-side and returned alongside the URL so the
 * client cannot choose what to display. It is still only a deterrent on web —
 * see the honesty note in ADR 0001 about Print Screen.
 */
export async function issueAssetUrl(
  ctx: IssueContext,
  lessonId: string,
): Promise<AssetGrant> {
  await enforceRate('signed-asset', ctx.userId, RATE_LIMITS.signedAssetPerUser);

  const { lesson } = await authorise(ctx, lessonId);

  if (!lesson.r2ObjectKey) {
    throw new ApiError(409, ERROR_CODES.CONFLICT, 'This lesson has no file attached yet.');
  }

  const signed = await presignDownload({
    key: lesson.r2ObjectKey,
    contentType: lesson.mimeType ?? undefined,
  });

  return {
    url: signed.url,
    expiresInSeconds: signed.expiresInSeconds,
    watermark: buildDocumentWatermark(await watermarkIdentity(ctx)),
    mimeType: lesson.mimeType,
    pageCount: lesson.pageCount,
  };
}

export type NotePageGrant = {
  page: number;
  url: string;
  width: number | null;
  height: number | null;
  mimeType: string | null;
};

/**
 * A multi-page uploaded note: N photographed pages (ADR 0001).
 *
 * One rate-limit hit for the whole note, not one per page — a 40-page note
 * would otherwise blow the 120/hour budget on a single open.
 */
export async function issueNotePages(
  ctx: IssueContext,
  lessonId: string,
): Promise<{ pages: NotePageGrant[]; watermark: DocumentWatermark; expiresInSeconds: number }> {
  await enforceRate('signed-asset', ctx.userId, RATE_LIMITS.signedAssetPerUser);

  await authorise(ctx, lessonId);

  const db = getDb();
  const rows = await db
    .select({
      pageNumber: notePages.pageNumber,
      key: notePages.r2ObjectKey,
      width: notePages.width,
      height: notePages.height,
      mimeType: notePages.mimeType,
    })
    .from(notePages)
    .where(eq(notePages.lessonId, lessonId))
    .orderBy(asc(notePages.pageNumber));

  if (rows.length === 0) {
    throw new ApiError(409, ERROR_CODES.CONFLICT, 'This note has no pages yet.');
  }

  const signed = await Promise.all(
    rows.map(async (row) => {
      const { url } = await presignDownload({
        key: row.key,
        contentType: row.mimeType ?? undefined,
      });
      return {
        page: row.pageNumber,
        url,
        width: row.width,
        height: row.height,
        mimeType: row.mimeType,
      };
    }),
  );

  return {
    pages: signed,
    watermark: buildDocumentWatermark(await watermarkIdentity(ctx)),
    expiresInSeconds: Number(process.env.R2_SIGNED_URL_TTL ?? 900),
  };
}
