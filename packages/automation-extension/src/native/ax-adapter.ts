/**
 * `PerceptionAdapter` over the macOS Accessibility tree, via
 * `marshal-ax-helper` (see native/ax-helper/README and ax-helper-client.ts).
 * Produces the same `PageSnapshot`/`RawSnapshotAction` shape as the DOM
 * adapter so the unchanged executor/decide/action-space/checks pipeline
 * drives a native app exactly like a browser tab.
 */
import { readFile } from 'node:fs/promises';
import type { ActResult, PerceptionAdapter, ScreenshotResult } from '../adapter.js';
import type { FocusedField, PageSnapshot, RawSnapshotAction } from '../types.js';
import type { AxHelperClient } from './ax-helper-client.js';

export interface AxTarget {
  readonly bundleId: string;
  readonly pid: number;
  readonly appName: string;
}

interface HelperElement {
  readonly id: string;
  readonly role: string;
  readonly label: string;
  readonly value?: string;
  readonly enabled: boolean;
  readonly editable: boolean;
  readonly checked?: boolean;
  readonly expanded?: boolean;
  readonly selected?: boolean;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly offscreen: boolean;
  readonly where: string;
  readonly actions: readonly string[];
  /** kAXSubroleAttribute, e.g. "AXCloseButton" on a window's traffic-light close button. */
  readonly subrole?: string;
}

/**
 * Window-chrome subroles that are dangerous to expose as ordinary click
 * candidates: with no accessible name, Jev previously mistook an unlabeled
 * traffic-light button for some other control and closed a live app window.
 * Each maps to the keyword that must appear in the run goal to allow it back
 * into the snapshot - e.g. a goal that actually says "close the window".
 */
const DANGEROUS_CHROME_SUBROLES: Readonly<Record<string, RegExp>> = {
  AXCloseButton: /\bclose\b/i,
  AXMinimizeButton: /\bminimize\b/i,
};

function isSubroleAllowed(subrole: string | undefined, goal: string | undefined): boolean {
  if (subrole === undefined) return true;
  const requiredKeyword = DANGEROUS_CHROME_SUBROLES[subrole];
  if (requiredKeyword === undefined) return true;
  return goal !== undefined && requiredKeyword.test(goal);
}

interface HelperSnapshot {
  readonly app: { readonly bundleId: string; readonly name: string; readonly pid: number };
  /** null when the app has no focused/main/first window (e.g. all windows closed) - see `reason`. */
  readonly window: {
    readonly title: string;
    readonly x: number;
    readonly y: number;
    readonly w: number;
    readonly h: number;
  } | null;
  /** e.g. "no-window" when `window` is null. */
  readonly reason?: string;
  readonly focused: {
    readonly role?: string;
    readonly label: string;
    readonly value?: string;
    readonly placeholder?: string;
  } | null;
  readonly text: string;
  readonly elements: readonly HelperElement[];
  readonly marker: string;
}

function isHelperSnapshot(value: unknown): value is HelperSnapshot {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v['text'] === 'string' &&
    Array.isArray(v['elements']) &&
    typeof v['marker'] === 'string' &&
    typeof v['window'] === 'object'
  );
}

function toRawAction(element: HelperElement): RawSnapshotAction[] {
  const box: readonly [number, number, number, number] = [
    element.x,
    element.y,
    element.w,
    element.h,
  ];
  const base = {
    node: element.id,
    role: element.role,
    box,
    where: element.where,
    ...(element.offscreen ? { offscreen: true } : {}),
    ...(element.checked === undefined ? {} : { checked: String(element.checked) }),
    ...(element.selected === undefined ? {} : { selected: String(element.selected) }),
    ...(element.expanded === undefined ? {} : { expanded: String(element.expanded) }),
    source: 'ax' as const,
  };
  if (element.editable) {
    const fill: RawSnapshotAction = {
      ...base,
      kind: 'fill',
      label: element.label,
      value: element.value ?? '',
    };
    const openClick: RawSnapshotAction = {
      ...base,
      kind: 'click',
      label: `Open ${element.label}`,
      value: element.value ?? '',
    };
    return [fill, openClick];
  }
  return [{ ...base, kind: 'click', label: element.label }];
}

function toFocusedField(focused: HelperSnapshot['focused']): FocusedField | null | undefined {
  if (focused === null) return null;
  if (!focused.label && !focused.role) return undefined;
  return {
    ...(focused.role ? { role: focused.role } : {}),
    label: focused.label,
    ...(focused.value === undefined ? {} : { value: focused.value }),
    ...(focused.placeholder === undefined ? {} : { placeholder: focused.placeholder }),
  };
}

export interface ScreenshotWindowResult {
  readonly path: string;
  readonly w: number;
  readonly h: number;
  readonly originX: number;
  readonly originY: number;
  readonly scale: number;
}

function isScreenshotWindowResult(
  value: Record<string, unknown>,
): value is Record<string, unknown> & ScreenshotWindowResult {
  return (
    typeof value['path'] === 'string' &&
    typeof value['w'] === 'number' &&
    typeof value['h'] === 'number' &&
    typeof value['originX'] === 'number' &&
    typeof value['originY'] === 'number' &&
    typeof value['scale'] === 'number'
  );
}

export interface AxAdapterOptions {
  /** The run's goal text - when present, unlocks a matching dangerous chrome subrole (e.g. "close" allows AXCloseButton). */
  readonly goal?: string;
}

export class AxAdapter implements PerceptionAdapter {
  readonly kind = 'ax';
  readonly target: string;
  /** Bundle id of the pinned app - consumed by HybridAdapter's low-AX-coverage bundle-id list (hybrid-adapter.ts). */
  readonly bundleId: string;
  private readonly client: AxHelperClient;
  private readonly pid: number;
  private readonly goal: string | undefined;
  private lastSnapshot: HelperSnapshot | undefined;

  constructor(client: AxHelperClient, targetApp: AxTarget, options: AxAdapterOptions = {}) {
    this.client = client;
    this.pid = targetApp.pid;
    this.bundleId = targetApp.bundleId;
    this.target = `app ${targetApp.bundleId}`;
    this.goal = options.goal;
  }

  private async rawSnapshot(): Promise<HelperSnapshot> {
    const response = await this.client.callWithRestart({ op: 'snapshot', pid: this.pid }, 5_000);
    if (!response.ok || !isHelperSnapshot(response)) {
      throw new Error(
        `AX_ADAPTER_SNAPSHOT_FAILED: ${response.error ?? 'malformed snapshot response'}`,
      );
    }
    this.lastSnapshot = response;
    return response;
  }

  async snapshot(): Promise<PageSnapshot> {
    const raw = await this.rawSnapshot();
    const visibleElements = raw.elements.filter((element) =>
      isSubroleAllowed(element.subrole, this.goal),
    );
    const actions: RawSnapshotAction[] = visibleElements.flatMap(toRawAction);
    actions.push({
      node: null,
      kind: 'scroll',
      label: 'Scroll down',
      delta: 560,
      id: 'scroll_down',
    });
    actions.push({ node: null, kind: 'scroll', label: 'Scroll up', delta: -560, id: 'scroll_up' });
    actions.push({ node: null, kind: 'wait', label: 'Wait for the app to update', id: 'wait' });

    const focused = toFocusedField(raw.focused);
    if (raw.window === null) {
      return {
        url: `app://${raw.app.bundleId}/(no window)`,
        title: raw.app.name,
        w: 0,
        h: 0,
        text: raw.text || `No window is open for ${raw.app.name}`,
        scroll: { y: 0, height: 0 },
        actions,
        marker: [raw.marker],
        omittedActions: 0,
        ...(focused === undefined ? {} : { focused }),
      };
    }
    return {
      url: `app://${raw.app.bundleId}/${raw.window.title}`,
      title: raw.window.title || raw.app.name,
      w: raw.window.w,
      h: raw.window.h,
      text: raw.text,
      scroll: { y: 0, height: raw.window.h },
      actions,
      marker: [raw.marker],
      omittedActions: 0,
      ...(focused === undefined ? {} : { focused }),
    };
  }

  async marker(): Promise<readonly unknown[]> {
    const raw = await this.rawSnapshot();
    return [raw.marker];
  }

  async act(action: RawSnapshotAction, text?: string): Promise<ActResult> {
    try {
      switch (action.kind) {
        case 'click': {
          if (action.node === null)
            return { ok: false, error: 'AX_ADAPTER_NO_NODE: click action has no node' };
          const response = await this.client.callWithRestart(
            { op: 'press', nodeId: action.node },
            5_000,
          );
          return response.ok ? { ok: true } : { ok: false, error: response.error };
        }
        case 'fill': {
          if (action.node === null)
            return { ok: false, error: 'AX_ADAPTER_NO_NODE: fill action has no node' };
          if (text === undefined)
            return {
              ok: false,
              error: 'AX_ADAPTER_MISSING_VALUE: no text supplied for fill action',
            };
          const response = await this.client.callWithRestart(
            { op: 'setValue', nodeId: action.node, text },
            5_000,
          );
          return response.ok ? { ok: true } : { ok: false, error: response.error };
        }
        case 'scroll': {
          const raw = this.lastSnapshot ?? (await this.rawSnapshot());
          if (raw.window === null)
            return { ok: false, error: 'AX_ADAPTER_NO_WINDOW: no window to scroll' };
          const cx = raw.window.x + raw.window.w / 2;
          const cy = raw.window.y + raw.window.h / 2;
          const response = await this.client.callWithRestart(
            { op: 'scroll', x: cx, y: cy, dy: action.delta ?? 0 },
            5_000,
          );
          return response.ok ? { ok: true } : { ok: false, error: response.error };
        }
        case 'wait': {
          await new Promise((resolve) => setTimeout(resolve, 500));
          return { ok: true };
        }
        default:
          return { ok: false, error: `AX_ADAPTER_UNKNOWN_ACTION_KIND: ${String(action.kind)}` };
      }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async fullText(): Promise<string> {
    const raw = this.lastSnapshot ?? (await this.rawSnapshot());
    return raw.text;
  }

  async screenshot(): Promise<ScreenshotResult> {
    const shot = await this.screenshotWindow();
    const buffer = await readFile(shot.path);
    return { data: buffer.toString('base64'), mimeType: 'image/png' };
  }

  /** Screen point at (x, y), for HybridAdapter's OCR-fallback click path (hybrid-adapter.ts). */
  async clickAt(x: number, y: number): Promise<void> {
    const response = await this.client.callWithRestart({ op: 'click', x, y }, 5_000);
    if (!response.ok)
      throw new Error(`AX_ADAPTER_CLICK_FAILED: ${response.error ?? 'click did not succeed'}`);
  }

  /** Raw window capture with the geometry needed to map OCR pixel boxes back to screen points (hybrid-adapter.ts). */
  async screenshotWindow(): Promise<ScreenshotWindowResult> {
    const response = await this.client.callWithRestart({ op: 'screenshot', pid: this.pid }, 5_000);
    if (!response.ok || !isScreenshotWindowResult(response)) {
      throw new Error(
        `AX_ADAPTER_SCREENSHOT_FAILED: ${response.error ?? 'no path/geometry returned'}`,
      );
    }
    return {
      path: response.path,
      w: response.w,
      h: response.h,
      originX: response.originX,
      originY: response.originY,
      scale: response.scale,
    };
  }
}
