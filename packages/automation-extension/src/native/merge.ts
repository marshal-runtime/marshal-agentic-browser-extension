/**
 * Pure functions for merging an Accessibility-tree snapshot with OCR text
 * blocks, ported conceptually from typesafe-computer-use's `perception.py`
 * (https://github.com/awlevin/typesafe-computer-use): an AX control replaces
 * an overlapping OCR block that says roughly the same thing; leftover OCR
 * blocks become click-at-center candidates; everything is renumbered in
 * reading order.
 */
import type { RawSnapshotAction } from '../types.js';

export interface Box {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export interface AxElement {
  readonly id: string;
  readonly role?: string;
  readonly label: string;
  readonly value?: string;
  readonly box: Box;
  readonly where: string;
  readonly offscreen: boolean;
  readonly enabled: boolean;
  readonly editable: boolean;
}

export interface OcrLine {
  readonly text: string;
  readonly box: Box;
  readonly confidence: number;
}

export interface MergeOptions {
  /** Window frame in screen points, used to compute the coarse `where` region for OCR-only blocks. */
  readonly windowBox: Box;
  /** Overlap threshold (intersection / area of the SMALLER box) above which an AX/OCR pair merge. Default 0.5. */
  readonly overlapThreshold?: number;
}

/** Intersection-over-smaller-box overlap ratio, in [0, 1]. */
export function boxOverlap(a: Box, b: Box): number {
  const ix0 = Math.max(a.x, b.x);
  const iy0 = Math.max(a.y, b.y);
  const ix1 = Math.min(a.x + a.w, b.x + b.w);
  const iy1 = Math.min(a.y + a.h, b.y + b.h);
  const iw = Math.max(0, ix1 - ix0);
  const ih = Math.max(0, iy1 - iy0);
  const intersection = iw * ih;
  if (intersection <= 0) return 0;
  const smaller = Math.min(a.w * a.h, b.w * b.h);
  return smaller > 0 ? intersection / smaller : 0;
}

function normalizeWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

/** True when one text contains the other, or they share at least half their (normalized) words. */
export function textsMatch(a: string, b: string): boolean {
  const na = a.trim().toLowerCase();
  const nb = b.trim().toLowerCase();
  if (!na || !nb) return false;
  if (na.includes(nb) || nb.includes(na)) return true;

  const wordsA = new Set(normalizeWords(a));
  const wordsB = new Set(normalizeWords(b));
  if (wordsA.size === 0 || wordsB.size === 0) return false;
  let shared = 0;
  for (const word of wordsA) if (wordsB.has(word)) shared += 1;
  const smaller = Math.min(wordsA.size, wordsB.size);
  return smaller > 0 && shared / smaller >= 0.5;
}

/** Coarse 3x3 region label (or "above"/"below" when outside the window vertically), matching RawSnapshotAction.where. */
export function computeWhere(box: Box, windowBox: Box): string {
  if (box.y + box.h < windowBox.y) return 'above';
  if (box.y > windowBox.y + windowBox.h) return 'below';
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  const relX = windowBox.w > 0 ? (cx - windowBox.x) / windowBox.w : 0.5;
  const relY = windowBox.h > 0 ? (cy - windowBox.y) / windowBox.h : 0.5;
  const col = relX < 1 / 3 ? 'left' : relX < 2 / 3 ? '' : 'right';
  const row = relY < 1 / 3 ? 'top' : relY < 2 / 3 ? '' : 'bottom';
  if (!row && !col) return 'center';
  return [row, col].filter(Boolean).join('-');
}

const OFFSCREEN_MARGIN = 4;

export function isOffscreen(box: Box, windowBox: Box): boolean {
  return (
    box.x + box.w < windowBox.x - OFFSCREEN_MARGIN ||
    box.y + box.h < windowBox.y - OFFSCREEN_MARGIN ||
    box.x > windowBox.x + windowBox.w + OFFSCREEN_MARGIN ||
    box.y > windowBox.y + windowBox.h + OFFSCREEN_MARGIN
  );
}

interface MergedCandidate {
  readonly action: RawSnapshotAction;
  readonly box: Box;
}

/**
 * Merges AX elements with OCR lines: an AX element absorbs an OCR line when
 * their boxes overlap >= `overlapThreshold` (intersection over the smaller
 * box) and their texts match; the longer text becomes the label and the AX
 * role/id/editability are kept. Unmatched OCR lines become click-at-center
 * candidates (source 'ocr'); unmatched AX elements pass through unchanged
 * (source 'ax'). Output is in reading order (see `readingOrder`).
 */
export function mergeAxAndOcr(
  axElements: readonly AxElement[],
  ocrLines: readonly OcrLine[],
  options: MergeOptions,
): RawSnapshotAction[] {
  const threshold = options.overlapThreshold ?? 0.5;
  const consumedOcr = new Set<number>();
  const candidates: MergedCandidate[] = [];

  for (const ax of axElements) {
    let bestIndex = -1;
    let bestOverlap = 0;
    for (let i = 0; i < ocrLines.length; i += 1) {
      if (consumedOcr.has(i)) continue;
      const line = ocrLines[i];
      if (!line) continue;
      const overlap = boxOverlap(ax.box, line.box);
      if (overlap >= threshold && textsMatch(ax.label, line.text) && overlap > bestOverlap) {
        bestOverlap = overlap;
        bestIndex = i;
      }
    }
    let label = ax.label;
    let source: RawSnapshotAction['source'] = 'ax';
    if (bestIndex >= 0) {
      const line = ocrLines[bestIndex];
      if (line) {
        consumedOcr.add(bestIndex);
        source = 'ax+ocr';
        label = line.text.length > label.length ? line.text : label;
      }
    }
    candidates.push({
      box: ax.box,
      action: {
        node: ax.id,
        role: ax.role,
        label,
        kind: ax.editable ? 'fill' : 'click',
        value: ax.value,
        where: computeWhere(ax.box, options.windowBox),
        box: [
          Math.round(ax.box.x),
          Math.round(ax.box.y),
          Math.round(ax.box.w),
          Math.round(ax.box.h),
        ],
        offscreen: ax.offscreen || isOffscreen(ax.box, options.windowBox),
        source,
      },
    });
  }

  for (let i = 0; i < ocrLines.length; i += 1) {
    if (consumedOcr.has(i)) continue;
    const line = ocrLines[i];
    if (!line) continue;
    candidates.push({
      box: line.box,
      action: {
        node: `ocr:${String(i)}`,
        role: 'text',
        label: line.text,
        kind: 'click',
        where: computeWhere(line.box, options.windowBox),
        box: [
          Math.round(line.box.x),
          Math.round(line.box.y),
          Math.round(line.box.w),
          Math.round(line.box.h),
        ],
        offscreen: isOffscreen(line.box, options.windowBox),
        source: 'ocr',
      },
    });
  }

  return readingOrder(candidates).map((c) => c.action);
}

/**
 * Drops OCR lines that merely echo the goal text: lines whose normalized
 * text contains the goal's first-24 or last-24 characters (trimmed, lower-
 * cased), which typically indicates a title bar, prompt, or status line
 * repeating what the caller asked for rather than a real UI element.
 */
export function echoFilter(lines: readonly OcrLine[], goal: string): OcrLine[] {
  const g = goal.trim().toLowerCase();
  if (!g) return [...lines];
  const head = g.slice(0, 24);
  const tail = g.slice(-24);
  return lines.filter((line) => {
    const text = line.text.trim().toLowerCase();
    if (!text) return false;
    if (head.length >= 8 && text.includes(head)) return false;
    if (tail.length >= 8 && text.includes(tail)) return false;
    return true;
  });
}

/** Median of a numeric array; 0 for an empty array. */
function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2
    : (sorted[mid] ?? 0);
}

/**
 * Orders boxed items into rows using the median box height as the row
 * bucket size, then left-to-right within each row, top-to-bottom across rows.
 */
export function readingOrder<T extends { readonly box: Box }>(items: readonly T[]): T[] {
  if (items.length === 0) return [];
  const rowHeight = Math.max(1, median(items.map((item) => item.box.h)));
  const withRow = items.map((item) => ({ item, row: Math.round(item.box.y / rowHeight) }));
  withRow.sort((a, b) => (a.row !== b.row ? a.row - b.row : a.item.box.x - b.item.box.x));
  return withRow.map((entry) => entry.item);
}
