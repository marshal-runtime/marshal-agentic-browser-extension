/**
 * The live panel v2: its geometry (the exact functions the panel runs), frames sized to the panel and bounded in bytes,
 * the liveness fields of browser.watch.frame, and every refusal of browser.watch.input (view-only for a task, a
 * session a task drives, the person's own Chrome, an app, a closed session; rate limit; bad input). Each guard is
 * mutated on its own by scripts/mutate-session-guards.mjs.
 */
import { describe, expect, it } from 'vitest';
import { ScreencastHub, type ScreencastChannel } from '../src/chrome/screencast.js';
import { Lifecycle } from '../src/lifecycle.js';
import { TaskRegistry } from '../src/tasks.js';
import type {
  ActOutcome,
  PanelInput,
  ScreencastFrameMeta,
  ScreencastHandle,
  ScreencastOptions,
  Target,
} from '../src/target.js';
import { WATCH_HTML } from '../src/watch/app.js';
import {
  clientToFrame,
  containRect,
  FRAME_MAX_BYTES,
  framePoint,
  sizeChanged,
  STREAM_LIMITS,
  streamSize,
} from '../src/watch/geometry.js';
import { INPUT_RATE, parsePanelEvent, WatchRegistry } from '../src/watch/watches.js';
import { FakeTarget, page } from './helpers.js';

const pages = [page('https://shop.test/', [])];
const flush = async (): Promise<void> => {
  for (let index = 0; index < 5; index += 1) await Promise.resolve();
};

/** A managed-like target with a screencast, a location and panel input it records. */
class PanelTarget extends FakeTarget {
  override readonly backend: Target['backend'];
  readonly casts: ScreencastOptions[] = [];
  readonly inputs: PanelInput[] = [];
  open = 0;
  emit: ((data: string, meta: ScreencastFrameMeta) => void) | null = null;
  panelOutcome: ActOutcome = { ok: true };
  constructor(backend: Target['backend'] = 'managed', withInput = true) {
    super(pages);
    this.backend = backend;
    if (!withInput) (this as { panelInput?: unknown }).panelInput = undefined;
  }
  screencast(
    opts: ScreencastOptions,
    onFrame: (data: string, meta: ScreencastFrameMeta) => void,
  ): Promise<ScreencastHandle> {
    this.casts.push(opts);
    this.open += 1;
    this.emit = onFrame;
    let stopped = false;
    return Promise.resolve({
      stop: () => {
        if (!stopped) {
          stopped = true;
          this.open -= 1;
        }
        return Promise.resolve();
      },
    });
  }
  location(): Promise<{ url: string; title: string }> {
    return Promise.resolve({ url: 'https://shop.test/catalogue/a', title: 'A book' });
  }
  panelInput(input: PanelInput): Promise<ActOutcome> {
    this.inputs.push(input);
    return Promise.resolve(this.panelOutcome);
  }
}

const frameOf = (target: PanelTarget, bytes = 3_000): void => {
  target.emit?.('A'.repeat(Math.ceil((bytes * 4) / 3)), {
    ts: 1,
    width: 640,
    height: 400,
    pageWidth: 1280,
    pageHeight: 800,
  });
};

describe('panel geometry (the functions the panel itself runs)', () => {
  it('fits the picture inside the box on both sides, centered', () => {
    expect(containRect(1000, 400, 1280, 800)).toEqual({ x: 180, y: 0, width: 640, height: 400 });
    expect(containRect(400, 1000, 1280, 800)).toEqual({ x: 0, y: 375, width: 400, height: 250 });
    expect(containRect(0, 400, 1280, 800)).toEqual({ x: 0, y: 0, width: 0, height: 0 });
  });

  it('maps a point on the picture, and nothing on the letterbox', () => {
    const picture = { x: 180, y: 0, width: 640, height: 400 };
    expect(clientToFrame(500, 100, picture)).toEqual({ nx: 0.5, ny: 0.25 });
    expect(clientToFrame(100, 100, picture)).toBeNull(); // the bar left of the picture
    expect(clientToFrame(900, 100, picture)).toBeNull();
    expect(clientToFrame(500, 401, picture)).toBeNull();
  });

  it('maps a frame fraction to page CSS pixels, clamped inside the page', () => {
    expect(framePoint(0.5, 0.25, { width: 1280, height: 800 })).toEqual({ x: 640, y: 200 });
    expect(framePoint(1, 1, { width: 1280, height: 800 })).toEqual({ x: 1279, y: 799 });
    expect(framePoint(1.2, 0.5, { width: 1280, height: 800 })).toBeNull();
    expect(framePoint(0.5, Number.NaN, { width: 1280, height: 800 })).toBeNull();
  });

  it('the panel embeds these exact functions and declares its three actions', () => {
    expect(WATCH_HTML).toContain(containRect.toString());
    expect(WATCH_HTML).toContain(clientToFrame.toString());
    expect(WATCH_HTML).toContain("call('browser.watch.input'");
    expect(WATCH_HTML).not.toMatch(/https?:\/\/(?!www\.w3\.org)/);
    expect(WATCH_HTML).not.toMatch(/\bfetch\(|WebSocket|XMLHttpRequest|<img /);
    // The page never scrolls as a document.
    expect(WATCH_HTML).toMatch(/html, body \{ height: 100%; margin: 0; overflow: hidden; \}/);
  });

  it("the panel's script compiles (a typo would leave a blank panel)", () => {
    const script = /<script>([\s\S]*)<\/script>/.exec(WATCH_HTML)?.[1] ?? '';
    expect(script.length).toBeGreaterThan(1_000);
    // Compiles only; nothing runs.
    expect(() => new Function(script)).not.toThrow();
  });
});

describe('frame sizing', () => {
  it('asks for the panel size within the limits, the old width before the panel measured', () => {
    expect(streamSize(undefined)).toEqual({ maxWidth: 960, maxHeight: STREAM_LIMITS.maxHeight });
    expect(streamSize({ width: 872, height: 545 })).toEqual({ maxWidth: 872, maxHeight: 545 });
    expect(streamSize({ width: 40, height: 30 })).toEqual({
      maxWidth: STREAM_LIMITS.minWidth,
      maxHeight: STREAM_LIMITS.minHeight,
    });
    expect(streamSize({ width: 5000, height: 4000 })).toEqual({
      maxWidth: STREAM_LIMITS.maxWidth,
      maxHeight: STREAM_LIMITS.maxHeight,
    });
  });

  it('a small resize keeps the screencast; a real one restarts it', () => {
    expect(sizeChanged({ maxWidth: 800, maxHeight: 500 }, { maxWidth: 830, maxHeight: 510 })).toBe(
      false,
    );
    expect(sizeChanged({ maxWidth: 800, maxHeight: 500 }, { maxWidth: 1000, maxHeight: 500 })).toBe(
      true,
    );
  });

  it('the watch screencasts at the panel size and restarts when the panel really changes', async () => {
    const watches = new WatchRegistry(() => 1_000);
    const target = new PanelTarget();
    const id = watches.open({ kind: 'session', sessionId: 's', target: () => target });
    await flush();
    expect(target.casts.at(-1)).toMatchObject({ maxWidth: 960, quality: 80 });
    watches.poll(id, undefined, { width: 872, height: 545 });
    await flush();
    expect(target.casts.at(-1)).toMatchObject({ maxWidth: 872, maxHeight: 545, quality: 80 });
    expect(target.open).toBe(1);
    watches.poll(id, undefined, { width: 880, height: 550 }); // within the slack
    await flush();
    expect(target.casts).toHaveLength(2);
    watches.poll(id, undefined, { width: 1600, height: 1000 });
    await flush();
    expect(target.casts.at(-1)).toMatchObject({ maxWidth: 1600, maxHeight: 1000 });
    expect(target.open).toBe(1);
    await watches.dispose();
  });

  it('a frame over the byte bound lowers the quality of the next screencast', async () => {
    const watches = new WatchRegistry(() => 1_000);
    const target = new PanelTarget();
    const id = watches.open({ kind: 'session', sessionId: 's', target: () => target });
    await flush();
    frameOf(target, FRAME_MAX_BYTES + 10_000);
    watches.poll(id);
    await flush();
    expect(watches.streamSettings(id)).toMatchObject({ quality: 70 });
    expect(target.casts.at(-1)).toMatchObject({ quality: 70 });
    frameOf(target, 50_000);
    watches.poll(id);
    await flush();
    expect(watches.streamSettings(id)).toMatchObject({ quality: 70 }); // a normal frame keeps it
    await watches.dispose();
  });

  it('the hub passes height and quality, and restarts for a better quality', async () => {
    const sent: { method: string; params: Record<string, unknown> }[] = [];
    const channel: ScreencastChannel = {
      closed: false,
      send: (method, params = {}) => {
        sent.push({ method, params: { ...params } });
        return Promise.resolve({});
      },
      onEvent: () => () => undefined,
    };
    const hub = new ScreencastHub(channel, 'S1');
    const first = await hub.subscribe(
      { maxWidth: 872, maxHeight: 545, quality: 80 },
      () => undefined,
    );
    expect(sent[0]?.params).toMatchObject({ maxWidth: 872, maxHeight: 545, quality: 80 });
    // A smaller consumer fits inside the running screencast: no restart. (Without a maxHeight it asks for an
    // unlimited height, more than 545, and the hub restarts.)
    const recorder = await hub.subscribe({ maxWidth: 640, maxHeight: 400 }, () => undefined);
    expect(sent.filter((entry) => entry.method === 'Page.startScreencast')).toHaveLength(1);
    await recorder.stop();
    await first.stop();
    const worse = await hub.subscribe({ maxWidth: 400, quality: 70 }, () => undefined);
    const better = await hub.subscribe({ maxWidth: 400, quality: 90 }, () => undefined);
    const starts = sent.filter((entry) => entry.method === 'Page.startScreencast');
    expect(starts.at(-1)?.params).toMatchObject({ quality: 90 });
    expect(starts.at(-1)?.params['maxHeight']).toBeUndefined(); // no consumer limited the height
    await better.stop();
    await worse.stop();
  });
});

describe('liveness fields', () => {
  it('carries the address, title, last change and the clock, and says it is interactive', async () => {
    let now = 5_000;
    const watches = new WatchRegistry(() => now);
    const target = new PanelTarget();
    const id = watches.open({ kind: 'session', sessionId: 's', target: () => target });
    await flush();
    watches.poll(id);
    await flush();
    frameOf(target);
    now = 17_000;
    const state = watches.poll(id);
    expect(state).toMatchObject({
      ok: true,
      kind: 'session',
      status: 'open',
      url: 'https://shop.test/catalogue/a',
      title: 'A book',
      lastFrameAt: 5_000,
      now: 17_000,
      backend: 'managed',
      interactive: true,
      frame: { pageWidth: 1280, pageHeight: 800 },
    });
    expect(state['viewOnly']).toBeUndefined();
    await watches.dispose();
  });
});

describe('panel input refusals', () => {
  const event = { kind: 'click', nx: 0.5, ny: 0.25 };

  it('maps a click to page pixels and runs it', async () => {
    const watches = new WatchRegistry(() => 1_000);
    const target = new PanelTarget();
    const id = watches.open({ kind: 'session', sessionId: 's', target: () => target });
    await flush();
    expect(await watches.input(id, event)).toMatchObject({ ok: false }); // no frame yet: no page size
    frameOf(target);
    expect(await watches.input(id, event)).toMatchObject({ ok: true });
    expect(target.inputs.at(-1)).toEqual({ kind: 'click', x: 640, y: 200, clickCount: 1 });
    await watches.input(id, { kind: 'wheel', nx: 0.5, ny: 0.5, deltaY: 9_999 });
    expect(target.inputs.at(-1)).toEqual({
      kind: 'wheel',
      x: 640,
      y: 400,
      deltaX: 0,
      deltaY: 3_000,
    });
    await watches.input(id, { kind: 'back' });
    expect(target.actions.at(-1)).toEqual({ kind: 'back' });
    await watches.dispose();
  });

  it("a task's watch is view only", async () => {
    const watches = new WatchRegistry(() => 1_000);
    const registry = new TaskRegistry(() => 1_000);
    const target = new PanelTarget();
    const entry = registry.start('goal', (task) => {
      task.target = target;
      return new Promise(() => undefined);
    });
    await flush();
    const id = watches.open({ kind: 'task', entry });
    await flush();
    frameOf(target);
    expect(watches.poll(id)).toMatchObject({ interactive: false, viewOnly: 'task' });
    expect(await watches.input(id, event)).toMatchObject({
      ok: false,
      status: 'view_only',
      viewOnly: 'task',
    });
    expect(target.inputs).toHaveLength(0);
    await watches.dispose();
  });

  it('a session a task is driving is view only until the task ends', async () => {
    const watches = new WatchRegistry(() => 1_000);
    const target = new PanelTarget();
    let driving: object | null = { id: 'task' };
    const id = watches.open({
      kind: 'session',
      sessionId: 's',
      target: () => target,
      task: () => driving as never,
    });
    await flush();
    frameOf(target);
    expect(await watches.input(id, event)).toMatchObject({ status: 'view_only', viewOnly: 'task' });
    expect(target.inputs).toHaveLength(0);
    driving = null;
    expect(await watches.input(id, event)).toMatchObject({ ok: true });
    await watches.dispose();
  });

  it("the person's own Chrome and an app are view only", async () => {
    for (const backend of ['user', 'app'] as const) {
      const watches = new WatchRegistry(() => 1_000);
      const target = new PanelTarget(backend);
      const id = watches.open({ kind: 'session', sessionId: 's', target: () => target });
      await flush();
      frameOf(target);
      expect(watches.poll(id)).toMatchObject({ interactive: false, viewOnly: backend });
      expect(await watches.input(id, { kind: 'text', text: 'hello' })).toMatchObject({
        status: 'view_only',
        viewOnly: backend,
      });
      expect(await watches.input(id, { kind: 'reload' })).toMatchObject({ status: 'view_only' });
      expect(target.inputs).toHaveLength(0);
      expect(target.actions).toHaveLength(0);
      await watches.dispose();
    }
  });

  it('a closed session and a backend without panel input are view only', async () => {
    const watches = new WatchRegistry(() => 1_000);
    let open = true;
    const target = new PanelTarget();
    const id = watches.open({
      kind: 'session',
      sessionId: 's',
      target: () => (open ? target : null),
    });
    await flush();
    open = false;
    expect(await watches.input(id, event)).toMatchObject({
      status: 'view_only',
      viewOnly: 'closed',
    });
    const bare = new PanelTarget('managed', false);
    const other = watches.open({ kind: 'session', sessionId: 't', target: () => bare });
    expect(await watches.input(other, event)).toMatchObject({ viewOnly: 'unsupported' });
    await watches.dispose();
  });

  it('refuses past the rate limit', async () => {
    let now = 1_000;
    const watches = new WatchRegistry(() => now);
    const target = new PanelTarget();
    const id = watches.open({ kind: 'session', sessionId: 's', target: () => target });
    await flush();
    frameOf(target);
    for (let index = 0; index < INPUT_RATE; index += 1)
      expect(await watches.input(id, event)).toMatchObject({ ok: true });
    expect(await watches.input(id, event)).toMatchObject({ ok: false, status: 'rate_limited' });
    expect(target.inputs).toHaveLength(INPUT_RATE);
    now += 1_001;
    expect(await watches.input(id, event)).toMatchObject({ ok: true });
    await watches.dispose();
  });

  it('a secret-field refusal from the tab is passed on as status secret_field', async () => {
    const watches = new WatchRegistry(() => 1_000);
    const target = new PanelTarget();
    target.panelOutcome = { ok: false, error: 'secret-field: a password field has focus' };
    const id = watches.open({ kind: 'session', sessionId: 's', target: () => target });
    await flush();
    expect(await watches.input(id, { kind: 'text', text: 'x' })).toMatchObject({
      ok: false,
      status: 'secret_field',
    });
    await watches.dispose();
  });

  it('checks the input itself: printable text only, named keys only, points on the frame', () => {
    expect(parsePanelEvent({ kind: 'text', text: 'abc' })).toEqual({ kind: 'text', text: 'abc' });
    expect(typeof parsePanelEvent({ kind: 'text', text: 'a\nb' })).toBe('string');
    expect(typeof parsePanelEvent({ kind: 'text', text: '\u0008' })).toBe('string');
    expect(typeof parsePanelEvent({ kind: 'text', text: 'x'.repeat(65) })).toBe('string');
    expect(typeof parsePanelEvent({ kind: 'key', key: 'v', modifiers: ['Meta'] })).toBe('string');
    expect(typeof parsePanelEvent({ kind: 'key', key: 'Enter', modifiers: ['Hyper'] })).toBe(
      'string',
    );
    expect(parsePanelEvent({ kind: 'key', key: 'Tab', modifiers: ['Shift'] })).toEqual({
      kind: 'key',
      key: 'Tab',
      modifiers: ['Shift'],
    });
    expect(typeof parsePanelEvent({ kind: 'click', nx: 1.5, ny: 0 })).toBe('string');
    expect(typeof parsePanelEvent({ kind: 'navigate', url: 'http://169.254.169.254/' })).toBe(
      'string',
    );
  });

  it('browser.watch.input reaches the registry through the lifecycle, with bad input refused', async () => {
    const target = new PanelTarget();
    const lifecycle = new Lifecycle({ sessionTarget: () => target, artifactRoot: () => '/tmp' });
    const opened = await lifecycle.invoke('browser.watch', { sessionId: 's', open: false });
    const watchId = String(opened['watchId']);
    await flush();
    frameOf(target);
    expect(
      await lifecycle.invoke('browser.watch.input', {
        watchId,
        event: { kind: 'click', nx: 0.25, ny: 0.5 },
      }),
    ).toMatchObject({ ok: true });
    expect(target.inputs.at(-1)).toEqual({ kind: 'click', x: 320, y: 400, clickCount: 1 });
    await expect(
      lifecycle.invoke('browser.watch.input', { watchId, event: { kind: 'text', text: '' } }),
    ).rejects.toThrow('BROWSER_BAD_INPUT');
    const polled = await lifecycle.invoke('browser.watch.frame', {
      watchId,
      view: { width: 700, height: 420 },
    });
    expect(polled).toMatchObject({ ok: true, interactive: true });
    await flush();
    expect(target.casts.at(-1)).toMatchObject({ maxWidth: 700, maxHeight: 420 });
    await lifecycle.dispose();
  });
});
