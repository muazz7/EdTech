import { createHash } from 'node:crypto';
import type { WatermarkIdentity } from './types.js';

/**
 * Watermark construction (Section 9.1 and 17.4).
 *
 * Two independent moving annotations at different intervals, because a single
 * one can be cropped or blurred out. Alpha is high enough to survive
 * re-encoding and a camera recording — 0.45 is readable in a phone recording,
 * 0.15 is not. Do not lower these to make the player look tidier: legibility
 * after re-encoding is the entire point.
 */

const PRIMARY_ALPHA = '0.45';
const SECONDARY_ALPHA = '0.35';

/** Truncated so the phone number is identifiable to us but not fully readable
 *  to a bystander looking over the student's shoulder. */
export function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 6) return phone;
  return `${digits.slice(0, 5)}****${digits.slice(-3)}`;
}

/** Short, stable per session. Lets two leaks from one account be attributed to
 *  different sessions without printing a raw uuid on screen. */
export function sessionHash(sessionId: string): string {
  return createHash('sha256').update(sessionId).digest('hex').slice(0, 6);
}

/**
 * VdoCipher `annotate` payload: a JSON string of annotation objects.
 *
 * `rtext` moves the text around the frame on the given interval, which is what
 * makes cropping impractical — a fixed corner watermark is trimmed in seconds.
 */
export function buildVdocipherAnnotation(identity: WatermarkIdentity): string {
  const timestamp = new Date().toISOString().slice(0, 16).replace('T', ' ');

  return JSON.stringify([
    {
      type: 'rtext',
      text: `${identity.name} · ${maskPhone(identity.phone)}`,
      alpha: PRIMARY_ALPHA,
      color: '0xFFFFFF',
      size: '14',
      interval: '6000',
    },
    {
      type: 'rtext',
      text: `${identity.ip ?? 'unknown'} · ${timestamp} · ${identity.sessionHash}`,
      alpha: SECONDARY_ALPHA,
      color: '0xFFFFFF',
      size: '11',
      interval: '9000',
    },
  ]);
}

/**
 * Overlay spec for canvas-rendered documents (Section 9.2, 17.4).
 *
 * PDFs, note photos, quiz papers and assignment attachments all get this —
 * Section 17.4 is explicit that quiz papers and assignments get shared as often
 * as video. Rendered client-side over the canvas; the server only issues the
 * text so the client cannot choose what to display.
 */
export type DocumentWatermark = {
  primary: string;
  secondary: string;
  /** Diagonal repeating tile. Degrees. */
  angle: number;
  opacity: number;
};

export function buildDocumentWatermark(identity: WatermarkIdentity): DocumentWatermark {
  const timestamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
  return {
    primary: `${identity.name} · ${maskPhone(identity.phone)}`,
    secondary: `${timestamp} · ${identity.sessionHash}`,
    angle: -30,
    // Photographed handwritten notes have wildly varying backgrounds
    // (ADR 0001), so this cannot assume a white page. Tuned to stay legible
    // over both dark ink and bright paper.
    opacity: 0.22,
  };
}
