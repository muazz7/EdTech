'use client';

export type DocumentWatermark = {
  primary: string;
  secondary: string;
  angle: number;
  opacity: number;
};

/**
 * Draws the watermark INTO the canvas bitmap.
 *
 * Not a CSS overlay on top of the canvas: an absolutely-positioned div is
 * removed with two clicks in devtools, and any canvas export would come out
 * clean. Compositing into the pixels means a right-click "save image", a
 * toDataURL call, or a screenshot all carry the attribution.
 *
 * Section 17.4 is the reason this matters: pointing a second phone at the screen
 * cannot be prevented by anything at any price, so attribution IS the defence.
 * A leaked page has to identify the account it came from.
 *
 * This is deterrence on web, not prevention — Section 17.3 says plainly that
 * Print Screen captures a canvas like anything else. On mobile FLAG_SECURE does
 * block it, which is the argument for putting the highest-value notes there.
 */
export function stampWatermark(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  mark: DocumentWatermark,
): void {
  ctx.save();

  // Scaled to the page so a large PDF is not covered in tiny illegible text
  // and a phone photo is not covered in enormous text.
  const fontSize = Math.max(13, Math.min(22, Math.round(width / 42)));
  const gapX = fontSize * 22;
  const gapY = fontSize * 9;

  ctx.globalAlpha = mark.opacity;
  ctx.font = `600 ${fontSize}px Inter, system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  // Photographed handwritten notes have unpredictable backgrounds (ADR 0001),
  // so a single ink colour would vanish on some pages. A dark glyph with a
  // light halo stays legible on both a bright page and a dark scan.
  ctx.lineWidth = Math.max(2, fontSize / 7);
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.65)';
  ctx.fillStyle = 'rgba(15, 23, 42, 0.95)';

  const radians = (mark.angle * Math.PI) / 180;
  // Rotating the grid means the tiles must cover the diagonal, not the width.
  const reach = Math.ceil(Math.hypot(width, height));

  ctx.translate(width / 2, height / 2);
  ctx.rotate(radians);

  for (let y = -reach; y <= reach; y += gapY) {
    for (let x = -reach; x <= reach; x += gapX) {
      ctx.strokeText(mark.primary, x, y);
      ctx.fillText(mark.primary, x, y);

      ctx.save();
      ctx.globalAlpha = mark.opacity * 0.85;
      ctx.font = `500 ${Math.round(fontSize * 0.78)}px Inter, system-ui, sans-serif`;
      ctx.strokeText(mark.secondary, x, y + fontSize * 1.35);
      ctx.fillText(mark.secondary, x, y + fontSize * 1.35);
      ctx.restore();
    }
  }

  ctx.restore();
}

/**
 * Fetches bytes through the browser rather than pointing an <img> or <embed> at
 * the signed URL.
 *
 * The URL never lands in the DOM, so it is not in the page source, not in a
 * right-click "copy image address", and not in the browser's media panel. It
 * still exists in the network log — this raises the effort, it does not make
 * the URL secret.
 */
export async function fetchBytes(url: string): Promise<Blob> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(
      res.status === 403
        ? 'This link expired. Reload the page to get a fresh one.'
        : `Could not load the file (${res.status}).`,
    );
  }
  return res.blob();
}
