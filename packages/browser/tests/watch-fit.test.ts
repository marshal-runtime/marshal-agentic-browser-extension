/**
 * The live panel as a browser pane: the page takes the pane's size (one panel at a time, never a size the caller set,
 * never under a recording, back to the default when nobody looks), a still sharpens the picture at rest, frames with
 * the decision marks never reach a viewer, and a typed address is a web address or nothing. Each guard is mutated on
 * its own by scripts/mutate-session-guards.mjs.
 */
import { describe, expect, it } from 'vitest';
import { ScreencastHub, type ScreencastChannel } from '../src/chrome/screencast.js';
import type { CdpEvent } from '../src/chrome/cdp.js';
import { Lifecycle } from '../src/lifecycle.js';
import { LIFECYCLE_DESCRIPTORS } from '../src/lifecycle-descriptors.js';
import { TaskRegistry } from '../src/tasks.js';
import type {
  ActOutcome,
  PageLocation,
  PanelFit,
  PanelInput,
  PointerMark,
  ScreencastFrameMeta,
  ScreencastHandle,
  ScreencastOptions,
  Still,
} from '../src/target.js';
import { WATCH_HTML } from '../src/watch/app.js';
import { addressOf, FIT_LIMITS, panelFit, STREAM_LIMITS } from '../src/watch/geometry.js';
import {
  CAPTURE_SLOW_MS,
  ECHO_MS,
  ENDED_MS,
  IDLE_MS,
  OWNER_MS,
  parsePanelEvent,
  RECHECK_MS,
  STILL_AFTER_MS,
  STILL_MAX_BYTES,
  WatchRegistry,
} from '../src/watch/watches.js';
import { FakeTarget, page } from './helpers.js';

const pages = [page('https://shop.test/', [])];
const flush = async (): Promise<void> => {
  for (let index = 0; index < 12; index += 1) await Promise.resolve();
};

/** A managed-like tab that records what the panel asks of it. */
class PaneTarget extends FakeTarget {
  readonly fits: (PanelFit | null)[] = [];
  readonly casts: ScreencastOptions[] = [];
  readonly order: string[] = [];
  emit: ((data: string, meta: ScreencastFrameMeta) => void) | null = null;
  size = { width: 1280, height: 800, deviceScaleFactor: 1 };
  callerPinned = false;
  /** Other consumers of the tab's frames (a recording). */
  others = 0;
  streams = 0;
  stills = 0;
  nextStill: Still | null = null;
  stillGate: Promise<void> | null = null;
  pointer: PointerMark | null = null;
  where: PageLocation = { url: 'https://shop.test/a', title: 'A' };
  get screencastConsumers(): number {
    return this.streams + this.others;
  }
  viewport(): { width: number; height: number; deviceScaleFactor: number; pinned: boolean } {
    return { ...this.size, pinned: this.callerPinned };
  }
  fitToPanel(fit: PanelFit | null): Promise<boolean> {
    this.fits.push(fit);
    this.order.push(fit ? 'fit' : 'unfit');
    if (this.callerPinned) return Promise.resolve(false);
    this.size = fit ? { ...fit } : { width: 1280, height: 800, deviceScaleFactor: 1 };
    return Promise.resolve(true);
  }
  screencast(
    opts: ScreencastOptions,
    onFrame: (data: string, meta: ScreencastFrameMeta) => void,
  ): Promise<ScreencastHandle> {
    this.casts.push(opts);
    this.streams += 1;
    this.emit = onFrame;
    let stopped = false;
    return Promise.resolve({
      stop: () => {
        if (!stopped) this.streams -= 1;
        stopped = true;
        return Promise.resolve();
      },
    });
  }
  async still(): Promise<Still | null> {
    this.stills += 1;
    if (this.stillGate) await this.stillGate;
    return this.nextStill;
  }
  location(): Promise<PageLocation> {
    return Promise.resolve(this.where);
  }
  async panelInput(input: PanelInput): Promise<ActOutcome> {
    await Promise.resolve();
    this.order.push(input.kind);
    return { ok: true };
  }
  frame(width = 871, height = 1100): void {
    this.emit?.('A'.repeat(4_000), {
      ts: 1,
      width,
      height,
      pageWidth: this.size.width,
      pageHeight: this.size.height,
    });
  }
}

const VIEW = { width: 871, height: 1100, dpr: 0.833, fit: true, viewer: 'dock' } as const;
const sessionOf = (
  watches: WatchRegistry,
  target: PaneTarget,
  live: { open: boolean } = { open: true },
): string =>
  watches.open({ kind: 'session', sessionId: 's', target: () => (live.open ? target : null) });
const frameOfState = (state: Record<string, unknown>): { sharp?: boolean } =>
  (state['frame'] ?? {}) as { sharp?: boolean };
const pageOf = (state: Record<string, unknown>): Record<string, unknown> =>
  state['page'] as Record<string, unknown>;

describe('the page size that fills a pane', () => {
  it('one device pixel per CSS pixel on a plain screen, two on a dense one, three on a phone', () => {
    expect(panelFit({ width: 871, height: 1100, dpr: 0.833 })).toEqual({
      width: 871,
      height: 1100,
      deviceScaleFactor: 1,
    });
    expect(panelFit({ width: 1743, height: 2200, dpr: 1.667 })).toEqual({
      width: 872,
      height: 1100,
      deviceScaleFactor: 2,
    });
    expect(panelFit({ width: 1170, height: 2100, dpr: 3 })).toEqual({
      width: 390,
      height: 700,
      deviceScaleFactor: 3,
    });
    expect(panelFit({ width: 900, height: 700 })?.deviceScaleFactor).toBe(1);
    expect(panelFit({ width: 900, height: 700, dpr: Number.NaN })?.deviceScaleFactor).toBe(1);
  });

  it('a pane past the limits gets the largest page of its own shape; a tiny one the smallest page', () => {
    const tall = panelFit({ width: 1000, height: 3200, dpr: 1 });
    expect(tall).toEqual({ width: 500, height: FIT_LIMITS.maxHeight, deviceScaleFactor: 1 });
    const wide = panelFit({ width: 3840, height: 1200, dpr: 1 });
    expect(wide).toEqual({ width: FIT_LIMITS.maxWidth, height: 600, deviceScaleFactor: 1 });
    expect(panelFit({ width: 200, height: 100, dpr: 1 })).toEqual({
      width: FIT_LIMITS.minWidth,
      height: FIT_LIMITS.minHeight,
      deviceScaleFactor: 1,
    });
    expect(panelFit(undefined)).toBeNull();
    expect(panelFit({ width: 0, height: 500 })).toBeNull();
  });
});

describe('a typed address', () => {
  it('is a web address: a bare host gets https, a local server http', () => {
    expect(addressOf('example.com')).toBe('https://example.com/');
    expect(addressOf('  books.toscrape.com/catalogue/page-2.html ')).toBe(
      'https://books.toscrape.com/catalogue/page-2.html',
    );
    expect(addressOf('http://example.com/a?b=1#c')).toBe('http://example.com/a?b=1#c');
    expect(addressOf('localhost:5173/app')).toBe('http://localhost:5173/app');
    expect(addressOf('127.0.0.1:8080')).toBe('http://127.0.0.1:8080/');
    expect(addressOf('[::1]:3000')).toBe('http://[::1]:3000/');
  });

  it('refuses everything else', () => {
    for (const typed of [
      '',
      'hello',
      'two words',
      'javascript:alert(1)',
      'javascript://example.com/%0aalert(1)',
      'file:///etc/passwd',
      'chrome://settings',
      'data:text/html,<b>x</b>',
      'ftp://example.com/',
      'https://user:pw@example.com/',
      'user@example.com',
      'example.com/a\nb',
      'http://169.254.169.254/latest/meta-data/',
      'http://2852039166/',
      'http://0xa9fea9fe/',
      '[fe80::1]',
      `example.com/${'a'.repeat(2_000)}`,
    ])
      expect(addressOf(typed), typed).toBeNull();
  });

  it('the panel event carries the normalized address, and nothing that is not one', () => {
    expect(parsePanelEvent({ kind: 'navigate', url: 'example.com' })).toEqual({
      kind: 'navigate',
      url: 'https://example.com/',
    });
    expect(typeof parsePanelEvent({ kind: 'navigate', url: 'javascript:alert(1)' })).toBe('string');
    expect(typeof parsePanelEvent({ kind: 'navigate' })).toBe('string');
    expect(typeof parsePanelEvent({ kind: 'navigate', url: 7 })).toBe('string');
  });
});

describe('the page follows the panel', () => {
  it('takes the pane size when the panel asks to fit, and says so', async () => {
    const watches = new WatchRegistry(() => 1_000);
    const target = new PaneTarget(pages);
    const id = sessionOf(watches, target);
    await flush();
    expect(pageOf(watches.poll(id, undefined, VIEW))).toMatchObject({ fit: false, width: 1280 });
    await flush();
    expect(target.fits).toEqual([{ width: 871, height: 1100, deviceScaleFactor: 1 }]);
    expect(pageOf(watches.poll(id, undefined, VIEW))).toEqual({
      width: 871,
      height: 1100,
      deviceScaleFactor: 1,
      fit: true,
      pinned: false,
    });
    // The same size again resizes nothing; a new size does.
    watches.poll(id, undefined, VIEW);
    await flush();
    expect(target.fits).toHaveLength(1);
    watches.poll(id, undefined, { ...VIEW, width: 600 });
    await flush();
    expect(target.fits.at(-1)).toEqual({ width: 600, height: 1100, deviceScaleFactor: 1 });
    // A page sized to the pane streams its own pixels: the largest request, so a drag never restarts the stream.
    expect(target.casts.at(-1)).toMatchObject({
      maxWidth: STREAM_LIMITS.maxWidth,
      maxHeight: STREAM_LIMITS.maxHeight,
    });
    await watches.dispose();
  });

  it('a panel that does not ask keeps the default page, and one that stops asking gets it back', async () => {
    const watches = new WatchRegistry(() => 1_000);
    const target = new PaneTarget(pages);
    const id = sessionOf(watches, target);
    await flush();
    watches.poll(id, undefined, { width: 871, height: 1100, viewer: 'dock' });
    await flush();
    expect(target.fits).toEqual([]);
    watches.poll(id, undefined, VIEW);
    await flush();
    watches.poll(id, undefined, { ...VIEW, fit: false });
    await flush();
    expect(target.fits).toEqual([{ width: 871, height: 1100, deviceScaleFactor: 1 }, null]);
    expect(pageOf(watches.poll(id, undefined, { ...VIEW, fit: false }))).toMatchObject({
      fit: false,
      width: 1280,
      height: 800,
    });
    await watches.dispose();
  });

  it('one panel owns the size while it polls; another takes over only after it went quiet', async () => {
    let now = 1_000;
    const watches = new WatchRegistry(() => now);
    const target = new PaneTarget(pages);
    const id = sessionOf(watches, target);
    await flush();
    watches.poll(id, undefined, VIEW);
    await flush();
    now += 300;
    const second = { width: 400, height: 600, dpr: 1, fit: true, viewer: 'window' };
    const seen = watches.poll(id, undefined, second);
    await flush();
    expect(target.fits).toHaveLength(1);
    // The second panel is told the page is not its size: it draws the page scaled, not edge to edge.
    expect(pageOf(seen)).toMatchObject({ fit: false, width: 871 });
    expect(pageOf(watches.poll(id, undefined, VIEW))).toMatchObject({ fit: true });
    now += OWNER_MS + 1;
    watches.poll(id, undefined, second);
    await flush();
    expect(target.fits.at(-1)).toEqual({ width: 400, height: 600, deviceScaleFactor: 1 });
    expect(pageOf(watches.poll(id, undefined, second))).toMatchObject({ fit: true, width: 400 });
    await watches.dispose();
  });

  it('never resizes a page whose size the caller set', async () => {
    const watches = new WatchRegistry(() => 1_000);
    const target = new PaneTarget(pages);
    target.callerPinned = true;
    target.size = { width: 390, height: 844, deviceScaleFactor: 3 };
    const id = sessionOf(watches, target);
    await flush();
    watches.poll(id, undefined, VIEW);
    await flush();
    watches.poll(id, undefined, { ...VIEW, width: 700 });
    await flush();
    // Asked once, refused, never asked again.
    expect(target.fits).toHaveLength(1);
    expect(pageOf(watches.poll(id, undefined, VIEW))).toEqual({
      width: 390,
      height: 844,
      deviceScaleFactor: 3,
      fit: false,
      pinned: true,
    });
    // The stream is then sized to the panel, as for any page that keeps its size.
    expect(target.casts.at(-1)).toMatchObject({ maxWidth: 700, maxHeight: 1100 });
    await watches.dispose();
  });

  it('keeps the page size while something else reads the frames (a recording)', async () => {
    const watches = new WatchRegistry(() => 1_000);
    const target = new PaneTarget(pages);
    target.others = 1;
    const id = sessionOf(watches, target);
    await flush();
    watches.poll(id, undefined, VIEW);
    await flush();
    expect(target.fits).toEqual([]);
    target.others = 0;
    watches.poll(id, undefined, VIEW);
    await flush();
    expect(target.fits).toHaveLength(1);
    // A recording that starts later gets the default size back.
    target.others = 1;
    watches.poll(id, undefined, VIEW);
    await flush();
    expect(target.fits.at(-1)).toBeNull();
    await watches.dispose();
  });

  it('resizes after an input already on its way, never under it', async () => {
    const watches = new WatchRegistry(() => 1_000);
    const target = new PaneTarget(pages);
    const id = sessionOf(watches, target);
    await flush();
    target.frame(640, 400);
    const typed = watches.input(id, { kind: 'text', text: 'a' });
    watches.poll(id, undefined, VIEW);
    await typed;
    await flush();
    expect(target.order).toEqual(['text', 'fit']);
    await watches.dispose();
  });

  it('gives the default size back when nobody looks any more, and when the watch closes', async () => {
    let now = 1_000;
    const watches = new WatchRegistry(() => now);
    const target = new PaneTarget(pages);
    const id = sessionOf(watches, target);
    await flush();
    watches.poll(id, undefined, VIEW);
    await flush();
    now += IDLE_MS - 1;
    await watches.check();
    expect(target.fits).toHaveLength(1);
    now += 2;
    await watches.check();
    expect(target.fits.at(-1)).toBeNull();
    expect(target.size).toMatchObject({ width: 1280, height: 800 });
    // Looked at again: the pane size again.
    watches.poll(id, undefined, VIEW);
    await flush();
    expect(target.fits.at(-1)).toEqual({ width: 871, height: 1100, deviceScaleFactor: 1 });
    await watches.close(id);
    expect(target.fits.at(-1)).toBeNull();
    await watches.dispose();
  });

  it('the lifecycle passes the pane (size, ratio, fit, viewer) and drops what is not sane', async () => {
    const target = new PaneTarget(pages);
    const lifecycle = new Lifecycle({ sessionTarget: () => target, artifactRoot: () => '/tmp' });
    const opened = await lifecycle.invoke('browser.watch', { sessionId: 's', open: false });
    const watchId = String(opened['watchId']);
    await flush();
    await lifecycle.invoke('browser.watch.frame', {
      watchId,
      view: { width: 1743, height: 2200, dpr: 1.667, fit: true, viewer: 'p-abc123' },
    });
    await flush();
    expect(target.fits).toEqual([{ width: 872, height: 1100, deviceScaleFactor: 2 }]);
    // fit must be exactly true; a viewer that is not a plain id is dropped (it then shares the unnamed one).
    await lifecycle.invoke('browser.watch.frame', {
      watchId,
      view: { width: 1743, height: 2200, dpr: 1.667, fit: 'yes', viewer: 'p-abc123' },
    });
    await flush();
    expect(target.fits.at(-1)).toBeNull();
    await lifecycle.invoke('browser.watch.frame', {
      watchId,
      view: { width: 500, height: 20_000, dpr: 99, fit: true, viewer: 'p-abc123' },
    });
    await flush();
    expect(target.fits).toHaveLength(2);
    await lifecycle.dispose();
  });
});

/** Every key of `value` is declared by `schema`, down through nested objects (the host refuses an undeclared key). */
function undeclared(value: unknown, schema: unknown, at = 'output'): string[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return [];
  const properties = (schema as { properties?: Record<string, unknown> } | undefined)?.properties;
  if (!properties) return [];
  return Object.entries(value).flatMap(([key, inner]) =>
    key in properties ? undeclared(inner, properties[key], `${at}.${key}`) : [`${at}.${key}`],
  );
}

describe('what the panel is told is what the capability declares', () => {
  it('a session with a fitted page, a pointer, a sharp picture and a task that just ended', async () => {
    let now = 10_000;
    const tasks = new TaskRegistry(() => now);
    const target = new PaneTarget(pages);
    target.where = {
      url: 'https://shop.test/b',
      title: 'B',
      loading: true,
      canGoBack: true,
      canGoForward: false,
    };
    target.pointer = { x: 10, y: 10, at: 9_990 };
    target.nextStill = {
      data: 'S'.repeat(4_000),
      mimeType: 'image/png',
      width: 871,
      height: 1100,
      pageWidth: 871,
      pageHeight: 1100,
    };
    let finish: (output: Record<string, unknown>) => void = () => undefined;
    const entry = tasks.start('goal', (task) => {
      task.target = target;
      task.sessionId = 's';
      return new Promise((resolve) => {
        finish = resolve;
      });
    });
    const watches = new WatchRegistry(() => now);
    const id = watches.open({
      kind: 'session',
      sessionId: 's',
      target: () => target,
      task: () => (entry.state === 'running' ? entry : null),
      lastTask: () => (entry.state === 'finished' ? entry : null),
    });
    await flush();
    watches.poll(id, undefined, VIEW);
    await flush();
    target.frame();
    await flush();
    const schema = LIFECYCLE_DESCRIPTORS.find(
      (d) => d.name === 'browser.watch.frame',
    )?.outputSchema;
    const driven = watches.poll(id, undefined, VIEW);
    expect(driven).toMatchObject({ taskId: entry.id, viewOnly: 'task', page: { fit: true } });
    expect(frameOfState(driven).sharp).toBe(true);
    expect(undeclared(driven, schema)).toEqual([]);

    // The task ends: the session is the person's again, and the panel is told how the task ended, for a while.
    finish({ ok: true, status: 'done' });
    await flush();
    now += 1_000;
    const after = watches.poll(id, undefined, VIEW);
    expect(after['taskId']).toBeUndefined();
    expect(after).toMatchObject({
      interactive: true,
      ended: { taskId: entry.id, status: 'done', state: 'finished', finishedAt: 10_000 },
    });
    expect(undeclared(after, schema)).toEqual([]);
    now += ENDED_MS;
    expect(watches.poll(id, undefined, VIEW)['ended']).toBeUndefined();
    await watches.dispose();
  });

  it('a key the capability does not declare is caught by this check', () => {
    const schema = LIFECYCLE_DESCRIPTORS.find(
      (d) => d.name === 'browser.watch.frame',
    )?.outputSchema;
    expect(undeclared({ ok: true, surprise: 1, page: { width: 1, zoom: 2 } }, schema)).toEqual([
      'output.surprise',
      'output.page.zoom',
    ]);
  });
});

describe('the toolbar and the pointer', () => {
  it('says whether the page loads, where back and forward can go, and where the automation clicked', async () => {
    let now = 10_000;
    const watches = new WatchRegistry(() => now);
    const target = new PaneTarget(pages);
    target.where = {
      url: 'https://shop.test/b',
      title: 'B',
      loading: true,
      canGoBack: true,
      canGoForward: false,
    };
    target.pointer = { x: 640, y: 200, at: 9_000 };
    const id = sessionOf(watches, target);
    await flush();
    watches.poll(id);
    await flush();
    const state = watches.poll(id);
    expect(state).toMatchObject({
      loading: true,
      canGoBack: true,
      canGoForward: false,
      pointer: { nx: 0.5, ny: 0.25, at: 9_000 },
    });
    // An old click is not shown.
    now = 20_000;
    expect(watches.poll(id)['pointer']).toBeUndefined();
    target.where = { url: 'https://shop.test/b', title: 'B' };
    await flush();
    now += 400;
    watches.poll(id);
    await flush();
    const rested = watches.poll(id);
    expect(rested['loading']).toBeUndefined();
    expect(rested['canGoBack']).toBeUndefined();
    await watches.dispose();
  });

  it('a typed address navigates the tab; a task-driven or closed one refuses it', async () => {
    const watches = new WatchRegistry(() => 1_000);
    const target = new PaneTarget(pages);
    const live = { open: true };
    const id = sessionOf(watches, target, live);
    await flush();
    expect(await watches.input(id, { kind: 'navigate', url: 'example.com/x' })).toMatchObject({
      ok: true,
    });
    expect(target.actions).toEqual([{ kind: 'navigate', url: 'https://example.com/x' }]);
    await expect(
      watches.input(id, { kind: 'navigate', url: 'file:///etc/passwd' }),
    ).rejects.toThrow(/BROWSER_BAD_INPUT/);
    live.open = false;
    expect(await watches.input(id, { kind: 'navigate', url: 'example.com' })).toMatchObject({
      ok: false,
      status: 'view_only',
      viewOnly: 'closed',
    });

    const tasks = new TaskRegistry(() => 1_000);
    const driven = new PaneTarget(pages);
    const entry = tasks.start('goal', (task) => {
      task.target = driven;
      return new Promise(() => undefined);
    });
    await flush();
    const taskWatch = watches.open({ kind: 'task', entry });
    await flush();
    expect(await watches.input(taskWatch, { kind: 'navigate', url: 'example.com' })).toMatchObject({
      ok: false,
      status: 'view_only',
      viewOnly: 'task',
    });
    expect(driven.actions).toEqual([]);
    expect(target.actions).toHaveLength(1);
    await watches.dispose();
  });
});

describe('a sharp picture', () => {
  let stillNo = 0;
  const still = (data = `S${String((stillNo += 1))}`.padEnd(8_000, 's')): Still => ({
    data,
    mimeType: 'image/png',
    width: 871,
    height: 1100,
    pageWidth: 871,
    pageHeight: 1100,
  });
  const fitted = async (now: {
    at: number;
  }): Promise<{ watches: WatchRegistry; target: PaneTarget; id: string }> => {
    const watches = new WatchRegistry(() => now.at);
    const target = new PaneTarget(pages);
    const id = sessionOf(watches, target);
    await flush();
    watches.poll(id, undefined, VIEW);
    await flush();
    return { watches, target, id };
  };
  const frameIn = (state: Record<string, unknown>): { sharp?: boolean; mimeType?: string } =>
    (state['frame'] ?? {}) as { sharp?: boolean; mimeType?: string };

  it('a calm page gets a capture per change, shown instead of the frame', async () => {
    const now = { at: 1_000 };
    const { watches, target, id } = await fitted(now);
    target.nextStill = still();
    target.frame();
    // Nothing is shown until the capture is there: the half-sharp frame never flashes.
    expect(watches.poll(id, undefined, VIEW)['frame']).toBeUndefined();
    await flush();
    expect(target.stills).toBe(1);
    const first = watches.poll(id, undefined, VIEW);
    expect(first['frame']).toMatchObject({
      sharp: true,
      mimeType: 'image/png',
      width: 871,
      height: 1100,
      pageWidth: 871,
    });
    expect(first['lastFrameAt']).toBe(1_000);
    // The next change (a caret blink half a second later): one more capture, sharp again.
    now.at += 500;
    target.nextStill = still();
    target.frame();
    await flush();
    expect(target.stills).toBe(2);
    const second = watches.poll(id, Number(first['seq']), VIEW);
    expect(frameIn(second).sharp).toBe(true);
    expect(second['lastFrameAt']).toBe(1_500);
    await watches.dispose();
  });

  it('a page in motion streams its frames, then gets a still once it rests, once per rest', async () => {
    const now = { at: 1_000 };
    const { watches, target, id } = await fitted(now);
    target.nextStill = still();
    target.frame();
    await flush();
    now.at += ECHO_MS;
    target.frame();
    await flush();
    expect(target.stills).toBe(2);
    // The third frame within MOTION.withinMs: the page moves, frames are shown as they come.
    now.at += ECHO_MS;
    target.frame();
    await flush();
    expect(target.stills).toBe(2);
    const moving = watches.poll(id, undefined, VIEW);
    expect(frameIn(moving)).toMatchObject({ mimeType: 'image/jpeg' });
    expect(frameIn(moving).sharp).toBeUndefined();
    now.at += STILL_AFTER_MS - 1;
    watches.poll(id, Number(moving['seq']), VIEW);
    await flush();
    expect(target.stills).toBe(2); // not at rest long enough
    now.at += 1;
    target.nextStill = still();
    watches.poll(id, Number(moving['seq']), VIEW);
    await flush();
    expect(target.stills).toBe(3);
    const rested = watches.poll(id, Number(moving['seq']), VIEW);
    expect(frameIn(rested).sharp).toBe(true);
    // Sharpening is no change: "last change" is still the last frame's time.
    expect(rested['lastFrameAt']).toBe(1_000 + 2 * ECHO_MS);
    await watches.dispose();
  });

  it("a capture's own echo is not shown; the page is looked at once more, and an unchanged page ends it", async () => {
    const now = { at: 1_000 };
    const { watches, target, id } = await fitted(now);
    const same = still();
    target.nextStill = same;
    target.frame();
    await flush();
    const first = watches.poll(id, undefined, VIEW);
    expect(frameIn(first).sharp).toBe(true);
    // Chrome sends a frame for the capture itself.
    now.at += 40;
    target.frame();
    await flush();
    expect(target.stills).toBe(1);
    expect(watches.poll(id, Number(first['seq']), VIEW)['frame']).toBeUndefined();
    // After the echo: one more look. The same bytes: nothing new to show, and the look's own echo ends there.
    now.at += ECHO_MS;
    watches.poll(id, Number(first['seq']), VIEW);
    await flush();
    expect(target.stills).toBe(2);
    now.at += 40;
    target.frame();
    now.at += ECHO_MS;
    watches.poll(id, Number(first['seq']), VIEW);
    await flush();
    expect(target.stills).toBe(2);
    expect(watches.poll(id, Number(first['seq']), VIEW)['frame']).toBeUndefined();
    await watches.dispose();
  });

  it('a change that fell inside the echo is found by that second look', async () => {
    const now = { at: 1_000 };
    const { watches, target, id } = await fitted(now);
    target.nextStill = still();
    target.frame();
    await flush();
    const first = watches.poll(id, undefined, VIEW);
    now.at += 60;
    target.frame(); // a real second paint, indistinguishable from the echo
    target.nextStill = still();
    now.at += ECHO_MS;
    watches.poll(id, Number(first['seq']), VIEW);
    await flush();
    const second = watches.poll(id, Number(first['seq']), VIEW);
    expect(frameIn(second).sharp).toBe(true);
    expect(Number(second['seq'])).toBeGreaterThan(Number(first['seq']));
    // That look showed something new, so its echo is checked too (and finds the same bytes).
    now.at += 40;
    target.frame();
    now.at += ECHO_MS;
    watches.poll(id, Number(second['seq']), VIEW);
    await flush();
    expect(target.stills).toBe(3);
    await watches.dispose();
  });

  it('a sharp picture at rest is looked at again now and then', async () => {
    const now = { at: 1_000 };
    const { watches, target, id } = await fitted(now);
    target.nextStill = still();
    target.frame();
    await flush();
    const first = watches.poll(id, undefined, VIEW);
    now.at += RECHECK_MS - 1;
    watches.poll(id, Number(first['seq']), VIEW);
    await flush();
    expect(target.stills).toBe(1);
    now.at += 1;
    target.nextStill = still();
    watches.poll(id, Number(first['seq']), VIEW);
    await flush();
    expect(target.stills).toBe(2);
    expect(frameIn(watches.poll(id, Number(first['seq']), VIEW)).sharp).toBe(true);
    await watches.dispose();
  });

  it('a capture that cannot be taken, or is too large, shows the frame it was to replace', async () => {
    const now = { at: 1_000 };
    const { watches, target, id } = await fitted(now);
    target.nextStill = null;
    target.frame();
    await flush();
    const plain = watches.poll(id, undefined, VIEW);
    expect(frameIn(plain)).toMatchObject({ mimeType: 'image/jpeg' });
    now.at += 1_000;
    target.nextStill = still('S'.repeat(Math.ceil((STILL_MAX_BYTES * 4) / 3) + 8));
    target.frame();
    await flush();
    const large = watches.poll(id, Number(plain['seq']), VIEW);
    expect(frameIn(large)).toMatchObject({ mimeType: 'image/jpeg' });
    expect(frameIn(large).sharp).toBeUndefined();
    await watches.dispose();
  });

  it('a capture Chrome does not answer is given up: frames are shown again, its late answer dropped', async () => {
    const now = { at: 1_000 };
    const { watches, target, id } = await fitted(now);
    let release: () => void = () => undefined;
    target.stillGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    target.nextStill = still();
    target.frame();
    await flush();
    // Within a capture's normal time a frame is its echo: not shown.
    now.at += CAPTURE_SLOW_MS;
    target.frame();
    expect(watches.poll(id, undefined, VIEW)['frame']).toBeUndefined();
    // Past it the capture is stuck (the page navigated under it): the page's frames are shown.
    now.at += 1;
    target.frame();
    const shown = watches.poll(id, undefined, VIEW);
    expect(frameIn(shown)).toMatchObject({ mimeType: 'image/jpeg' });
    expect(shown['lastFrameAt']).toBe(1_000 + CAPTURE_SLOW_MS + 1);
    release();
    await flush();
    expect(watches.poll(id, Number(shown['seq']), VIEW)['frame']).toBeUndefined();
    await watches.dispose();
  });

  it('a small panel showing a larger page takes no capture (its frame is already downsampled)', async () => {
    const now = { at: 1_000 };
    const watches = new WatchRegistry(() => now.at);
    const target = new PaneTarget(pages);
    target.nextStill = still();
    const id = sessionOf(watches, target);
    await flush();
    const plain = { width: 640, height: 400, dpr: 1, viewer: 'dock' };
    watches.poll(id, undefined, plain);
    await flush();
    target.frame(640, 400); // half of the 1280 page
    now.at += STILL_AFTER_MS;
    const small = watches.poll(id, undefined, plain);
    await flush();
    expect(target.stills).toBe(0);
    expect(frameIn(small)).toMatchObject({ mimeType: 'image/jpeg' });
    // At the page's own size it is worth it, fitted or not.
    now.at += 1_000;
    target.frame(1280, 800);
    await flush();
    expect(target.stills).toBe(1);
    await watches.dispose();
  });

  it('takes no capture while something else reads the frames (its echo would land in a recording)', async () => {
    const now = { at: 1_000 };
    const { watches, target, id } = await fitted(now);
    target.nextStill = still();
    target.others = 1;
    target.frame();
    await flush();
    now.at += STILL_AFTER_MS;
    const state = watches.poll(id, undefined, VIEW);
    await flush();
    expect(target.stills).toBe(0);
    expect(frameIn(state)).toMatchObject({ mimeType: 'image/jpeg' });
    await watches.dispose();
  });
});

describe('frames with the decision marks', () => {
  it('are acknowledged and never delivered, to the panel or a recording', async () => {
    const sent: { method: string; params: Record<string, unknown> }[] = [];
    let listener: ((event: CdpEvent) => void) | null = null;
    const channel: ScreencastChannel = {
      closed: false,
      send: (method, params = {}) => {
        sent.push({ method, params: { ...params } });
        return Promise.resolve({});
      },
      onEvent: (handler) => {
        listener = handler;
        return () => undefined;
      },
    };
    let held = false;
    const hub = new ScreencastHub(channel, 'S1', () => held);
    const got: string[] = [];
    const recorded: string[] = [];
    const panel = await hub.subscribe({ maxWidth: 800 }, (data) => got.push(data));
    const recorder = await hub.subscribe({ maxWidth: 800 }, (data) => recorded.push(data));
    const frame = (data: string, ack: number): void =>
      listener?.({
        method: 'Page.screencastFrame',
        sessionId: 'S1',
        params: { data, sessionId: ack, metadata: { deviceWidth: 800, deviceHeight: 500 } },
      });
    frame('clean-1', 1);
    held = true;
    frame('marked', 2);
    held = false;
    frame('clean-2', 3);
    expect(got).toEqual(['clean-1', 'clean-2']);
    expect(recorded).toEqual(['clean-1', 'clean-2']);
    // Chrome sends the next frame only after the last was acknowledged: the held one is acknowledged too.
    expect(
      sent
        .filter((entry) => entry.method === 'Page.screencastFrameAck')
        .map((e) => e.params['sessionId']),
    ).toEqual([1, 2, 3]);
    await panel.stop();
    await recorder.stop();
  });
});

describe('the panel is a browser pane', () => {
  const script = /<script>([\s\S]*)<\/script>/.exec(WATCH_HTML)?.[1] ?? '';

  it('tells the extension its size, pixel ratio, that it wants the page to fit, and which panel it is', () => {
    expect(script).toMatch(
      /const wanted = \{ width: area\.width, height: area\.height, dpr: [^}]+, fit: follow, viewer \}/,
    );
    expect(script).toContain('if (view) args.view = view;');
    // The choice is the person's and is remembered; a page whose size the caller set is never asked to fit.
    expect(script).toContain("localStorage.getItem('fit') !== 'off'");
    expect(script).toContain(
      'const follow = fitWanted && !(last && last.page && last.page.pinned);',
    );
  });

  it('has a toolbar: back, forward, reload, an address field that navigates, who drives the page', () => {
    for (const id of ['back', 'forward', 'reload', 'address', 'omni', 'badge', 'fit', 'progress'])
      expect(WATCH_HTML).toContain(`id="${id}"`);
    expect(script).toContain("send({ kind: 'navigate', url: typed })");
    // The address field is read-only unless the person may use the page.
    expect(script).toContain('address.readOnly = !interactive;');
    expect(script).toContain('if (!typed || !interactive) return;');
    // The frame is sandboxed without form submission: Enter is read on the key, and there is no form to send.
    expect(WATCH_HTML).not.toMatch(/<form\b/);
    expect(script).not.toContain("'submit'");
    // No status footer: the page takes everything under the toolbar.
    expect(WATCH_HTML).not.toContain('class="status"');
  });

  it('never upscales a page that keeps its own size, and draws a fitted page from the top left', () => {
    expect(script).toContain('device = { x: 0, y: 0,');
    expect(script).toContain(
      'const limit = page ? { width: Math.round(page.width * dpr), height: Math.round(page.height * dpr) } : inner;',
    );
  });

  it('keeps the task line, Details and Stop', () => {
    expect(WATCH_HTML).toMatch(/<button[^>]*id="more"[^>]*aria-controls="details"/);
    expect(WATCH_HTML).toContain('<pre class="details" id="details" hidden></pre>');
    expect(WATCH_HTML).toContain("call('browser.task.cancel'");
  });
});
