import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SNAPSHOT_SCRIPT } from './snapshot-script.js';
import type { AgenticBrowserRuntimeHost, BrowserRequestContext } from './contracts.js';
import type { PageSnapshot, RawSnapshotAction } from './types.js';

export class BrowserCommandError extends Error {
  constructor(
    readonly command: string,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'BrowserCommandError';
  }
}

async function invoke(
  host: AgenticBrowserRuntimeHost,
  command: string,
  params: Record<string, unknown>,
  context: BrowserRequestContext,
): Promise<unknown> {
  const result = await host.invokeBrowserCommand(command, params, context);
  if (!result.success) {
    throw new BrowserCommandError(
      command,
      result.error?.code ?? 'BROWSER_COMMAND_FAILED',
      result.error?.message ?? `Browser command "${command}" failed.`,
    );
  }
  return result.data;
}

function isPageSnapshot(value: unknown): value is PageSnapshot {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { url?: unknown }).url === 'string' &&
    Array.isArray((value as { actions?: unknown }).actions) &&
    Array.isArray((value as { marker?: unknown }).marker)
  );
}

/**
 * The live Marshal host evaluates `browser_execute_script` input as a JS
 * EXPRESSION (a top-level `return` is a SyntaxError) and awaits promises, so
 * a function-body script must be wrapped as an async IIFE.
 */
export function asExpression(body: string): string {
  return `(async () => {\n${body}\n})()`;
}

/** The host returns evaluate output as `{ success, result }`; unwrap it (raw values pass through). */
export function unwrapEvaluateResult(data: unknown): unknown {
  if (typeof data === 'object' && data !== null && !Array.isArray(data) && 'result' in data) {
    return (data as { result: unknown }).result;
  }
  return data;
}

export async function takeSnapshot(
  host: AgenticBrowserRuntimeHost,
  context: BrowserRequestContext,
): Promise<PageSnapshot> {
  const raw = await invoke(
    host,
    'browser_execute_script',
    { script: asExpression(SNAPSHOT_SCRIPT) },
    context,
  );
  const data = unwrapEvaluateResult(raw);
  if (!isPageSnapshot(data)) {
    throw new Error(
      'AUTOMATION_INVALID_SNAPSHOT: browser_execute_script did not return a page snapshot',
    );
  }
  return data;
}

const PAGE_TEXT_LIMIT = 400_000;
const PAGE_TEXT_SCRIPT = `return document.body ? document.body.innerText.slice(0, ${String(PAGE_TEXT_LIMIT)}) : '';`;

/** Full-page text (the snapshot only carries the visible viewport), for `observe { find }`. */
export async function takePageText(
  host: AgenticBrowserRuntimeHost,
  context: BrowserRequestContext,
): Promise<string> {
  const raw = await invoke(
    host,
    'browser_execute_script',
    { script: asExpression(PAGE_TEXT_SCRIPT) },
    context,
  );
  const data = unwrapEvaluateResult(raw);
  if (typeof data !== 'string') {
    throw new Error(
      'AUTOMATION_INVALID_PAGE_TEXT: browser_execute_script did not return page text',
    );
  }
  return data;
}

/** Compares two `marker` arrays (from either a full snapshot or the adapter's fast `marker()` path). */
export function markersEqual(a: readonly unknown[], b: readonly unknown[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function fingerprintsEqual(a: PageSnapshot, b: PageSnapshot): boolean {
  return markersEqual(a.marker, b.marker);
}

const SELECTOR_FOR_NODE = (node: string): string => `[data-mjev-id="${node}"]`;

/**
 * After a CDP `browser_click`, some widgets (Vue/React typeahead forms in
 * particular) re-render or blur right as the click lands, swallowing it.
 * If the clicked element is a submit control still present 250ms later (i.e.
 * no navigation happened), retry with an in-page `el.click()` - native click
 * activation triggers the same form submit without relying on CDP timing.
 * A no-op for anything that isn't a submit control inside a form.
 */
const SUBMIT_CLICK_FALLBACK_SCRIPT = (selector: string): string =>
  asExpression(
    `const isSubmitControl = (el) => {
  if (!el) return false;
  if (el.tagName === 'BUTTON') return !el.hasAttribute('type') || el.getAttribute('type') === 'submit';
  if (el.tagName === 'INPUT') return el.type === 'submit';
  return false;
};
const el = document.querySelector(${JSON.stringify(selector)});
if (!el || !isSubmitControl(el) || !el.closest('form')) return { ok: true, retried: false };
await new Promise((resolve) => setTimeout(resolve, 250));
const stillThere = document.querySelector(${JSON.stringify(selector)});
if (stillThere) { stillThere.click(); return { ok: true, retried: true }; }
return { ok: true, retried: false };`,
  );

/**
 * Some re-rendering widgets (Vue/React virtual-DOM diffing) destroy and
 * recreate the target element entirely between the snapshot that stamped it
 * and the moment we act - the old `data-mjev-id` selector then matches
 * nothing at all, even after a settle delay. Falls back to re-locating a
 * same-role, same-accessible-name element whose box center is close (<=8px)
 * to the stale box, so the 'js' strategy can still recover the *new* node.
 */
const RESOLVE_BY_ROLE_LABEL_BOX_HELPER = `
function __mjevResolveByRoleLabelBox(role, label, box) {
  const roleSelectors = {
    button: 'button, input[type=button], input[type=submit], input[type=reset], [role=button]',
    link: 'a[href], [role=link]',
    textbox: 'input, textarea, [contenteditable="true"], [role=textbox]',
    searchbox: 'input[type=search], [role=searchbox]',
    combobox: 'select, [role=combobox]',
    checkbox: 'input[type=checkbox], [role=checkbox]',
    radio: 'input[type=radio], [role=radio]',
    spinbutton: 'input[type=number], [role=spinbutton]',
  };
  const sel = (role && roleSelectors[role]) || 'a[href],button,input,textarea,select,[role]';
  const nameOf = (e) => (e.getAttribute('aria-label') || e.value || e.textContent || e.getAttribute('title') || e.getAttribute('placeholder') || '').trim();
  const targetCx = box ? box[0] + box[2] / 2 : null;
  const targetCy = box ? box[1] + box[3] / 2 : null;
  let best = null, bestDist = Infinity;
  for (const el of document.querySelectorAll(sel)) {
    if (!el.checkVisibility || !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) continue;
    if (label && nameOf(el) !== label) continue;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) continue;
    if (targetCx === null) { best = el; break; }
    const cx = r.x + r.width / 2, cy = r.y + r.height / 2;
    const dist = Math.hypot(cx - targetCx, cy - targetCy);
    if (dist <= 8 && dist < bestDist) { best = el; bestDist = dist; }
  }
  return best;
}
`;

/**
 * The 'js' ActOptions strategy's script for a top-document node: in-page
 * `el.scrollIntoView(); el.focus?.(); el.click();`. If the stamped selector
 * no longer matches anything (the element was destroyed and replaced by a
 * re-render - see RESOLVE_BY_ROLE_LABEL_BOX_HELPER), re-resolves the target
 * by role/accessible-name/box proximity before giving up.
 */
export const JS_STRATEGY_CLICK_SCRIPT = (
  selector: string,
  role: string | undefined,
  label: string,
  box: readonly [number, number, number, number] | undefined,
): string =>
  asExpression(
    `${RESOLVE_BY_ROLE_LABEL_BOX_HELPER}
let el = document.querySelector(${JSON.stringify(selector)});
if (!el) el = __mjevResolveByRoleLabelBox(${JSON.stringify(role ?? null)}, ${JSON.stringify(label)}, ${JSON.stringify(box ?? null)});
if (!el) return { ok: false };
el.scrollIntoView({ block: 'center' });
if (el.focus) el.focus();
el.click();
return { ok: true };`,
  );

/** Presses Enter in the given (focused) field: `form.requestSubmit()` when it belongs to a form, else a synthetic keydown/keyup. */
const SUBMIT_FIELD_SCRIPT = (selector: string): string =>
  asExpression(
    `const el = document.querySelector(${JSON.stringify(selector)});
if (!el) return { ok: false };
if (el.form) {
  el.form.requestSubmit();
} else {
  el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  el.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true }));
}
return { ok: true };`,
  );

export interface PerformActionResult {
  readonly ok: boolean;
  readonly error?: string;
}

/** Executes one RawSnapshotAction. `text` is required and used only for `fill`. */
export async function performAction(
  host: AgenticBrowserRuntimeHost,
  context: BrowserRequestContext,
  action: RawSnapshotAction,
  text: string | undefined,
): Promise<PerformActionResult> {
  try {
    switch (action.kind) {
      case 'click': {
        if (action.node === null)
          throw new Error('AUTOMATION_INVALID_ACTION: click action has no node');
        const selector = SELECTOR_FOR_NODE(action.node);
        await invoke(host, 'browser_click', { selector }, context);
        // Verify+fallback: harmless no-op unless the target is a submit control still present after 250ms.
        await invoke(
          host,
          'browser_execute_script',
          { script: SUBMIT_CLICK_FALLBACK_SCRIPT(selector) },
          context,
        ).catch(() => undefined);
        return { ok: true };
      }
      case 'submit': {
        if (action.node === null)
          throw new Error('AUTOMATION_INVALID_ACTION: submit action has no node');
        const result = unwrapEvaluateResult(
          await invoke(
            host,
            'browser_execute_script',
            { script: SUBMIT_FIELD_SCRIPT(SELECTOR_FOR_NODE(action.node)) },
            context,
          ),
        );
        if ((result as { ok?: unknown } | null)?.ok !== true) {
          return {
            ok: false,
            error: 'AUTOMATION_SUBMIT_FAILED: could not submit the focused field',
          };
        }
        return { ok: true };
      }
      case 'fill': {
        if (action.node === null)
          throw new Error('AUTOMATION_INVALID_ACTION: fill action has no node');
        if (text === undefined)
          throw new Error('AUTOMATION_MISSING_VALUE: no text supplied for fill action');
        await invoke(
          host,
          'browser_type',
          { selector: SELECTOR_FOR_NODE(action.node), text, clearFirst: true },
          context,
        );
        return { ok: true };
      }
      case 'select': {
        if (action.node === null)
          throw new Error('AUTOMATION_INVALID_ACTION: select action has no node');
        // The host's browser_select needs an aria-snapshot `ref`; our nodes are addressed by CSS selector, so set the option in-page.
        const selectScript = asExpression(
          `const el = document.querySelector(${JSON.stringify(SELECTOR_FOR_NODE(action.node))});
if (!el || el.tagName !== 'SELECT') return { ok: false };
el.value = ${JSON.stringify(action.value ?? '')};
el.dispatchEvent(new Event('input', { bubbles: true }));
el.dispatchEvent(new Event('change', { bubbles: true }));
return { ok: el.value === ${JSON.stringify(action.value ?? '')} };`,
        );
        const selected = unwrapEvaluateResult(
          await invoke(host, 'browser_execute_script', { script: selectScript }, context),
        );
        if ((selected as { ok?: unknown } | null)?.ok !== true) {
          return { ok: false, error: 'AUTOMATION_SELECT_FAILED: option could not be selected' };
        }
        return { ok: true };
      }
      case 'scroll': {
        await invoke(host, 'browser_scroll', { y: action.delta ?? 0 }, context);
        return { ok: true };
      }
      case 'wait': {
        await new Promise((resolve) => setTimeout(resolve, 500));
        return { ok: true };
      }
      default:
        return { ok: false, error: `AUTOMATION_UNKNOWN_ACTION_KIND: ${String(action.kind)}` };
    }
  } catch (error: unknown) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function navigate(
  host: AgenticBrowserRuntimeHost,
  context: BrowserRequestContext,
  url: string,
): Promise<PerformActionResult> {
  try {
    await invoke(host, 'browser_navigate', { url }, context);
    return { ok: true };
  } catch (error: unknown) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export interface ScreenshotData {
  readonly data: string;
  readonly mimeType: string;
}

function isScreenshotData(
  value: unknown,
): value is { data: string; mimeType?: string; format?: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { data?: unknown }).data === 'string' &&
    (value as { data: string }).data.length > 0
  );
}

/** Captures a screenshot; the host returns `{ data: <base64>, format: 'png' }` (no mimeType). */
export async function captureScreenshot(
  host: AgenticBrowserRuntimeHost,
  context: BrowserRequestContext,
): Promise<ScreenshotData> {
  const data = await invoke(host, 'browser_screenshot', {}, context);
  if (!isScreenshotData(data)) {
    throw new Error('AUTOMATION_INVALID_SCREENSHOT: browser_screenshot did not return image data');
  }
  const mimeType = data.mimeType ?? `image/${data.format ?? 'png'}`;
  return { data: data.data, mimeType };
}

/** Writes the screenshot to a temp file so a planner can view it without a ~MB base64 payload entering its context. */
export async function saveScreenshot(
  shot: ScreenshotData,
  runId: string,
): Promise<{ readonly path: string; readonly bytes: number }> {
  const directory = join(tmpdir(), 'marshal-automation-screenshots');
  await mkdir(directory, { recursive: true });
  const extension = shot.mimeType.includes('jpeg') ? 'jpg' : 'png';
  const path = join(directory, `${runId}-${String(Date.now())}.${extension}`);
  const buffer = Buffer.from(shot.data, 'base64');
  await writeFile(path, buffer);
  return { path, bytes: buffer.length };
}
