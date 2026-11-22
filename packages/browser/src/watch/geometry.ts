/**
 * The live panel's geometry, in one place so tests check the exact code the panel runs:
 *   - `containRect` and `clientToFrame` run INSIDE the panel (their source is embedded in its HTML with
 *     Function.prototype.toString, so they must stay self-contained: no imports, no outer names);
 *   - `framePoint` and `streamSize` run in the extension.
 * Coordinates cross the bridge normalized to the frame (0..1), so the page's real size is applied only here, where the
 * screencast told us what it is.
 */

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** The largest rectangle with the image's aspect ratio that fits in the box, centered (CSS `object-fit: contain`). */
export function containRect(
  boxWidth: number,
  boxHeight: number,
  imageWidth: number,
  imageHeight: number,
): Rect {
  if (!(boxWidth > 0) || !(boxHeight > 0) || !(imageWidth > 0) || !(imageHeight > 0))
    return { x: 0, y: 0, width: 0, height: 0 };
  const scale = Math.min(boxWidth / imageWidth, boxHeight / imageHeight);
  const width = Math.max(1, Math.round(imageWidth * scale));
  const height = Math.max(1, Math.round(imageHeight * scale));
  return {
    x: Math.round((boxWidth - width) / 2),
    y: Math.round((boxHeight - height) / 2),
    width,
    height,
  };
}

/**
 * A point in the panel (relative to the box) as a fraction of the drawn picture, or null when it falls on the
 * letterbox around the picture (nothing there to click).
 */
export function clientToFrame(
  pointX: number,
  pointY: number,
  picture: Rect,
): { nx: number; ny: number } | null {
  if (!(picture.width > 0) || !(picture.height > 0)) return null;
  const nx = (pointX - picture.x) / picture.width;
  const ny = (pointY - picture.y) / picture.height;
  if (!(nx >= 0 && nx <= 1 && ny >= 0 && ny <= 1)) return null;
  return { nx, ny };
}

/** A normalized frame point in the page's CSS pixels (what Input.dispatchMouseEvent takes), clamped inside it. */
export function framePoint(
  nx: number,
  ny: number,
  page: { readonly width: number; readonly height: number },
): { x: number; y: number } | null {
  if (!Number.isFinite(nx) || !Number.isFinite(ny) || nx < 0 || nx > 1 || ny < 0 || ny > 1)
    return null;
  if (!(page.width > 0) || !(page.height > 0)) return null;
  const x = Math.min(page.width - 1, Math.max(0, Math.round(nx * page.width)));
  const y = Math.min(page.height - 1, Math.max(0, Math.round(ny * page.height)));
  return { x, y };
}

/** Frame size limits: Chrome's own screencast floor, and a ceiling that keeps one frame well under FRAME_MAX_BYTES. */
export const STREAM_LIMITS = {
  minWidth: 160,
  minHeight: 120,
  maxWidth: 1920,
  maxHeight: 1200,
  /** Requests within this fraction of the running size do not restart the screencast (a panel being dragged). */
  slack: 0.08,
} as const;

/** One JPEG frame stays under this; a larger one lowers the quality of the next. */
export const FRAME_MAX_BYTES = 400_000;
export const QUALITY = { start: 80, min: 50, step: 10 } as const;

/**
 * The screencast size for a panel of `view` device pixels: the panel's own pixels, so the browser downsamples once and
 * the panel draws 1:1, within the limits. Chrome never upscales a screencast, so a panel larger than the page gets the
 * page's own pixels. Without a view (a panel that has not measured itself yet), the old default width.
 */
export function streamSize(view: { readonly width: number; readonly height: number } | undefined): {
  maxWidth: number;
  maxHeight: number;
} {
  const clamp = (value: number, min: number, max: number): number =>
    Math.min(max, Math.max(min, Math.round(value)));
  if (!view || !(view.width > 0) || !(view.height > 0)) {
    return { maxWidth: 960, maxHeight: STREAM_LIMITS.maxHeight };
  }
  return {
    maxWidth: clamp(view.width, STREAM_LIMITS.minWidth, STREAM_LIMITS.maxWidth),
    maxHeight: clamp(view.height, STREAM_LIMITS.minHeight, STREAM_LIMITS.maxHeight),
  };
}

/** True when `next` differs from `running` by more than the slack on either side. */
export function sizeChanged(
  running: { readonly maxWidth: number; readonly maxHeight: number },
  next: { readonly maxWidth: number; readonly maxHeight: number },
): boolean {
  const off = (a: number, b: number): boolean =>
    Math.abs(a - b) > STREAM_LIMITS.slack * Math.max(a, b);
  return off(running.maxWidth, next.maxWidth) || off(running.maxHeight, next.maxHeight);
}
