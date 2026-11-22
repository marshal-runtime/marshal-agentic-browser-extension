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
}

export type TargetAction =
  | { readonly kind: 'click'; readonly ref: string }
  | { readonly kind: 'type'; readonly ref: string; readonly text: string }
  | { readonly kind: 'select'; readonly ref: string; readonly value: string }
  | { readonly kind: 'submit'; readonly ref: string }
  | { readonly kind: 'scroll'; readonly direction: 'down' | 'up' }
  | { readonly kind: 'navigate'; readonly url: string }
  | { readonly kind: 'back' }
  | { readonly kind: 'wait'; readonly ms: number };

export interface ActOutcome {
  readonly ok: boolean;
  readonly error?: string;
  /** True when the action started a navigation the target waited for. */
  readonly navigated?: boolean;
}

export interface ScreenshotOptions {
  /** Draw each listed element's ref as a numbered box on the image (the "marked screenshot"). */
  readonly marks?: readonly SnapshotElement[];
  readonly format?: 'png' | 'jpeg';
  readonly fullPage?: boolean;
}

export interface Shot {
  readonly data: string;
  readonly mimeType: 'image/png' | 'image/jpeg';
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
}
