import { describe, expect, it } from 'vitest';
import {
  boxOverlap,
  echoFilter,
  mergeAxAndOcr,
  readingOrder,
  textsMatch,
} from '../../src/native/merge.js';
import type { AxElement, Box, OcrLine } from '../../src/native/merge.js';

const windowBox: Box = { x: 0, y: 0, w: 1000, h: 800 };

function ax(overrides: Partial<AxElement> & { id: string; label: string; box: Box }): AxElement {
  return {
    role: 'button',
    value: undefined,
    where: 'center',
    offscreen: false,
    enabled: true,
    editable: false,
    ...overrides,
  };
}

function ocr(text: string, box: Box, confidence = 0.9): OcrLine {
  return { text, box, confidence };
}

describe('boxOverlap', () => {
  it('is 1.0 when the smaller box is fully inside the larger one', () => {
    const big: Box = { x: 0, y: 0, w: 100, h: 100 };
    const small: Box = { x: 10, y: 10, w: 20, h: 20 };
    expect(boxOverlap(big, small)).toBeCloseTo(1.0, 5);
  });

  it('is 0 for disjoint boxes', () => {
    const a: Box = { x: 0, y: 0, w: 10, h: 10 };
    const b: Box = { x: 100, y: 100, w: 10, h: 10 };
    expect(boxOverlap(a, b)).toBe(0);
  });

  it('computes intersection-over-smaller for partial overlap', () => {
    const a: Box = { x: 0, y: 0, w: 10, h: 10 }; // area 100
    const b: Box = { x: 5, y: 0, w: 10, h: 10 }; // area 100, intersection 5x10=50
    expect(boxOverlap(a, b)).toBeCloseTo(0.5, 5);
  });
});

describe('textsMatch', () => {
  it('matches when one text contains the other', () => {
    expect(textsMatch('Search', 'Search flights')).toBe(true);
    expect(textsMatch('Search flights', 'Search')).toBe(true);
  });

  it('matches when at least half the (smaller) word set is shared', () => {
    expect(textsMatch('Submit order now', 'submit now')).toBe(true);
  });

  it('does not match unrelated text', () => {
    expect(textsMatch('Submit order', 'Cancel request')).toBe(false);
  });

  it('does not match empty strings', () => {
    expect(textsMatch('', 'Submit')).toBe(false);
  });
});

describe('mergeAxAndOcr', () => {
  it('merges an AX control with an overlapping, text-matching OCR line into one ax+ocr candidate', () => {
    const axElements: AxElement[] = [
      ax({ id: 'a1', label: 'Search', box: { x: 10, y: 10, w: 60, h: 20 } }),
    ];
    const ocrLines: OcrLine[] = [ocr('Search flights', { x: 12, y: 11, w: 90, h: 18 })];

    const result = mergeAxAndOcr(axElements, ocrLines, { windowBox });

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ node: 'a1', label: 'Search flights', source: 'ax+ocr' });
  });

  it('keeps AX and OCR separate when boxes overlap but texts do not match', () => {
    const axElements: AxElement[] = [
      ax({ id: 'a1', label: 'Search', box: { x: 10, y: 10, w: 60, h: 20 } }),
    ];
    const ocrLines: OcrLine[] = [ocr('Unrelated caption', { x: 12, y: 11, w: 90, h: 18 })];

    const result = mergeAxAndOcr(axElements, ocrLines, { windowBox });

    expect(result).toHaveLength(2);
    expect(result.map((r) => r.source).sort()).toEqual(['ax', 'ocr']);
  });

  it('keeps AX and OCR separate when texts match but boxes barely overlap', () => {
    const axElements: AxElement[] = [
      ax({ id: 'a1', label: 'Search', box: { x: 0, y: 0, w: 100, h: 20 } }),
    ];
    // Overlap area = 5x20=100 over smaller box area (20x20=400) => 0.25, below the 0.5 threshold.
    const ocrLines: OcrLine[] = [ocr('Search', { x: 95, y: 0, w: 20, h: 20 })];

    const result = mergeAxAndOcr(axElements, ocrLines, { windowBox });

    expect(result).toHaveLength(2);
  });

  it('turns leftover OCR lines into click-at-center candidates with a box and source ocr', () => {
    const ocrLines: OcrLine[] = [ocr('Canvas label', { x: 200, y: 200, w: 80, h: 14 })];

    const result = mergeAxAndOcr([], ocrLines, { windowBox });

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ label: 'Canvas label', kind: 'click', source: 'ocr' });
    expect(result[0]?.box).toEqual([200, 200, 80, 14]);
  });

  it('picks the longer text as the merged label regardless of which side supplied it', () => {
    const axElements: AxElement[] = [
      ax({ id: 'a1', label: 'Go', box: { x: 0, y: 0, w: 40, h: 20 } }),
    ];
    const ocrLines: OcrLine[] = [ocr('Go to checkout now', { x: 0, y: 0, w: 40, h: 20 })];

    const result = mergeAxAndOcr(axElements, ocrLines, { windowBox });

    expect(result[0]?.label).toBe('Go to checkout now');
    expect(result[0]?.role).toBe('button');
  });

  it('respects a custom overlapThreshold', () => {
    const axElements: AxElement[] = [
      ax({ id: 'a1', label: 'Search', box: { x: 0, y: 0, w: 100, h: 20 } }),
    ];
    const ocrLines: OcrLine[] = [ocr('Search', { x: 95, y: 0, w: 20, h: 20 })]; // overlap ~0.25

    const merged = mergeAxAndOcr(axElements, ocrLines, { windowBox, overlapThreshold: 0.2 });
    expect(merged).toHaveLength(1);
    expect(merged[0]?.source).toBe('ax+ocr');
  });
});

describe('echoFilter', () => {
  it('drops OCR lines echoing the goal head or tail', () => {
    const goal = 'Click the blue submit button at the bottom of the checkout form';
    const lines: OcrLine[] = [
      ocr('Click the blue submit button', { x: 0, y: 0, w: 10, h: 10 }),
      ocr('at the bottom of the checkout form', { x: 0, y: 20, w: 10, h: 10 }),
      ocr('Order confirmed', { x: 0, y: 40, w: 10, h: 10 }),
    ];

    const filtered = echoFilter(lines, goal);

    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.text).toBe('Order confirmed');
  });

  it('keeps everything when the goal is empty', () => {
    const lines: OcrLine[] = [ocr('Anything', { x: 0, y: 0, w: 10, h: 10 })];
    expect(echoFilter(lines, '')).toHaveLength(1);
  });
});

describe('readingOrder', () => {
  it('orders items into rows by median height, then left-to-right', () => {
    const items = [
      { box: { x: 100, y: 5, w: 10, h: 20 } }, // row 0, right
      { box: { x: 10, y: 5, w: 10, h: 20 } }, // row 0, left
      { box: { x: 50, y: 100, w: 10, h: 20 } }, // row 1
    ];

    const ordered = readingOrder(items);

    expect(ordered.map((i) => i.box.x)).toEqual([10, 100, 50]);
  });
});
