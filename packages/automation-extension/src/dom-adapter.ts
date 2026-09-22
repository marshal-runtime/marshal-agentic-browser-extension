/**
 * `PerceptionAdapter` implementation for a browser tab, wrapping the
 * existing `browser-actions.ts` functions (which already know how to talk
 * to the host's `browser_*` commands) behind the adapter contract shared
 * with the native/OCR adapters (see adapter.ts).
 */
import type { PerceptionAdapter, ActResult, ActOptions, ScreenshotResult } from './adapter.js';
import {
  asExpression,
  captureScreenshot,
  JS_STRATEGY_CLICK_SCRIPT,
  performAction,
  takePageText,
  takeSnapshot,
  unwrapEvaluateResult,
} from './browser-actions.js';
import { MARKER_SCRIPT } from './snapshot-script.js';
import { buildDeepActionScript, isDeepNode } from './snapshot-walk.js';
import type { AgenticBrowserRuntimeHost, BrowserRequestContext } from './contracts.js';
import type { PageSnapshot, RawSnapshotAction } from './types.js';

const SCROLL_INTO_VIEW_SCRIPT = (selector: string): string =>
  asExpression(
    `const el = document.querySelector(${JSON.stringify(selector)});
if (el) el.scrollIntoView({ block: 'center' });
return { ok: !!el };`,
  );

function isActResultOk(value: unknown): value is { readonly ok: boolean } {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { ok?: unknown }).ok === 'boolean'
  );
}

export class DomAdapter implements PerceptionAdapter {
  readonly kind = 'dom';

  constructor(
    private readonly host: AgenticBrowserRuntimeHost,
    private readonly context: BrowserRequestContext,
  ) {}

  get target(): string {
    return `tab chatId=${this.context.chatId}`;
  }

  snapshot(): Promise<PageSnapshot> {
    return takeSnapshot(this.host, this.context);
  }

  async marker(): Promise<readonly unknown[]> {
    const raw = await this.host.invokeBrowserCommand(
      'browser_execute_script',
      { script: asExpression(MARKER_SCRIPT) },
      this.context,
    );
    if (!raw.success) {
      throw new Error(
        raw.error?.message ?? 'AUTOMATION_MARKER_FAILED: browser_execute_script failed',
      );
    }
    const data = unwrapEvaluateResult(raw.data);
    if (!Array.isArray(data)) {
      throw new Error(
        'AUTOMATION_INVALID_MARKER: browser_execute_script did not return a marker array',
      );
    }
    // Array.isArray narrows to `any[]` regardless of the input type; the
    // declared return type is the real, honest type of a marker array.
    return data as unknown[];
  }

  async act(action: RawSnapshotAction, text?: string, options?: ActOptions): Promise<ActResult> {
    // A "sh:"/"if:" node lives inside a pierced shadow root or same-origin
    // iframe (see snapshot-walk.ts) and cannot be reached by a top-document
    // CSS selector, so it is driven entirely in-page instead of going
    // through the browser_click/browser_type/browser_select commands.
    if (isDeepNode(action.node)) {
      return this.actDeep(action, text);
    }
    if (options?.strategy === 'js' && action.kind === 'click' && action.node !== null) {
      return this.actJs(action);
    }
    if (action.offscreen && action.node !== null) {
      const selector = `[data-mjev-id="${action.node}"]`;
      await this.host
        .invokeBrowserCommand(
          'browser_execute_script',
          { script: SCROLL_INTO_VIEW_SCRIPT(selector) },
          this.context,
        )
        .catch(() => undefined);
    }
    return performAction(this.host, this.context, action, text);
  }

  /**
   * ActOptions{strategy:'js'} fallback: scrolls into view, focuses, and
   * clicks entirely in-page (never CDP). Passes role/label/box so the script
   * can re-resolve the target by proximity if a re-render destroyed and
   * replaced the stamped element (the stale `data-mjev-id` selector then
   * matches nothing at all - see RESOLVE_BY_ROLE_LABEL_BOX_HELPER).
   */
  private async actJs(action: RawSnapshotAction): Promise<ActResult> {
    const node = action.node as string;
    const selector = `[data-mjev-id="${node}"]`;
    try {
      const raw = await this.host.invokeBrowserCommand(
        'browser_execute_script',
        { script: JS_STRATEGY_CLICK_SCRIPT(selector, action.role, action.label, action.box) },
        this.context,
      );
      if (!raw.success) {
        return {
          ok: false,
          error: raw.error?.message ?? 'AUTOMATION_JS_CLICK_FAILED: browser_execute_script failed',
        };
      }
      const data = unwrapEvaluateResult(raw.data);
      if (!isActResultOk(data) || !data.ok) {
        return { ok: false, error: `AUTOMATION_JS_CLICK_FAILED: could not find node "${node}"` };
      }
      return { ok: true };
    } catch (error: unknown) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  private async actDeep(action: RawSnapshotAction, text?: string): Promise<ActResult> {
    const node = action.node;
    if (node === null)
      return { ok: false, error: 'AUTOMATION_INVALID_ACTION: deep action has no node' };
    const script = buildDeepActionScript(
      node,
      { kind: action.kind, value: action.kind === 'fill' ? (text ?? '') : action.value },
      action.offscreen === true,
    );
    try {
      const raw = await this.host.invokeBrowserCommand(
        'browser_execute_script',
        { script: asExpression(script) },
        this.context,
      );
      if (!raw.success) {
        return {
          ok: false,
          error:
            raw.error?.message ?? 'AUTOMATION_DEEP_ACTION_FAILED: browser_execute_script failed',
        };
      }
      const data = unwrapEvaluateResult(raw.data);
      if (!isActResultOk(data) || !data.ok) {
        return {
          ok: false,
          error: `AUTOMATION_DEEP_ACTION_FAILED: could not resolve node "${node}"`,
        };
      }
      return { ok: true };
    } catch (error: unknown) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  fullText(): Promise<string> {
    return takePageText(this.host, this.context);
  }

  async screenshot(): Promise<ScreenshotResult> {
    const shot = await captureScreenshot(this.host, this.context);
    return { data: shot.data, mimeType: shot.mimeType };
  }
}
