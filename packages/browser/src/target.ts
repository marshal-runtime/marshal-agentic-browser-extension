/**
 * The one seam every backend sits behind, evolved from automation-extension's `PerceptionAdapter`
 * (packages/automation-extension/src/adapter.ts): a target produces the same `Snapshot` shape and takes the same
 * `TargetAction`, whatever it is. This slice ships one backend (`managed`: a Chrome this extension starts). The
 * planned ones plug in here unchanged:
 *   - `user`: the person's own Chrome through the Marley Chrome extension (chrome.debugger speaks the same CDP
 *     commands as ManagedTab, so it can reuse page/scripts.ts as is);
 *   - `app`: a native macOS app through automation-extension's AxAdapter / HybridAdapter (src/native), whose
 *     snapshots already carry the same RawSnapshotAction rows.
 */

export type BackendKind = 'managed' | 'user' | 'app';
export type ManagedProfile = 'agent' | 'visitor' | 'offline';

/** One interactive element, as every backend reports it. `ref` is stable within one snapshot only. */
export interface SnapshotElement {
  readonly ref: string;
  readonly role: string;
  readonly label: string;
  readonly tag: string;
  readonly type: string;
  readonly kind: 'click' | 'fill' | 'select' | 'submit';
  readonly value?: string;
  readonly href?: string;
  /** For a control inside a form: the absolute address the form sends to (its button's `formaction` wins). */
  readonly formAction?: string;
  readonly checked?: string;
  readonly secret?: boolean;
  readonly offscreen?: boolean;
  readonly where?: string;
  readonly near?: string;
  /** Viewport coordinates [x, y, w, h]. */
  readonly box?: readonly [number, number, number, number];
  /** For `select`: the option values with their labels. */
  readonly options?: readonly { readonly value: string; readonly label: string }[];
  /** Backend-private address of the element (a DOM path for a page, an AX id for an app). */
  readonly node: string;
  /**
   * A TYPED signal from the backend that clicking (or submitting) this element is the owner's call, e.g. an app's
   * window control or the default button of a sheet. Never derived from label words.
   */
  readonly ownerSignal?: string;
}

export interface Snapshot {
  readonly url: string;
  readonly title: string;
  readonly text: string;
  readonly elements: readonly SnapshotElement[];
  readonly canScrollDown: boolean;
  readonly canScrollUp: boolean;
  readonly viewport: { readonly w: number; readonly h: number };
  readonly omitted: number;
  /**
   * True when every control inside a form carries its `formAction` (the managed snapshot). A backend that cannot see
   * form targets (the user backend's bridge) leaves it unset, and the engine then treats a submit as going anywhere.
   */
  readonly formActionsKnown?: boolean;
}

export type TargetAction =
  | { readonly kind: 'click'; readonly ref: string }
  | { readonly kind: 'type'; readonly ref: string; readonly text: string }
  | { readonly kind: 'select'; readonly ref: string; readonly value: string }
  | { readonly kind: 'submit'; readonly ref: string }
  | { readonly kind: 'scroll'; readonly direction: 'down' | 'up' }
  | { readonly kind: 'navigate'; readonly url: string }
  | { readonly kind: 'back' }
  | { readonly kind: 'wait'; readonly ms: number }
  // Session-only kinds: a caller driving step by step (browser.session.act) may use them; the task engine never offers
  // them. A backend that cannot do one answers `unsupported` (never a silent substitute).
  | { readonly kind: 'forward' }
  | { readonly kind: 'reload' }
  | { readonly kind: 'hover'; readonly ref: string }
  | { readonly kind: 'press'; readonly key: PressKey; readonly modifiers: readonly Modifier[] }
  | { readonly kind: 'upload'; readonly ref: string; readonly paths: readonly string[] };

/**
 * Named keys only. A printable character goes through `type` (which every backend checks against secret fields), so a
 * key press can never spell text into a password field or paste the clipboard (no Meta+V: V is not a named key).
 */
export const PRESS_KEYS = [
  'Enter',
  'Tab',
  'Escape',
  'Backspace',
  'Delete',
  'Space',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Home',
  'End',
  'PageUp',
  'PageDown',
] as const;
export type PressKey = (typeof PRESS_KEYS)[number];
/** Keys that change the text of a focused field: refused while a secret field has focus. */
export const EDITING_KEYS: ReadonlySet<PressKey> = new Set(['Backspace', 'Delete', 'Space']);
export const MODIFIERS = ['Alt', 'Control', 'Meta', 'Shift'] as const;
export type Modifier = (typeof MODIFIERS)[number];

/** A session-only kind or operation the backend has no way to do. */
export const unsupportedOn = (backend: BackendKind, what: string): ActOutcome => ({
  ok: false,
  unsupported: true,
  error: `unsupported_on_backend: ${what} is not available on the ${backend} backend`,
});

export interface ActOutcome {
  readonly ok: boolean;
  readonly error?: string;
  /** True when the action started a navigation the target waited for. */
  readonly navigated?: boolean;
  /** The action could only be done with real keyboard/mouse input (or by bringing the app to the front), which was not allowed. */
  readonly needsRealInput?: boolean;
  /** The action used real keyboard/mouse input or brought the app to the front (allowed by the caller). */
  readonly realInput?: boolean;
  /** The backend cannot do this kind of action (`unsupported_on_backend`). */
  readonly unsupported?: boolean;
  /** A JavaScript dialog (alert, confirm, prompt, beforeunload) opened during the action and waits for an answer. */
  readonly dialog?: PageDialog;
}

export interface PageDialog {
  readonly type: string;
  readonly message: string;
  readonly defaultPrompt?: string;
  readonly url?: string;
}

/** One observed console message or network request (no headers, bodies or cookies). */
export type LogEntry =
  | {
      readonly kind: 'console';
      readonly at: number;
      readonly level: string;
      readonly text: string;
      readonly url?: string;
    }
  | {
      readonly kind: 'network';
      readonly at: number;
      readonly method: string;
      readonly url: string;
      readonly resourceType?: string;
      readonly status?: number;
      readonly failed?: string;
    };
export type LogKind = 'console' | 'network';

export interface ScreenshotOptions {
  /** Draw each listed element's ref as a numbered box on the image (the "marked screenshot"). */
  readonly marks?: readonly SnapshotElement[];
  readonly format?: 'png' | 'jpeg';
  readonly fullPage?: boolean;
  /** Scale the visible viewport down to at most this many pixels wide (ignored with fullPage). */
  readonly width?: number;
  /** JPEG quality, 0-100 (default 70). */
  readonly quality?: number;
  /** A region of the page in CSS pixels, captured at scale 1 even beyond the viewport (managed only). */
  readonly clip?: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
}

/** Tallest page or clip a screenshot takes, in CSS pixels (real landing pages measured 16,942 and 20,771). */
export const CAPTURE_MAX_CSS = 30_000;

/** A device size for the page: CSS pixels, device pixel ratio, mobile layout and touch input. */
export interface Viewport {
  readonly width: number;
  readonly height: number;
  readonly deviceScaleFactor?: number;
  readonly mobile?: boolean;
  readonly touch?: boolean;
}
export const VIEWPORT_LIMITS = {
  minSide: 100,
  maxWidth: 5000,
  maxHeight: 10_000,
  maxScale: 4,
} as const;

/**
 * The image attached to every decision: a 768-wide JPEG at quality 70. Measured on real pages (marshal-sdk #174 bench):
 * p50 418 ms per step against 322 ms text-only and 660 ms for a 1280x800 PNG, and it caught a covering pop-up the
 * text missed. One constant, so the size is changed in one place.
 */
export const DECISION_SHOT = {
  format: 'jpeg',
  width: 768,
  quality: 70,
} as const satisfies ScreenshotOptions;

export interface Shot {
  readonly data: string;
  readonly mimeType: 'image/png' | 'image/jpeg';
}

export interface ScreencastOptions {
  readonly maxWidth: number;
  readonly everyNthFrame?: number;
}
export interface ScreencastFrameMeta {
  readonly ts: number;
  readonly width: number;
  readonly height: number;
}
export interface ScreencastHandle {
  stop(): Promise<void>;
}

export interface Target {
  readonly backend: BackendKind;
  readonly description: string;
  snapshot(): Promise<Snapshot>;
  act(action: TargetAction): Promise<ActOutcome>;
  screenshot(options?: ScreenshotOptions): Promise<Shot>;
  /** All visible text, capped by the backend. */
  fullText(): Promise<string>;
  close(): Promise<void>;
  screencast?(
    opts: ScreencastOptions,
    onFrame: (jpegBase64: string, meta: ScreencastFrameMeta) => void,
  ): Promise<ScreencastHandle>;
  // Step-by-step operations (browser.session.*). Absent on a backend that cannot do them: the caller gets
  // `unsupported_on_backend`.
  /** The page's HTML (document.documentElement.outerHTML), capped by the backend. */
  html?(): Promise<string>;
  /** Runs a JavaScript expression in the page and returns its JSON value (a promise is awaited). */
  evaluateExpression?(expression: string, timeoutMs: number): Promise<unknown>;
  /** Starts collecting console messages and/or network requests from now on (observe only, nothing intercepted). */
  observe?(kinds: readonly LogKind[]): Promise<void>;
  /** The collected entries of the given kinds, oldest first; `clear` empties the buffer after reading. */
  log?(
    kinds: readonly LogKind[],
    clear: boolean,
  ): { entries: LogEntry[]; dropped: number; observing: LogKind[] };
  /** The dialog waiting for an answer, if any. */
  pendingDialog?(): PageDialog | null;
  answerDialog?(accept: boolean, promptText?: string): Promise<void>;
  /** Sets the page's device size (CSS width/height, pixel ratio, mobile layout, touch). */
  setViewport?(viewport: Viewport): Promise<void>;
}
