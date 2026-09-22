/**
 * PerceptionAdapter: the single seam between the Jev executor loop
 * (executor.ts / decide.ts / action-space.ts, target-agnostic) and a concrete
 * target surface. Every adapter produces the SAME `PageSnapshot` shape so the
 * Jev questions, confidence gating, and checks behave identically for a
 * browser tab (DOM), a native macOS app (Accessibility tree), or a pixel-only
 * region (OCR).
 *
 * Contract:
 *  - `snapshot()` is cheap and budgeted (<= 6000 chars of visible text,
 *    <= 250 on-screen actions + <= 60 `offscreen` ones). `marker` must change
 *    iff something Jev could act on changed; the executor uses it for
 *    freshness and no-op detection.
 *  - `marker()` is an optional fast path (no element extraction) used for the
 *    pre-act freshness check; when absent the executor falls back to
 *    `snapshot().marker`.
 *  - `act()` never throws for a failed action; it returns `{ ok: false }` so
 *    the loop can record a no-op instead of aborting the subgoal.
 *  - `fullText()` is unbounded-ish (capped by the adapter, e.g. 400k chars)
 *    and feeds `observe { find }`; `screenshot()` returns PNG bytes for the
 *    planner (never sent to Jev).
 */
import type { PageSnapshot, RawSnapshotAction } from './types.js';

export type AdapterKind = 'dom' | 'ax' | 'ocr' | 'hybrid';

export interface ActResult {
  readonly ok: boolean;
  readonly error?: string;
}

export interface ScreenshotResult {
  /** Base64-encoded image bytes. */
  readonly data: string;
  readonly mimeType: string;
}

export interface ActOptions {
  /**
   * 'native' (default) uses the adapter's normal CDP/AX action path.
   * 'js' asks a DOM-backed adapter to perform the action entirely in-page
   * (scrollIntoView + focus + click) instead - a fallback for when a native
   * click lands during a re-render and gets swallowed. Adapters that have no
   * concept of a "js" strategy (AX/Hybrid/OCR) ignore this option.
   */
  readonly strategy?: 'native' | 'js';
}

export interface PerceptionAdapter {
  readonly kind: AdapterKind;
  /** Human-readable target description for run records, e.g. "tab chatId=…" or "app com.apple.finder". */
  readonly target: string;
  snapshot(): Promise<PageSnapshot>;
  marker?(): Promise<readonly unknown[]>;
  act(action: RawSnapshotAction, text?: string, options?: ActOptions): Promise<ActResult>;
  fullText(): Promise<string>;
  screenshot(): Promise<ScreenshotResult>;
  /** Release native handles / child processes. Idempotent. */
  dispose?(): Promise<void>;
}
