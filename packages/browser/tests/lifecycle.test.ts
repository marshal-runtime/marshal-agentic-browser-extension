/**
 * Part E units: cancel at every point of the step engine, the task registry, the screencast hub over a fake CDP
 * channel (one Chrome screencast per tab, acked frames, no listener left after the last stop), the watch registry's
 * consume-only screencast, the recorder's typed `recorder_unavailable`, and the watch panel's declared actions.
 */
import { describe, expect, it } from 'vitest';
import { BrowserService } from '../src/capabilities.js';
import type { CdpEvent } from '../src/chrome/cdp.js';
import { jpegSize, ScreencastHub, type ScreencastChannel } from '../src/chrome/screencast.js';
import type { Decider } from '../src/engine/decider.js';
import { runTask, type TaskPhase } from '../src/engine/task.js';
import { Lifecycle } from '../src/lifecycle.js';
import {
  ffmpegCandidates,
  findFfmpeg,
  Recorder,
  RecorderUnavailable,
} from '../src/record/recorder.js';
import { TaskRegistry } from '../src/tasks.js';
import type {
  ScreencastFrameMeta,
  ScreencastHandle,
  ScreencastOptions,
  Target,
} from '../src/target.js';
import { createWatchApplication, WATCH_HTML } from '../src/watch/app.js';
import { WatchRegistry } from '../src/watch/watches.js';
import { el, FakeDecider, FakeTarget, page, saveShot } from './helpers.js';

const START = 'https://shop.example/';
const pages = [page(START, [el('e1', { label: 'Next', tag: 'button', role: 'button' })])];

/** A decider whose judge() waits until released (or forever), to cancel mid-decision. */
class HeldDecider extends FakeDecider {
  release: () => void = () => undefined;
  readonly started: Promise<void>;
  private markStarted: () => void = () => undefined;
  constructor() {
    super([{ choice: 'click e1' }]);
    this.started = new Promise((resolve) => {
      this.markStarted = resolve;
    });
  }
  override judge(input: Parameters<Decider['judge']>[0]): ReturnType<Decider['judge']> {
    this.markStarted();
    return new Promise((resolve) => {
      this.release = () => {
        resolve(super.judge(input));
      };
    });
  }
}

describe('cancel at each point of a task', () => {
  it('already cancelled: no navigation, no action, status cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    const target = new FakeTarget(pages);
    const result = await runTask(
      {
        target,
        decider: new FakeDecider([{ choice: 'click e1' }]),
        saveShot,
        signal: controller.signal,
      },
      { goal: 'press next', startUrl: START },
    );
    expect(result.status).toBe('cancelled');
    expect(result.reason).toBe('cancelled_by_caller');
    expect(target.actions).toEqual([]);
  });

  it('while navigating: the navigation is abandoned and nothing else runs', async () => {
    const controller = new AbortController();
    let navigating: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      navigating = resolve;
    });
    const target = new FakeTarget(pages);
    target.act = (action) => {
      target.actions.push(action);
      navigating();
      return new Promise(() => undefined); // a navigation that never ends
    };
    const decider = new FakeDecider([{ choice: 'click e1' }]);
    const running = runTask(
      { target, decider, saveShot, signal: controller.signal },
      { goal: 'press next', startUrl: START },
    );
    await started;
    controller.abort();
    const result = await running;
    expect(result.status).toBe('cancelled');
    expect(target.actions.map((action) => action.kind)).toEqual(['navigate']);
    expect(decider.judged).toHaveLength(0);
  });

  it('mid-decision: the task ends at once, without waiting for the decision', async () => {
    const controller = new AbortController();
    const decider = new HeldDecider();
    const target = new FakeTarget(pages);
    const running = runTask(
      { target, decider, saveShot, signal: controller.signal },
      { goal: 'press next', startUrl: START },
    );
    await decider.started;
    controller.abort(); // the decision never answers
    const result = await running;
    expect(result.status).toBe('cancelled');
    expect(target.actions.map((action) => action.kind)).toEqual(['navigate']);
  }, 5_000);

  it('mid-decision: an answer that arrives after the cancel is never acted on', async () => {
    const controller = new AbortController();
    const decider = new HeldDecider();
    const target = new FakeTarget(pages);
    const running = runTask(
      { target, decider, saveShot, signal: controller.signal },
      { goal: 'press next', startUrl: START },
    );
    await decider.started;
    controller.abort();
    decider.release();
    const result = await running;
    expect(result.status).toBe('cancelled');
    expect(target.actions.map((action) => action.kind)).toEqual(['navigate']);
  });

  it('an answer and a cancel in the same tick: the cancel wins before acting', async () => {
    const controller = new AbortController();
    const target = new FakeTarget(pages);
    const decider = new FakeDecider([{ choice: 'click e1' }]);
    const original = decider.judge.bind(decider);
    decider.judge = (input) => {
      const answer = original(input);
      // Runs before the engine sees the answer, but after the answer is already settled.
      void answer.then(() => controller.abort());
      return answer;
    };
    const result = await runTask(
      { target, decider, saveShot, signal: controller.signal },
      { goal: 'press next', startUrl: START },
    );
    expect(result.status).toBe('cancelled');
    expect(target.actions.map((action) => action.kind)).toEqual(['navigate']);
  });

  it('between the decision and the action: no action', async () => {
    const controller = new AbortController();
    const target = new FakeTarget(pages);
    const decider = new FakeDecider([{ choice: 'click e1' }]);
    const original = decider.judge.bind(decider);
    decider.judge = async (input) => {
      const answer = await original(input);
      controller.abort(); // the cancel lands while the answer is on its way back
      return answer;
    };
    const result = await runTask(
      { target, decider, saveShot, signal: controller.signal },
      { goal: 'press next', startUrl: START },
    );
    expect(result.status).toBe('cancelled');
    expect(target.actions.map((action) => action.kind)).toEqual(['navigate']);
  });

  it('during an action: that action ends, then the task stops before the next one', async () => {
    const controller = new AbortController();
    const target = new FakeTarget(pages);
    const act = target.act.bind(target);
    target.act = async (action) => {
      const outcome = await act(action);
      if (action.kind === 'click') controller.abort();
      return outcome;
    };
    const decider = new FakeDecider([{ choice: 'click e1' }]);
    const result = await runTask(
      { target, decider, saveShot, signal: controller.signal },
      { goal: 'press next', startUrl: START },
    );
    expect(result.status).toBe('cancelled');
    expect(target.actions.map((action) => action.kind)).toEqual(['navigate', 'click']);
    expect(decider.judged).toHaveLength(1);
    expect(result.trace.at(-1)?.note).toBe('cancelled after this action');
  });

  it('while waiting for a page that is not ready: the wait ends at once', async () => {
    const controller = new AbortController();
    const target = new FakeTarget(pages);
    const decider = new FakeDecider([{ choice: 'click e1', pageReady: 0.05 }]);
    const phases: TaskPhase[] = [];
    const running = runTask(
      {
        target,
        decider,
        saveShot,
        signal: controller.signal,
        sleep: () => new Promise(() => undefined), // a wait that would never end on its own
        onPhase: (phase) => {
          phases.push(phase);
          if (phase === 'waiting') controller.abort();
        },
      },
      { goal: 'press next', startUrl: START },
    );
    const result = await running;
    expect(result.status).toBe('cancelled');
    expect(phases).toContain('waiting');
    expect(target.actions.map((action) => action.kind)).toEqual(['navigate']);
  });

  it('reports each trace step and phase as it happens', async () => {
    const steps: string[] = [];
    const phases: TaskPhase[] = [];
    const result = await runTask(
      {
        target: new FakeTarget(pages),
        decider: new FakeDecider([{ choice: 'click e1' }, { choice: 'done', goalMet: 0.95 }]),
        saveShot,
        onTrace: (step) => steps.push(step.action),
        onPhase: (phase) => phases.push(phase),
      },
      { goal: 'press next', startUrl: START },
    );
    expect(result.status).toBe('done');
    expect(steps).toEqual(result.trace.map((step) => step.action));
    expect(phases).toEqual(expect.arrayContaining(['navigating', 'reading', 'deciding', 'acting']));
  });
});

describe('task registry', () => {
  it('runs in the background, reports progress, and cancel waits for the cancelled end', async () => {
    const registry = new TaskRegistry();
    let seen: AbortSignal | null = null;
    const entry = registry.start('a goal', (task) => {
      seen = task.controller.signal;
      return new Promise((resolve) => {
        task.controller.signal.addEventListener('abort', () => {
          resolve({ ok: true, taskId: task.id, status: 'cancelled' });
        });
      });
    });
    await Promise.resolve();
    expect(registry.get(entry.id)?.state).toBe('running');
    expect(registry.list()[0]?.id).toBe(entry.id);
    const outcome = await registry.cancel(entry.id);
    expect(seen).not.toBeNull();
    expect(outcome).toMatchObject({ found: true, wasRunning: true, settled: true });
    expect(entry.state).toBe('finished');
    expect(entry.output?.['status']).toBe('cancelled');
  });

  it('a finished task is left unchanged by cancel', async () => {
    const registry = new TaskRegistry();
    const entry = registry.start('a goal', (task) =>
      Promise.resolve({ ok: true, taskId: task.id, status: 'done' }),
    );
    await entry.done;
    const outcome = await registry.cancel(entry.id);
    expect(outcome).toMatchObject({ found: true, wasRunning: false });
    expect(entry.output?.['status']).toBe('done');
    expect(entry.controller.signal.aborted).toBe(false);
    expect(await registry.cancel('nope')).toEqual({ found: false });
  });

  it('a failing task ends as finished with its error', async () => {
    const registry = new TaskRegistry();
    const entry = registry.start('a goal', () => Promise.reject(new Error('boom')));
    const output = await entry.done;
    expect(output).toMatchObject({ ok: false, error: 'boom' });
    expect(entry.state).toBe('finished');
  });
});

/** A fake CDP channel that records commands and lets the test emit events. */
class FakeChannel implements ScreencastChannel {
  readonly sent: { method: string; params: Record<string, unknown>; sessionId?: string }[] = [];
  readonly listeners = new Set<(event: CdpEvent) => void>();
  closed = false;
  failStart = false;
  send(
    method: string,
    params: Readonly<Record<string, unknown>> = {},
    sessionId?: string,
  ): Promise<Record<string, unknown>> {
    this.sent.push({ method, params: { ...params }, ...(sessionId ? { sessionId } : {}) });
    if (method === 'Page.startScreencast' && this.failStart)
      return Promise.reject(new Error('refused'));
    return Promise.resolve({});
  }
  onEvent(listener: (event: CdpEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  emit(event: CdpEvent): void {
    for (const listener of [...this.listeners]) listener(event);
  }
  count(method: string): number {
    return this.sent.filter((entry) => entry.method === method).length;
  }
}

// A 1x1 baseline JPEG header (SOF0 says 320x200) followed by filler: enough for jpegSize.
const JPEG = Buffer.from(
  'ffd8ffe000104a46494600010100000100010000ffc000110800c8014003012200021101031101ffd9',
  'hex',
).toString('base64');

const frame = (sessionId: string, n: number): CdpEvent => ({
  method: 'Page.screencastFrame',
  sessionId,
  params: {
    data: JPEG,
    sessionId: n,
    metadata: { timestamp: 1_700_000_000 + n, deviceWidth: 1280, deviceHeight: 800 },
  },
});

describe('screencast hub', () => {
  it('one Chrome screencast for many consumers, every frame acked, nothing left after the last stop', async () => {
    const channel = new FakeChannel();
    const hub = new ScreencastHub(channel, 'S1');
    const a: ScreencastFrameMeta[] = [];
    const b: ScreencastFrameMeta[] = [];
    const first = await hub.subscribe({ maxWidth: 640 }, (_data, meta) => a.push(meta));
    const second = await hub.subscribe({ maxWidth: 480 }, (_data, meta) => b.push(meta));
    expect(channel.count('Page.startScreencast')).toBe(1);
    expect(channel.sent[0]).toMatchObject({
      sessionId: 'S1',
      params: { format: 'jpeg', maxWidth: 640 },
    });
    channel.emit(frame('S1', 7));
    channel.emit(frame('OTHER', 8)); // another tab's frame is ignored
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    expect(a[0]).toEqual({ ts: 1_700_000_007_000, width: 320, height: 200 });
    expect(
      channel.sent
        .filter((entry) => entry.method === 'Page.screencastFrameAck')
        .map((entry) => entry.params['sessionId']),
    ).toEqual([7]);
    await first.stop();
    expect(channel.count('Page.stopScreencast')).toBe(0);
    expect(hub.active).toBe(true);
    await second.stop();
    await second.stop(); // idempotent
    expect(channel.count('Page.stopScreencast')).toBe(1);
    expect(hub.active).toBe(false);
    expect(channel.listeners.size).toBe(0);
    channel.emit(frame('S1', 9));
    expect(a).toHaveLength(1);
  });

  it('restarts wider when a consumer needs bigger frames', async () => {
    const channel = new FakeChannel();
    const hub = new ScreencastHub(channel, 'S1');
    const small = await hub.subscribe({ maxWidth: 400 }, () => undefined);
    const large = await hub.subscribe({ maxWidth: 1280 }, () => undefined);
    expect(channel.sent.map((entry) => entry.method)).toEqual([
      'Page.startScreencast',
      'Page.stopScreencast',
      'Page.startScreencast',
    ]);
    expect(channel.sent[2]?.params['maxWidth']).toBe(1280);
    await small.stop();
    await large.stop();
    expect(channel.listeners.size).toBe(0);
  });

  it('a refused start leaves no listener and no consumer', async () => {
    const channel = new FakeChannel();
    channel.failStart = true;
    const hub = new ScreencastHub(channel, 'S1');
    await expect(hub.subscribe({ maxWidth: 640 }, () => undefined)).rejects.toThrow(
      'BROWSER_SCREENCAST_FAILED',
    );
    expect(channel.listeners.size).toBe(0);
    expect(hub.consumerCount).toBe(0);
    expect(hub.active).toBe(false);
  });

  it('dispose stops the screencast for every consumer', async () => {
    const channel = new FakeChannel();
    const hub = new ScreencastHub(channel, 'S1');
    await hub.subscribe({ maxWidth: 640 }, () => undefined);
    await hub.dispose();
    expect(channel.count('Page.stopScreencast')).toBe(1);
    expect(channel.listeners.size).toBe(0);
  });

  it('reads JPEG sizes and refuses non-JPEG data', () => {
    expect(jpegSize(JPEG)).toEqual({ width: 320, height: 200 });
    expect(jpegSize(Buffer.from('not a jpeg').toString('base64'))).toBeNull();
  });
});

/** A target with a fake screencast that counts open handles. */
class CastTarget extends FakeTarget {
  open = 0;
  emit: ((data: string, meta: ScreencastFrameMeta) => void) | null = null;
  screencast(
    _opts: ScreencastOptions,
    onFrame: (data: string, meta: ScreencastFrameMeta) => void,
  ): Promise<ScreencastHandle> {
    this.open += 1;
    this.emit = onFrame;
    let stopped = false;
    return Promise.resolve({
      stop: () => {
        if (!stopped) {
          stopped = true;
          this.open -= 1;
          this.emit = null;
        }
        return Promise.resolve();
      },
    });
  }
}

describe('watch registry', () => {
  it('screencasts only while polled, and stops when the task ends', async () => {
    let now = 1_000;
    const watches = new WatchRegistry(() => now);
    const target = new CastTarget(pages);
    const registry = new TaskRegistry(() => now);
    let finish: (value: Record<string, unknown>) => void = () => undefined;
    const entry = registry.start('watch me', (task) => {
      task.target = target;
      return new Promise((resolve) => {
        finish = resolve;
      });
    });
    await Promise.resolve();
    await Promise.resolve();
    const id = watches.open({ kind: 'task', entry });
    await Promise.resolve();
    expect(target.open).toBe(1);
    target.emit?.(JPEG, { ts: 5, width: 320, height: 200 });
    const first = watches.poll(id);
    expect(first).toMatchObject({
      ok: true,
      state: 'running',
      seq: 1,
      frame: { mimeType: 'image/jpeg', width: 320 },
    });
    expect(watches.poll(id, 1)['frame']).toBeUndefined(); // nothing newer than seq 1

    now += 20_000; // nobody polled for 20 s
    await watches.check();
    expect(target.open).toBe(0);
    watches.poll(id); // the panel is back: the screencast restarts
    await Promise.resolve();
    expect(target.open).toBe(1);

    finish({ ok: true, taskId: entry.id, status: 'done' });
    await entry.done;
    await watches.check();
    expect(target.open).toBe(0);
    expect(watches.poll(id)).toMatchObject({
      ok: true,
      state: 'finished',
      status: 'done',
      frame: { width: 320 },
    });
    expect(await watches.close(id)).toBe(true);
    expect(watches.poll(id)).toMatchObject({ ok: false });
    await watches.dispose();
  });
});

describe('recorder', () => {
  const none = { systemDirs: [] as string[], home: '/nonexistent-home', env: {} };

  it('finds no ffmpeg when none exists, and says so', async () => {
    expect(ffmpegCandidates(none)).toEqual([]);
    const lookup = await findFfmpeg(none);
    expect(lookup.ok).toBe(false);
  });

  it('an unrunnable ffmpeg is not accepted', async () => {
    const lookup = await findFfmpeg({ ...none, ffmpegPath: '/bin/false' });
    expect(lookup).toMatchObject({ ok: false });
  });

  it('refuses to start with a typed recorder_unavailable', async () => {
    const recorder = new Recorder(none);
    const error = await recorder
      .start(new CastTarget(pages), '/tmp/never.mp4')
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RecorderUnavailable);
    expect((error as Error).message).toMatch(/^recorder_unavailable: /);
  });

  it('browser.session.record.start returns status recorder_unavailable', async () => {
    const target = new CastTarget(pages);
    const lifecycle = new Lifecycle({ sessionTarget: () => target, artifactRoot: () => '/tmp' });
    (lifecycle as unknown as { recorder: Recorder }).recorder = new Recorder(none);
    const output = await lifecycle.invoke('browser.session.record.start', { sessionId: 's' });
    expect(output).toMatchObject({ ok: false, status: 'recorder_unavailable' });
    expect(target.open).toBe(0);
    await lifecycle.dispose();
  });

  it('browser.task with want.video refuses before opening any browser', async () => {
    const service = new BrowserService(() => new FakeDecider([{ choice: 'done' }]), {
      chromePath: '/nonexistent/chrome',
    });
    (service.lifecycle as unknown as { recorder: Recorder }).recorder = new Recorder(none);
    const { output } = await service.invoke('browser.task', {
      goal: 'record this',
      startUrl: START,
      want: { video: true },
    });
    expect(output).toMatchObject({ ok: false, status: 'recorder_unavailable' });
    expect(service.lifecycle.tasks.list()).toHaveLength(0);
    await service.dispose();
  });
});

describe('watch panel application', () => {
  it('declares only the frame poll and the cancel as actions, for phone and desktop', () => {
    const app = createWatchApplication() as {
      id: string;
      application: { actions: { id: string; target: { capability: string } }[] };
      metadata: Record<string, unknown>;
    };
    expect(app.id).toBe('watch');
    expect(app.application.actions.map((action) => action.target.capability)).toEqual([
      'browser.watch.frame',
      'browser.task.cancel',
    ]);
    expect(app.application.actions.every((action) => !action.id.includes('.'))).toBe(true);
    expect(app.metadata['marshal.ui.viewports']).toEqual(['mobile', 'desktop']);
  });

  it('loads nothing from the network', () => {
    expect(WATCH_HTML).not.toMatch(/https?:\/\//);
    expect(WATCH_HTML).not.toMatch(/\bfetch\(|WebSocket|XMLHttpRequest|<img /);
    expect(WATCH_HTML).toContain("call('browser.task.cancel'");
  });

  it('browser.watch on an unknown task opens nothing', async () => {
    const lifecycle = new Lifecycle({ sessionTarget: () => null, artifactRoot: () => '/tmp' });
    expect(await lifecycle.invoke('browser.watch', { taskId: 'nope' })).toMatchObject({
      ok: false,
    });
    await expect(lifecycle.invoke('browser.watch', {})).rejects.toThrow('BROWSER_BAD_INPUT');
    await lifecycle.dispose();
  });

  it('browser.watch asks the host to open the side panel with the watch id', async () => {
    const calls: { target: string; input: Record<string, unknown> }[] = [];
    const target = new CastTarget(pages);
    const lifecycle = new Lifecycle({
      sessionTarget: () => target,
      artifactRoot: () => '/tmp',
      execute: (request) => {
        calls.push({ target: request.target, input: request.input as Record<string, unknown> });
        return Promise.resolve({
          protocolVersion: '1.0.0',
          status: 'success',
          result: { output: { ok: true, value: { instance: { instanceId: 'inst-1' } } } },
        });
      },
    });
    const output = await lifecycle.invoke('browser.watch', { sessionId: 's1' });
    expect(output).toMatchObject({ ok: true, opened: true, instanceId: 'inst-1' });
    expect(calls[0]?.target).toBe('ui.application.open');
    expect(calls[0]?.input).toMatchObject({
      extensionId: '@marshal/browser',
      applicationId: 'watch',
      placement: 'side',
      state: { watchId: output['watchId'] },
    });
    await lifecycle.dispose();
    expect(target.open).toBe(0);
  });
});

export type { Target };
