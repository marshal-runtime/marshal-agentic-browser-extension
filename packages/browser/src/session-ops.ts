/**
 * Step-by-step session operations beyond snapshot / act / screenshot (browser.session.wait, read, evaluate, log,
 * dialog). Each works on a Target and answers `unsupported_on_backend` when the backend has no way to do it, never a
 * substitute. Rules that hold here:
 *   - evaluate runs only in a Chrome this extension started (`managed`), behind its own high-risk permission; never in
 *     the person's own Chrome (the user backend drives it through the bridge's non-evaluate verbs only) or an app;
 *   - read and log return text the page wrote: data for the caller, never instructions (the descriptions say so);
 *   - log observes only (no request is held, changed or blocked) and carries no headers, bodies or cookies.
 */
import { CAPTURE_MAX_CSS, VIEWPORT_LIMITS } from './target.js';
import type { BackendKind, LogKind, ScreenshotOptions, Target, Viewport } from './target.js';

export const READ_DEFAULT = 100_000;
export const READ_MAX = 2_000_000;
export const EVALUATE_DEFAULT_MS = 10_000;
export const EVALUATE_MAX_MS = 60_000;
export const EVALUATE_RESULT_MAX = 500_000;
export const WAIT_DEFAULT_MS = 10_000;
export const WAIT_MAX_MS = 30_000;
const WAIT_POLL_MS = 250;

type Out = Record<string, unknown>;

export const unsupported = (backend: BackendKind, what: string): Out => ({
  ok: false,
  status: 'unsupported_on_backend',
  backend,
  error: `unsupported_on_backend: ${what} is not available on the ${backend} backend`,
});

const finite = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

/** A viewport input checked against the limits; throws BROWSER_BAD_INPUT naming the field. */
export function parseViewport(value: unknown): Viewport {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error(
      'BROWSER_BAD_INPUT: viewport must be {width, height, deviceScaleFactor?, mobile?, touch?}',
    );
  const input = value as Record<string, unknown>;
  const { minSide, maxWidth, maxHeight, maxScale } = VIEWPORT_LIMITS;
  const side = (name: 'width' | 'height', max: number): number => {
    const number = input[name];
    if (!finite(number) || !Number.isInteger(number) || number < minSide || number > max)
      throw new Error(
        `BROWSER_BAD_INPUT: viewport.${name} must be a whole number from ${String(minSide)} to ${String(max)}`,
      );
    return number;
  };
  const scale = input['deviceScaleFactor'];
  if (scale !== undefined && (!finite(scale) || scale <= 0 || scale > maxScale))
    throw new Error(
      `BROWSER_BAD_INPUT: viewport.deviceScaleFactor must be above 0 and at most ${String(maxScale)}`,
    );
  for (const flag of ['mobile', 'touch'] as const)
    if (input[flag] !== undefined && typeof input[flag] !== 'boolean')
      throw new Error(`BROWSER_BAD_INPUT: viewport.${flag} must be true or false`);
  return {
    width: side('width', maxWidth),
    height: side('height', maxHeight),
    ...(scale !== undefined ? { deviceScaleFactor: scale } : {}),
    ...(input['mobile'] !== undefined ? { mobile: input['mobile'] as boolean } : {}),
    ...(input['touch'] !== undefined ? { touch: input['touch'] as boolean } : {}),
  };
}

/** Sets the page's device size: managed Chrome only (the person's own window and apps are never resized). */
export async function viewport(target: Target, args: Out): Promise<Out> {
  const wanted = parseViewport(args);
  if (target.backend !== 'managed' || !target.setViewport)
    return unsupported(target.backend, 'viewport');
  await target.setViewport(wanted);
  return { ok: true, viewport: wanted };
}

/** The screenshot options a caller may pass: format, JPEG quality and a clip in CSS pixels. */
export function screenshotOptions(
  args: Out,
): Pick<ScreenshotOptions, 'format' | 'quality' | 'clip'> {
  const format = args['format'] ?? 'png';
  if (format !== 'png' && format !== 'jpeg')
    throw new Error('BROWSER_BAD_INPUT: format must be "png" or "jpeg"');
  const quality = args['quality'];
  if (quality !== undefined && (!finite(quality) || quality < 0 || quality > 100))
    throw new Error('BROWSER_BAD_INPUT: quality must be from 0 to 100');
  const raw = args['clip'];
  let clip: ScreenshotOptions['clip'];
  if (raw !== undefined) {
    const box = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
    const { x, y, width, height } = box;
    if (
      !finite(x) ||
      !finite(y) ||
      !finite(width) ||
      !finite(height) ||
      x < 0 ||
      y < 0 ||
      width <= 0 ||
      height <= 0
    )
      throw new Error(
        'BROWSER_BAD_INPUT: clip must be {x, y, width, height} in CSS pixels (x, y >= 0; width, height > 0)',
      );
    if (width > VIEWPORT_LIMITS.maxWidth || height > CAPTURE_MAX_CSS)
      throw new Error(
        `BROWSER_BAD_INPUT: clip is at most ${String(VIEWPORT_LIMITS.maxWidth)} wide and ${String(CAPTURE_MAX_CSS)} high`,
      );
    clip = { x, y, width, height };
  }
  return { format, ...(quality !== undefined ? { quality } : {}), ...(clip ? { clip } : {}) };
}

const clampNumber = (value: unknown, fallback: number, max: number): number => {
  const number = typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  return Math.min(Math.max(number, 0), max);
};

/**
 * Waits until the page shows `text`, stops showing `textGone`, or its address contains `urlIncludes` (all given ones
 * must hold), polling the backend's own text and snapshot, so it works on every backend.
 */
export async function waitFor(
  target: Target,
  args: Out,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => number = Date.now,
): Promise<Out> {
  const text = typeof args['text'] === 'string' && args['text'] ? args['text'] : undefined;
  const gone =
    typeof args['textGone'] === 'string' && args['textGone'] ? args['textGone'] : undefined;
  const urlIncludes =
    typeof args['urlIncludes'] === 'string' && args['urlIncludes']
      ? args['urlIncludes']
      : undefined;
  if (!text && !gone && !urlIncludes)
    throw new Error('BROWSER_BAD_INPUT: give text, textGone or urlIncludes');
  const timeoutMs = clampNumber(args['timeoutMs'], WAIT_DEFAULT_MS, WAIT_MAX_MS);
  const started = now();
  let url = '';
  for (;;) {
    const needsText = text !== undefined || gone !== undefined;
    const page = needsText ? await target.fullText() : '';
    if (urlIncludes) url = (await target.snapshot()).url;
    const met =
      (text === undefined || page.includes(text)) &&
      (gone === undefined || !page.includes(gone)) &&
      (urlIncludes === undefined || url.includes(urlIncludes));
    const elapsedMs = now() - started;
    if (met) return { ok: true, met: true, elapsedMs, ...(urlIncludes ? { url } : {}) };
    if (elapsedMs >= timeoutMs)
      return {
        ok: false,
        met: false,
        elapsedMs,
        error: `timeout: the condition did not hold within ${String(timeoutMs)} ms`,
        ...(urlIncludes ? { url } : {}),
      };
    await sleep(WAIT_POLL_MS);
  }
}

/** The page's visible text (every backend) or HTML (backends with `html`), cut at `maxChars`. */
export async function read(target: Target, args: Out): Promise<Out> {
  const format = args['format'] === 'html' ? 'html' : 'text';
  const max = Math.round(clampNumber(args['maxChars'], READ_DEFAULT, READ_MAX)) || READ_DEFAULT;
  let content: string;
  if (format === 'html') {
    if (!target.html) return unsupported(target.backend, 'reading HTML');
    content = await target.html();
  } else content = await target.fullText();
  return {
    ok: true,
    format,
    content: content.slice(0, max),
    length: content.length,
    truncated: content.length > max,
  };
}

/** Runs the caller's expression in a managed tab; refused everywhere else. */
export async function evaluate(target: Target, args: Out): Promise<Out> {
  const expression = args['expression'];
  if (typeof expression !== 'string' || !expression.trim())
    throw new Error('BROWSER_BAD_INPUT: expression is required');
  if (target.backend !== 'managed' || !target.evaluateExpression)
    return unsupported(target.backend, 'evaluate');
  const timeoutMs = clampNumber(args['timeoutMs'], EVALUATE_DEFAULT_MS, EVALUATE_MAX_MS);
  const value = await target.evaluateExpression(expression, timeoutMs);
  const json = (JSON.stringify(value) as string | undefined) ?? 'null';
  if (json.length > EVALUATE_RESULT_MAX)
    return {
      ok: false,
      error: `result-too-large: ${String(json.length)} characters of JSON (limit ${String(EVALUATE_RESULT_MAX)}); return it in parts`,
    };
  return { ok: true, value };
}

export function logKinds(value: unknown): LogKind[] {
  if (value === undefined) return ['console', 'network'];
  const list = Array.isArray(value) ? value : [value];
  const kinds = list.filter((kind): kind is LogKind => kind === 'console' || kind === 'network');
  if (kinds.length !== list.length || kinds.length === 0)
    throw new Error('BROWSER_BAD_INPUT: kinds must be "console" and/or "network"');
  return [...new Set(kinds)];
}

/**
 * Console messages and network requests seen since observing began (browser.session.open {observe} or the first call
 * here, which starts it). Returns what was collected, oldest first.
 */
export async function log(target: Target, args: Out): Promise<Out> {
  if (!target.observe || !target.log)
    return unsupported(target.backend, 'console and network logs');
  const kinds = logKinds(args['kinds']);
  const before = target.log(kinds, false).observing;
  const started = kinds.filter((kind) => !before.includes(kind));
  if (started.length) await target.observe(started);
  const { entries, dropped, observing } = target.log(kinds, args['clear'] === true);
  return {
    ok: true,
    entries,
    dropped,
    observing,
    ...(started.length ? { startedNow: started } : {}),
  };
}

/** Reads (no `accept`) or answers the open JavaScript dialog. */
export async function dialog(target: Target, args: Out): Promise<Out> {
  if (!target.pendingDialog || !target.answerDialog)
    return unsupported(target.backend, 'JavaScript dialogs');
  const open = target.pendingDialog();
  if (typeof args['accept'] !== 'boolean') return { ok: true, dialog: open };
  if (!open) return { ok: false, error: 'BROWSER_NO_DIALOG: no dialog is open in this session' };
  const text = typeof args['promptText'] === 'string' ? args['promptText'] : undefined;
  await target.answerDialog(args['accept'], text);
  return { ok: true, answered: open, accepted: args['accept'] };
}
