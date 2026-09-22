import { describe, expect, it, vi } from 'vitest';
import { HybridAdapter, type AxSource } from '../../src/native/hybrid-adapter.js';
import type { OcrClient, OcrResult } from '../../src/native/ocr-client.js';
import type { PageSnapshot, RawSnapshotAction } from '../../src/types.js';

function axAction(
  overrides: Partial<RawSnapshotAction> & { node: string; label: string },
): RawSnapshotAction {
  return {
    role: 'button',
    kind: 'click',
    where: 'top-left',
    offscreen: false,
    box: [0, 0, 8, 8],
    source: 'ax',
    ...overrides,
  };
}

function pageSnapshot(overrides: Partial<PageSnapshot> = {}): PageSnapshot {
  return {
    url: 'app://com.example.app/Window',
    title: 'Window',
    w: 1000,
    h: 800,
    text: '',
    scroll: { y: 0, height: 800 },
    actions: [],
    marker: ['ax-marker'],
    omittedActions: 0,
    focused: null,
    ...overrides,
  };
}

const richSnapshot = pageSnapshot({
  text: 'rich app text',
  actions: Array.from({ length: 10 }, (_, i) =>
    axAction({ node: `el${i}`, label: `Button ${i}`, box: [i * 10, 0, 8, 8] }),
  ),
});

const sparseSnapshot = pageSnapshot({
  text: '',
  actions: [
    axAction({ node: 'e1', role: 'group', label: '', box: [0, 0, 1000, 800] }),
    { node: null, kind: 'scroll', label: 'Scroll down', delta: 560, id: 'scroll_down' },
    { node: null, kind: 'wait', label: 'Wait for the app to update', id: 'wait' },
  ],
});

interface FakeAxOptions {
  readonly bundleId?: string;
  readonly clickAt?: ReturnType<typeof vi.fn>;
  readonly act?: ReturnType<typeof vi.fn>;
  readonly scale?: number;
  readonly originX?: number;
  readonly originY?: number;
}

function fakeAx(snapshot: PageSnapshot, options: FakeAxOptions = {}): AxSource {
  return {
    kind: 'ax',
    target: 'app:test',
    snapshot: vi.fn(async () => snapshot),
    act: options.act ?? vi.fn(async () => ({ ok: true })),
    fullText: vi.fn(async () => snapshot.text),
    screenshot: vi.fn(async () => ({ data: 'ZmFrZQ==', mimeType: 'image/png' })),
    bundleId: options.bundleId ?? 'com.example.app',
    clickAt: options.clickAt ?? vi.fn(async () => {}),
    screenshotWindow: vi.fn(async () => ({
      path: '/tmp/win.png',
      w: snapshot.w,
      h: snapshot.h,
      originX: options.originX ?? 0,
      originY: options.originY ?? 0,
      scale: options.scale ?? 1,
    })),
    dispose: vi.fn(async () => {}),
  };
}

function fakeOcr(result: OcrResult): OcrClient {
  return {
    ocr: vi.fn(async () => result),
    capture: vi.fn(),
    dispose: vi.fn(async () => {}),
  } as unknown as OcrClient;
}

describe('HybridAdapter auto mode', () => {
  it('skips OCR when the AX snapshot already has enough labelled on-screen actions, returning the AX snapshot untouched', async () => {
    const ocr = fakeOcr({ lines: [], reused: 0, read: 0, tiles: { changed: 0, total: 0 }, ms: 1 });
    const adapter = new HybridAdapter(fakeAx(richSnapshot), ocr, 'app:rich', { goal: 'test' });

    const snapshot = await adapter.snapshot();

    expect(ocr.ocr).not.toHaveBeenCalled();
    expect(snapshot).toBe(richSnapshot);
    expect(snapshot.actions.every((a) => a.source === 'ax')).toBe(true);
  });

  it('runs OCR when the AX snapshot has too few labelled on-screen actions', async () => {
    const ocr = fakeOcr({
      lines: [{ text: 'Canvas button', x: 100, y: 100, w: 80, h: 16, confidence: 0.9 }],
      reused: 0,
      read: 1,
      tiles: { changed: 1, total: 1 },
      ms: 5,
    });
    const adapter = new HybridAdapter(fakeAx(sparseSnapshot), ocr, 'app:canvas', { goal: 'test' });

    const snapshot = await adapter.snapshot();

    expect(ocr.ocr).toHaveBeenCalledOnce();
    const ocrCandidates = snapshot.actions.filter((a) => a.source === 'ocr');
    expect(ocrCandidates).toHaveLength(1);
    expect(ocrCandidates[0]?.label).toBe('Canvas button');
    // scroll/wait controls survive, appended after the interactive candidates.
    expect(snapshot.actions.some((a) => a.kind === 'scroll')).toBe(true);
    expect(snapshot.actions.some((a) => a.kind === 'wait')).toBe(true);
  });

  it('runs OCR for a known low-coverage bundle id even with several AX actions', async () => {
    const ocr = fakeOcr({ lines: [], reused: 0, read: 0, tiles: { changed: 0, total: 0 }, ms: 1 });
    const adapter = new HybridAdapter(
      fakeAx(richSnapshot, { bundleId: 'com.apple.Terminal' }),
      ocr,
      'app:terminal',
      {
        goal: 'test',
      },
    );

    await adapter.snapshot();

    expect(ocr.ocr).toHaveBeenCalledOnce();
  });

  it('runs OCR when the only labelled actions are menu-bar items and synthesized window-chrome buttons (Electron apps like Claude Desktop)', async () => {
    const menuBarAndChromeSnapshot = pageSnapshot({
      text: '',
      actions: [
        ...Array.from({ length: 8 }, (_, i) =>
          axAction({
            node: `menu${i}`,
            role: 'AXMenuBarItem',
            label: `Menu ${i}`,
            box: [i * 40, 0, 36, 20],
          }),
        ),
        ...Array.from({ length: 3 }, (_, i) =>
          axAction({
            node: `chrome${i}`,
            role: 'AXButton',
            label: 'button',
            box: [900 + i * 20, 0, 16, 16],
          }),
        ),
      ],
    });
    const ocr = fakeOcr({ lines: [], reused: 0, read: 0, tiles: { changed: 0, total: 0 }, ms: 1 });
    const adapter = new HybridAdapter(fakeAx(menuBarAndChromeSnapshot), ocr, 'app:claude', {
      goal: 'test',
    });

    const snapshot = await adapter.snapshot();

    expect(ocr.ocr).toHaveBeenCalledOnce();
    // Menu-bar/chrome AX actions are still valid click targets, so they survive in the merged output.
    expect(snapshot.actions.filter((a) => a.role === 'AXMenuBarItem')).toHaveLength(8);
    expect(
      snapshot.actions.filter((a) => a.role === 'AXButton' && a.label === 'button'),
    ).toHaveLength(3);
  });

  it('skips OCR when there are 8 real labelled content buttons, ignoring any menu-bar/chrome noise', async () => {
    const realButtonsSnapshot = pageSnapshot({
      text: '',
      actions: [
        ...Array.from({ length: 8 }, (_, i) =>
          axAction({
            node: `btn${i}`,
            role: 'AXButton',
            label: `Save document ${i}`,
            box: [i * 90, 40, 80, 24],
          }),
        ),
        // Menu-bar noise present alongside the real content; must not count toward the skip threshold either way.
        axAction({ node: 'menu0', role: 'AXMenuBarItem', label: 'File', box: [0, 0, 36, 20] }),
      ],
    });
    const ocr = fakeOcr({ lines: [], reused: 0, read: 0, tiles: { changed: 0, total: 0 }, ms: 1 });
    const adapter = new HybridAdapter(fakeAx(realButtonsSnapshot), ocr, 'app:content', {
      goal: 'test',
    });

    await adapter.snapshot();

    expect(ocr.ocr).not.toHaveBeenCalled();
  });

  it('runs OCR for the Claude Desktop bundle id via DEFAULT_LOW_COVERAGE_BUNDLE_IDS, even with plenty of chrome-only AX actions', async () => {
    const ocr = fakeOcr({ lines: [], reused: 0, read: 0, tiles: { changed: 0, total: 0 }, ms: 1 });
    const adapter = new HybridAdapter(
      fakeAx(richSnapshot, { bundleId: 'com.anthropic.claudefordesktop' }),
      ocr,
      'app:claude',
      { goal: 'test' },
    );

    await adapter.snapshot();

    expect(ocr.ocr).toHaveBeenCalledOnce();
  });

  it('never runs OCR when ocrMode is "never", even for a sparse snapshot', async () => {
    const ocr = fakeOcr({ lines: [], reused: 0, read: 0, tiles: { changed: 0, total: 0 }, ms: 1 });
    const adapter = new HybridAdapter(fakeAx(sparseSnapshot), ocr, 'app:canvas', {
      goal: 'test',
      ocrMode: 'never',
    });

    await adapter.snapshot();

    expect(ocr.ocr).not.toHaveBeenCalled();
  });

  it('always runs OCR when ocrMode is "always", even for a rich snapshot', async () => {
    const ocr = fakeOcr({ lines: [], reused: 0, read: 0, tiles: { changed: 0, total: 0 }, ms: 1 });
    const adapter = new HybridAdapter(fakeAx(richSnapshot), ocr, 'app:rich', {
      goal: 'test',
      ocrMode: 'always',
    });

    await adapter.snapshot();

    expect(ocr.ocr).toHaveBeenCalledOnce();
  });
});

describe('HybridAdapter AX+OCR merge', () => {
  it('merges an overlapping, text-matching OCR line into the AX action, keeping the node id and non-label fields, taking the longer label', async () => {
    const withState = pageSnapshot({
      actions: [
        axAction({
          node: 'chk1',
          label: 'Enable sync',
          box: [10, 10, 60, 20],
          checked: 'true',
          kind: 'click',
        }),
      ],
    });
    const ocr = fakeOcr({
      lines: [{ text: 'Enable sync automatically', x: 12, y: 11, w: 90, h: 18, confidence: 0.9 }],
      reused: 0,
      read: 1,
      tiles: { changed: 1, total: 1 },
      ms: 5,
    });
    const adapter = new HybridAdapter(fakeAx(withState), ocr, 'app:x', { goal: 'test' });

    const snapshot = await adapter.snapshot();

    expect(snapshot.actions).toHaveLength(1);
    expect(snapshot.actions[0]).toMatchObject({
      node: 'chk1',
      label: 'Enable sync automatically',
      source: 'ax+ocr',
      checked: 'true',
    });
  });

  it('keeps a low-confidence OCR line that matches an AX action (merge is exempt from the confidence gate)', async () => {
    const withState = pageSnapshot({
      actions: [axAction({ node: 'b1', label: 'Submit', box: [0, 0, 40, 20] })],
    });
    const ocr = fakeOcr({
      lines: [{ text: 'Submit', x: 0, y: 0, w: 40, h: 20, confidence: 0.05 }],
      reused: 0,
      read: 1,
      tiles: { changed: 1, total: 1 },
      ms: 5,
    });
    const adapter = new HybridAdapter(fakeAx(withState), ocr, 'app:x', {
      goal: 'test',
      minOcrConfidence: 0.3,
    });

    const snapshot = await adapter.snapshot();

    expect(snapshot.actions).toHaveLength(1);
    expect(snapshot.actions[0]).toMatchObject({ node: 'b1', source: 'ax+ocr' });
  });
});

describe('HybridAdapter pixel -> screen point mapping and act()', () => {
  it('maps an OCR pixel box to screen points using the capture origin/scale, and clicks its center', async () => {
    const clickAt = vi.fn(async () => {});
    // scale 2 = Retina capture: pixel coords must be halved and offset by the window origin.
    const ax = fakeAx(sparseSnapshot, { clickAt, scale: 2, originX: 50, originY: 20 });
    const ocr = fakeOcr({
      lines: [{ text: 'Wide canvas item', x: 200, y: 400, w: 100, h: 20, confidence: 0.8 }],
      reused: 0,
      read: 1,
      tiles: { changed: 1, total: 1 },
      ms: 5,
    });
    const adapter = new HybridAdapter(ax, ocr, 'app:canvas', { goal: 'test' });

    const snapshot = await adapter.snapshot();
    const candidate = snapshot.actions.find((a) => a.source === 'ocr');
    expect(candidate).toBeDefined();
    // pixel x=200 w=100 at scale 2, origin 50 -> screen x = 50 + 200/2 = 150, w = 50
    expect(candidate?.box).toEqual([150, 220, 50, 10]);
    if (!candidate) throw new Error('expected an OCR-sourced action candidate');

    const result = await adapter.act(candidate);
    expect(result.ok).toBe(true);
    expect(clickAt).toHaveBeenCalledWith(175, 225); // center of x=150,y=220,w=50,h=10
  });

  it('act() on an OCR-sourced action calls ax.clickAt, never ax.act', async () => {
    const clickAt = vi.fn(async () => {});
    const act = vi.fn(async () => ({ ok: true }));
    const ax = fakeAx(sparseSnapshot, { clickAt, act });
    const ocr = fakeOcr({
      lines: [{ text: 'Canvas label', x: 0, y: 0, w: 60, h: 16, confidence: 0.9 }],
      reused: 0,
      read: 1,
      tiles: { changed: 1, total: 1 },
      ms: 5,
    });
    const adapter = new HybridAdapter(ax, ocr, 'app:canvas', { goal: 'test' });

    const snapshot = await adapter.snapshot();
    const candidate = snapshot.actions.find((a) => a.source === 'ocr');
    if (!candidate) throw new Error('expected an OCR-sourced action candidate');
    await adapter.act(candidate);

    expect(clickAt).toHaveBeenCalledOnce();
    expect(act).not.toHaveBeenCalled();
  });

  it('act() on an AX-sourced action delegates to ax.act with the action and text, restoring AXPress/set-value', async () => {
    const act = vi.fn(async () => ({ ok: true }));
    const adapter = new HybridAdapter(
      fakeAx(richSnapshot, { act }),
      fakeOcr({ lines: [], reused: 0, read: 0, tiles: { changed: 0, total: 0 }, ms: 1 }),
      'app:rich',
      {
        goal: 'test',
      },
    );
    const snapshot = await adapter.snapshot();
    const first = snapshot.actions[0];
    if (!first) throw new Error('expected at least one action in the snapshot');

    const result = await adapter.act(first, 'some text');

    expect(result.ok).toBe(true);
    expect(act).toHaveBeenCalledWith(first, 'some text');
  });
});

describe('HybridAdapter OCR-only quality gate', () => {
  it('drops OCR-only candidates below minOcrConfidence, keeping high-confidence ones', async () => {
    const ocr = fakeOcr({
      lines: [
        { text: 'Garbled Ll¢w', x: 0, y: 0, w: 60, h: 14, confidence: 0.15 },
        { text: 'Clear label', x: 0, y: 100, w: 60, h: 14, confidence: 0.85 },
      ],
      reused: 0,
      read: 2,
      tiles: { changed: 1, total: 1 },
      ms: 5,
    });
    const adapter = new HybridAdapter(fakeAx(sparseSnapshot), ocr, 'app:canvas', { goal: 'test' });

    const snapshot = await adapter.snapshot();
    const ocrCandidates = snapshot.actions.filter((a) => a.source === 'ocr');

    expect(ocrCandidates).toHaveLength(1);
    expect(ocrCandidates[0]?.label).toBe('Clear label');
  });

  it('respects a custom minOcrConfidence threshold', async () => {
    const ocr = fakeOcr({
      lines: [{ text: 'Medium confidence', x: 0, y: 0, w: 60, h: 14, confidence: 0.4 }],
      reused: 0,
      read: 1,
      tiles: { changed: 1, total: 1 },
      ms: 5,
    });
    const strict = new HybridAdapter(fakeAx(sparseSnapshot), ocr, 'app:canvas', {
      goal: 'test',
      minOcrConfidence: 0.5,
    });
    const lenient = new HybridAdapter(fakeAx(sparseSnapshot), ocr, 'app:canvas', {
      goal: 'test',
      minOcrConfidence: 0.2,
    });

    const strictSnapshot = await strict.snapshot();
    const lenientSnapshot = await lenient.snapshot();

    expect(strictSnapshot.actions.filter((a) => a.source === 'ocr')).toHaveLength(0);
    expect(lenientSnapshot.actions.filter((a) => a.source === 'ocr')).toHaveLength(1);
  });

  it('drops OCR lines shorter than 2 characters regardless of confidence', async () => {
    const ocr = fakeOcr({
      lines: [
        { text: 'x', x: 0, y: 0, w: 10, h: 14, confidence: 0.99 },
        { text: 'OK', x: 0, y: 100, w: 20, h: 14, confidence: 0.99 },
      ],
      reused: 0,
      read: 2,
      tiles: { changed: 1, total: 1 },
      ms: 5,
    });
    const adapter = new HybridAdapter(fakeAx(sparseSnapshot), ocr, 'app:canvas', { goal: 'test' });

    const snapshot = await adapter.snapshot();
    const ocrCandidates = snapshot.actions.filter((a) => a.source === 'ocr');

    expect(ocrCandidates).toHaveLength(1);
    expect(ocrCandidates[0]?.label).toBe('OK');
  });

  it('requests accurate recognition by default', async () => {
    const ocr = fakeOcr({ lines: [], reused: 0, read: 0, tiles: { changed: 0, total: 0 }, ms: 1 });
    const adapter = new HybridAdapter(fakeAx(sparseSnapshot), ocr, 'app:canvas', { goal: 'test' });

    await adapter.snapshot();

    expect(ocr.ocr).toHaveBeenCalledWith(
      '/tmp/win.png',
      expect.objectContaining({ level: 'accurate' }),
    );
  });
});

describe('HybridAdapter delegation', () => {
  it('fullText() and screenshot() delegate to the AX source', async () => {
    const ax = fakeAx(richSnapshot);
    const adapter = new HybridAdapter(
      ax,
      fakeOcr({ lines: [], reused: 0, read: 0, tiles: { changed: 0, total: 0 }, ms: 1 }),
      'app:rich',
      {
        goal: 'test',
      },
    );

    await adapter.fullText();
    await adapter.screenshot();

    expect(ax.fullText).toHaveBeenCalledOnce();
    expect(ax.screenshot).toHaveBeenCalledOnce();
  });

  it('dispose() disposes both the OCR client and the AX source', async () => {
    const ax = fakeAx(richSnapshot);
    const ocr = fakeOcr({ lines: [], reused: 0, read: 0, tiles: { changed: 0, total: 0 }, ms: 1 });
    const adapter = new HybridAdapter(ax, ocr, 'app:rich', { goal: 'test' });

    await adapter.dispose();

    expect(ocr.dispose).toHaveBeenCalledOnce();
    expect(ax.dispose).toHaveBeenCalledOnce();
  });
});

describe('HybridAdapter marker() consistency (freshness-loop regression)', () => {
  // If marker() and snapshot().marker ever disagree while OCR is active, the
  // executor's freshness check thinks every frame changed and loops forever
  // (see run 89e64264: 48 Jev calls, 0 steps, budget_exhausted).
  it('marker() deep-equals snapshot().marker when OCR lines are present', async () => {
    const ocr = fakeOcr({
      lines: [
        { text: 'Press Alpha', x: 100, y: 200, w: 80, h: 16, confidence: 0.9 },
        { text: 'Press Beta', x: 100, y: 240, w: 80, h: 16, confidence: 0.9 },
      ],
      reused: 0,
      read: 2,
      tiles: { changed: 1, total: 1 },
      ms: 5,
    });
    const adapter = new HybridAdapter(fakeAx(sparseSnapshot), ocr, 'app:canvas', {
      goal: 'test',
      ocrMode: 'always',
    });

    const snapshot = await adapter.snapshot();
    const marker = await adapter.marker();

    expect(marker).toEqual(snapshot.marker);
    // Sanity: the OCR lines actually made it into the marker (regression would trivially "pass" on an empty marker).
    expect(marker.length).toBeGreaterThan(sparseSnapshot.marker.length);
  });

  it('marker stays equal across calls even when Vision returns boxes jittered by +/-1px on an unchanged frame', async () => {
    const ocr = {
      ocr: vi
        .fn()
        .mockResolvedValueOnce({
          lines: [{ text: 'Press Alpha', x: 100, y: 200, w: 80, h: 16, confidence: 0.9 }],
          reused: 0,
          read: 1,
          tiles: { changed: 1, total: 1 },
          ms: 5,
        })
        .mockResolvedValueOnce({
          // Same frame, +/-1px jitter in Vision's returned box.
          lines: [{ text: 'Press Alpha', x: 101, y: 199, w: 79, h: 17, confidence: 0.9 }],
          reused: 1,
          read: 0,
          tiles: { changed: 0, total: 1 },
          ms: 2,
        }),
      capture: vi.fn(),
      dispose: vi.fn(async () => {}),
    } as unknown as OcrClient;
    const adapter = new HybridAdapter(fakeAx(sparseSnapshot), ocr, 'app:canvas', {
      goal: 'test',
      ocrMode: 'always',
    });

    const first = await adapter.snapshot();
    const second = await adapter.marker();

    expect(second).toEqual(first.marker);
  });
});
