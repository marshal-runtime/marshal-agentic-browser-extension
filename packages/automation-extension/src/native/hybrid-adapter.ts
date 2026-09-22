/**
 * HybridAdapter: a PerceptionAdapter (adapter.ts) that wraps a real AX
 * PerceptionAdapter (Worker B's AxAdapter, src/native/ax-adapter.ts) and
 * merges its snapshot with OCR fallback (merge.ts) so Jev can act on
 * surfaces the AX tree can't see - canvas apps, terminals, custom-drawn
 * Electron widgets, cross-origin iframes, PDF viewers.
 *
 * AX-sourced actions are always routed through the wrapped adapter's own
 * `act()` (AXPress / AX set-value / scroll / wait) so merging in OCR never
 * loses those interactions; only OCR-only candidates click at a point.
 */
import type { ActResult, AdapterKind, PerceptionAdapter, ScreenshotResult } from '../adapter.js';
import type { PageSnapshot, RawSnapshotAction } from '../types.js';
import {
  boxOverlap,
  computeWhere,
  echoFilter,
  isOffscreen,
  readingOrder,
  textsMatch,
  type Box,
  type OcrLine as MergeOcrLine,
} from './merge.js';
import type { OcrClient } from './ocr-client.js';

/**
 * What HybridAdapter needs from the native AX side: a full PerceptionAdapter
 * (so unmatched actions get real AXPress/set-value/scroll/wait via `act()`),
 * plus the app's bundle id and a way to click a point and capture the window
 * for OCR. Implemented by Worker B's AxAdapter (src/native/ax-adapter.ts).
 */
export interface AxSource extends PerceptionAdapter {
  readonly bundleId: string;
  clickAt(x: number, y: number): Promise<void>;
  screenshotWindow(): Promise<{
    readonly path: string;
    readonly w: number;
    readonly h: number;
    readonly originX: number;
    readonly originY: number;
    readonly scale: number;
  }>;
}

export type OcrMode = 'auto' | 'always' | 'never';

export interface HybridAdapterOptions {
  readonly goal: string;
  readonly ocrMode?: OcrMode;
  /** Below this many labelled on-screen AX elements, 'auto' mode runs OCR. Default 8. */
  readonly minAxElementsForSkip?: number;
  /** App bundle ids known to have poor AX coverage (terminals, canvas-heavy apps), forcing OCR in 'auto' mode. */
  readonly lowCoverageBundleIds?: readonly string[];
  readonly cacheKey?: string;
  readonly ocrScale?: number;
  /** Vision recognition level passed to the helper: 'accurate' (default) or 'fast'. */
  readonly ocrLevel?: string;
  /** OCR-only candidates (source 'ocr') below this Vision confidence are dropped. Default 0.3. */
  readonly minOcrConfidence?: number;
  /** Overlap threshold (intersection / smaller box) for merging an AX action with an OCR line. Default 0.5. */
  readonly overlapThreshold?: number;
}

const DEFAULT_LOW_COVERAGE_BUNDLE_IDS: readonly string[] = [
  'com.apple.Terminal',
  'com.googlecode.iterm2',
  'com.spotify.client',
  'com.figma.Desktop',
  // Electron app that never exposes renderer web content via AX - only a
  // handful of window-chrome buttons, so the AX tree alone is useless here.
  'com.anthropic.claudefordesktop',
];

const CHROME_LABEL_BOX_MAX_PX = 20;

/**
 * True for menu bar/menu items and synthesized window-chrome buttons (AX
 * exposes these on every window regardless of what the app actually
 * renders), which should never count as "real" labelled content when
 * deciding whether OCR is needed - only actual content controls should.
 */
function isMenuOrChromeAction(action: RawSnapshotAction): boolean {
  if (action.role === 'AXMenuBarItem' || action.role === 'AXMenuItem') return true;
  const label = action.label.trim();
  if (action.box) {
    const [, , w, h] = action.box;
    if (label === 'button' && w <= CHROME_LABEL_BOX_MAX_PX && h <= CHROME_LABEL_BOX_MAX_PX)
      return true;
  }
  if (action.role === 'AXButton' && label.length === 0) return true;
  return false;
}

type BoxedAction = RawSnapshotAction & { readonly box: readonly [number, number, number, number] };

function hasBox(action: RawSnapshotAction): action is BoxedAction {
  return action.box !== undefined;
}

function boxFromTuple(box: readonly [number, number, number, number]): Box {
  const [x, y, w, h] = box;
  return { x, y, w, h };
}

function roundedTuple(box: Box): readonly [number, number, number, number] {
  return [Math.round(box.x), Math.round(box.y), Math.round(box.w), Math.round(box.h)];
}

const MARKER_BOX_QUANTIZE_PX = 4;

/** Snaps to a 4px grid so frame-to-frame Vision jitter on an otherwise-static image can't flip the marker. */
function quantize(value: number): number {
  return Math.round(value / MARKER_BOX_QUANTIZE_PX) * MARKER_BOX_QUANTIZE_PX;
}

function quantizedBoxTuple(box: Box): readonly [number, number, number, number] {
  return [quantize(box.x), quantize(box.y), quantize(box.w), quantize(box.h)];
}

/** Deterministic (y, x) order so the marker doesn't depend on OCR's line-return order. */
function sortedForMarker(lines: readonly MergeOcrLine[]): MergeOcrLine[] {
  return [...lines].sort((a, b) => {
    const dy = quantize(a.box.y) - quantize(b.box.y);
    if (dy !== 0) return dy;
    return quantize(a.box.x) - quantize(b.box.x);
  });
}

/**
 * Maps an OCR pixel-space box (relative to the captured window image) to
 * screen points, using the capture's real origin/scale (pixels per point).
 */
function pixelBoxToScreenPoints(
  box: { readonly x: number; readonly y: number; readonly w: number; readonly h: number },
  capture: { readonly originX: number; readonly originY: number; readonly scale: number },
): Box {
  const scale = capture.scale > 0 ? capture.scale : 1;
  return {
    x: capture.originX + box.x / scale,
    y: capture.originY + box.y / scale,
    w: box.w / scale,
    h: box.h / scale,
  };
}

/**
 * Merges AX actions (already boxed in screen points) with OCR lines: an AX
 * action absorbs an overlapping, text-matching OCR line (source becomes
 * 'ax+ocr', the longer text wins as the label, everything else about the AX
 * action - node id, kind, value, checked/selected/expanded - is preserved
 * unchanged so `act()` keeps using real AXPress/set-value). Unmatched OCR
 * lines at or above `minOcrConfidence` become click-at-center candidates.
 * Output is in reading order.
 */
function mergeAxActionsWithOcr(
  axActions: readonly BoxedAction[],
  ocrLines: readonly MergeOcrLine[],
  windowBox: Box,
  minOcrConfidence: number,
  overlapThreshold: number,
): RawSnapshotAction[] {
  const consumed = new Set<number>();
  const merged: { readonly action: RawSnapshotAction; readonly box: Box }[] = [];

  for (const action of axActions) {
    const box = boxFromTuple(action.box);
    let bestIndex = -1;
    let bestOverlap = 0;
    for (let i = 0; i < ocrLines.length; i += 1) {
      if (consumed.has(i)) continue;
      const line = ocrLines[i];
      if (!line) continue;
      const overlap = boxOverlap(box, line.box);
      if (
        overlap >= overlapThreshold &&
        textsMatch(action.label, line.text) &&
        overlap > bestOverlap
      ) {
        bestOverlap = overlap;
        bestIndex = i;
      }
    }
    if (bestIndex >= 0) {
      const line = ocrLines[bestIndex];
      if (line) {
        consumed.add(bestIndex);
        const label = line.text.length > action.label.length ? line.text : action.label;
        merged.push({ action: { ...action, label, source: 'ax+ocr' }, box });
        continue;
      }
    }
    merged.push({ action, box });
  }

  const leftovers: { readonly action: RawSnapshotAction; readonly box: Box }[] = [];
  for (let i = 0; i < ocrLines.length; i += 1) {
    if (consumed.has(i)) continue;
    const line = ocrLines[i];
    if (!line || line.confidence < minOcrConfidence) continue;
    leftovers.push({
      action: {
        node: `ocr:${String(i)}`,
        role: 'text',
        label: line.text,
        kind: 'click',
        where: computeWhere(line.box, windowBox),
        box: roundedTuple(line.box),
        offscreen: isOffscreen(line.box, windowBox),
        source: 'ocr',
      },
      box: line.box,
    });
  }

  return readingOrder([...merged, ...leftovers]).map((c) => c.action);
}

export class HybridAdapter implements PerceptionAdapter {
  readonly kind: AdapterKind = 'hybrid';
  readonly target: string;

  private readonly ax: AxSource;
  private readonly ocr: OcrClient;
  private readonly goal: string;
  private readonly ocrMode: OcrMode;
  private readonly minAxElementsForSkip: number;
  private readonly lowCoverageBundleIds: readonly string[];
  private readonly cacheKey: string;
  private readonly ocrScale: number;
  private readonly ocrLevel: string;
  private readonly minOcrConfidence: number;
  private readonly overlapThreshold: number;

  constructor(ax: AxSource, ocr: OcrClient, target: string, options: HybridAdapterOptions) {
    this.ax = ax;
    this.ocr = ocr;
    this.target = target;
    this.goal = options.goal;
    this.ocrMode = options.ocrMode ?? 'auto';
    this.minAxElementsForSkip = options.minAxElementsForSkip ?? 8;
    this.lowCoverageBundleIds = options.lowCoverageBundleIds ?? DEFAULT_LOW_COVERAGE_BUNDLE_IDS;
    this.cacheKey = options.cacheKey ?? target;
    this.ocrScale = options.ocrScale ?? 1;
    this.ocrLevel = options.ocrLevel ?? 'accurate';
    this.minOcrConfidence = options.minOcrConfidence ?? 0.3;
    this.overlapThreshold = options.overlapThreshold ?? 0.5;
  }

  private shouldRunOcr(axSnapshot: PageSnapshot): boolean {
    if (this.ocrMode === 'never') return false;
    if (this.ocrMode === 'always') return true;
    if (this.lowCoverageBundleIds.includes(this.ax.bundleId)) return true;
    const labelledNodes = new Set<string>();
    for (const action of axSnapshot.actions) {
      if (
        action.source === 'ax' &&
        action.node &&
        !action.offscreen &&
        action.label.trim().length > 0 &&
        !isMenuOrChromeAction(action)
      ) {
        labelledNodes.add(action.node);
      }
    }
    return labelledNodes.size < this.minAxElementsForSkip;
  }

  async snapshot(): Promise<PageSnapshot> {
    const axSnapshot = await this.ax.snapshot();
    if (!this.shouldRunOcr(axSnapshot)) return axSnapshot;

    const capture = await this.ax.screenshotWindow();
    const ocrResult = await this.ocr.ocr(capture.path, {
      cacheKey: this.cacheKey,
      scale: this.ocrScale,
      level: this.ocrLevel,
    });
    const scaledLines: MergeOcrLine[] = ocrResult.lines.map((line) => ({
      text: line.text,
      confidence: line.confidence,
      box: pixelBoxToScreenPoints(line, {
        originX: capture.originX,
        originY: capture.originY,
        scale: capture.scale,
      }),
    }));
    // Lines shorter than 2 chars are noise either way; drop before merging.
    // Confidence is checked only when building leftovers below - an AX
    // action absorbing a low-confidence-but-matching line is still trusted
    // because the AX side already corroborates it.
    const filteredLines = echoFilter(scaledLines, this.goal).filter(
      (line) => line.text.trim().length >= 2,
    );

    const windowBox: Box = {
      x: capture.originX,
      y: capture.originY,
      w: axSnapshot.w,
      h: axSnapshot.h,
    };
    const candidates = axSnapshot.actions.filter(hasBox);
    const controls = axSnapshot.actions.filter((a) => !hasBox(a));

    const interactive = mergeAxActionsWithOcr(
      candidates,
      filteredLines,
      windowBox,
      this.minOcrConfidence,
      this.overlapThreshold,
    );
    const actions = [...interactive, ...controls];

    const ocrOnlyText = filteredLines
      .map((line) => line.text)
      .filter((lineText) => !axSnapshot.text.includes(lineText))
      .join('\n');
    const text = ocrOnlyText ? `${axSnapshot.text}\n${ocrOnlyText}` : axSnapshot.text;

    const marker: unknown[] = [
      ...axSnapshot.marker,
      ...sortedForMarker(filteredLines).map((line) => [line.text, quantizedBoxTuple(line.box)]),
    ];

    return {
      ...axSnapshot,
      text: text.slice(0, 6000),
      actions,
      marker,
    };
  }

  /**
   * Must return exactly what `snapshot().marker` would - the executor's
   * freshness check compares this against the marker captured before acting,
   * and a mismatch (e.g. an AX-only marker that ignores OCR-only content)
   * makes every iteration look "changed", looping forever. Simplest correct
   * implementation: run the same pipeline as `snapshot()`. The Swift OCR
   * helper's tile-diff cache keeps a repeated call on an unchanged frame
   * cheap (~20ms), so no extra memoization is needed here.
   */
  async marker(): Promise<readonly unknown[]> {
    const snapshot = await this.snapshot();
    return snapshot.marker;
  }

  async act(action: RawSnapshotAction, text?: string): Promise<ActResult> {
    try {
      if (action.source === 'ocr') {
        if (!action.box) return { ok: false, error: 'ocr action has no box to act on' };
        const [x, y, w, h] = action.box;
        await this.ax.clickAt(x + w / 2, y + h / 2);
        return { ok: true };
      }
      return await this.ax.act(action, text);
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async fullText(): Promise<string> {
    return this.ax.fullText();
  }

  async screenshot(): Promise<ScreenshotResult> {
    return this.ax.screenshot();
  }

  async dispose(): Promise<void> {
    await this.ocr.dispose();
    await this.ax.dispose?.();
  }
}
