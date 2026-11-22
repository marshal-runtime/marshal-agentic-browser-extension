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
  maxHeight: 1600,
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

/** The page sizes a panel may ask for (CSS pixels): a phone-narrow pane up to a large desktop window. */
export const FIT_LIMITS = {
  minWidth: 320,
  minHeight: 240,
  maxWidth: 1920,
  maxHeight: 1600,
} as const;

/**
 * The page size that fills a panel like a browser pane. `view` is the panel's picture area in device pixels and its
 * devicePixelRatio. On a high-density screen (ratio 1.5 and up) the page gets two device pixels per CSS pixel, as a
 * browser window there has (three from 2.5, a phone); otherwise one. Either way the page's device pixels equal the
 * panel's, so the picture is drawn 1:1, and the page is laid out for the pane's real size (not a fixed desktop size
 * shrunk into it). A pane larger than the limits gets the largest page of its own shape, which the panel scales up
 * to fill. Null when the view is not a sane size.
 */
export function panelFit(
  view:
    | { readonly width: number; readonly height: number; readonly dpr?: number | undefined }
    | undefined,
): { width: number; height: number; deviceScaleFactor: 1 | 2 | 3 } | null {
  if (!view || !(view.width > 0) || !(view.height > 0)) return null;
  const dpr = view.dpr !== undefined && Number.isFinite(view.dpr) && view.dpr > 0 ? view.dpr : 1;
  const deviceScaleFactor = dpr >= 2.5 ? 3 : dpr >= 1.5 ? 2 : 1;
  const width = view.width / deviceScaleFactor;
  const height = view.height / deviceScaleFactor;
  // Too large: shrink both sides alike, so the picture still has the pane's shape.
  const shrink = Math.min(1, FIT_LIMITS.maxWidth / width, FIT_LIMITS.maxHeight / height);
  return {
    width: Math.max(FIT_LIMITS.minWidth, Math.round(width * shrink)),
    height: Math.max(FIT_LIMITS.minHeight, Math.round(height * shrink)),
    deviceScaleFactor,
  };
}

/**
 * A web address from what a person typed in the panel's address field, or null when it is not one. Only http and
 * https; a bare host gets https, a loopback host http (a local dev server). Parsing a URL is grammar, not meaning:
 * words that are no address are refused, never sent to a search engine.
 */
export function addressOf(typed: string): string | null {
  const text = typed.trim();
  if (!text || text.length > 2_000 || /[\s\p{Cc}]/u.test(text)) return null;
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(text)?.[1]?.toLowerCase();
  if (scheme !== undefined && scheme !== 'http' && scheme !== 'https') return null;
  const loopback = /^(localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::\d+)?(?:[/?#]|$)/i.test(text);
  let url: URL;
  try {
    url = new URL(scheme === undefined ? `${loopback ? 'http' : 'https'}://${text}` : text);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  // A host is a name with a dot, a loopback name or an address: "hello" alone is a word, not a site.
  const host = url.hostname;
  if (!host || !(host.includes('.') || host === 'localhost' || host.startsWith('['))) return null;
  if (url.username || url.password) return null;
  // Link-local addresses (a cloud host's metadata service lives there) are nothing a person browses to. The URL
  // parser has already normalized every spelling of an IPv4 address (decimal, hex, short) to dotted form. This is a
  // refusal of the obvious, not a network boundary: the tab reaches what `browser.session.open` reaches.
  if (/^169\.254\.\d+\.\d+$/.test(host) || /^\[fe[89ab][0-9a-f]:/i.test(host)) return null;
  return url.href;
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
