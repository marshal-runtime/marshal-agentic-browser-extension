/**
 * A panel opened or re-mounted after its task finished shows the task's last picture with the end status, not
 * "Waiting for the first frame" forever: the newest live frame a watch saw (kept on the task), else the end picture
 * taken before the tab closed, else the task's final screenshot file. Guards mutated by
 * scripts/mutate-session-guards.mjs.
 */
import { mkdtemp, rm, truncate, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type {
  ScreencastFrameMeta,
  ScreencastHandle,
  ScreencastOptions,
  ScreenshotOptions,
  Shot,
} from '../src/target.js';
import {
  keepEndPicture,
  KEPT_FRAME_MAX_BYTES,
  TaskRegistry,
  type TaskEntry,
} from '../src/tasks.js';
import { finalScreenshot, WatchRegistry } from '../src/watch/watches.js';
import { FakeTarget, page } from './helpers.js';

const flush = async (): Promise<void> => {
  for (let index = 0; index < 10; index += 1) await new Promise((resolve) => setImmediate(resolve));
};

/** The smallest JPEG header jpegSize reads: SOI and a baseline SOF0 with the size. */
function jpeg(width: number, height: number, pad = 0): string {
  const sof = [0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 255, width >> 8, width & 255, 3];
  return Buffer.from([0xff, 0xd8, ...sof, ...new Array<number>(8 + pad).fill(0)]).toString(
    'base64',
  );
}

/** A PNG signature and IHDR with the size. */
function png(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(40);
  bytes.writeUInt32BE(0x89504e47, 0);
  bytes.writeUInt32BE(0x0d0a1a0a, 4);
  bytes.writeUInt32BE(13, 8);
  bytes.write('IHDR', 12, 'ascii');
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

class CastTarget extends FakeTarget {
  emit: ((data: string, meta: ScreencastFrameMeta) => void) | null = null;
  shot: Shot | Error | 'hang' = { data: jpeg(1280, 800), mimeType: 'image/jpeg' };
  readonly shotOptions: ScreenshotOptions[] = [];
  constructor() {
    super([page('https://shop.test/', [])]);
  }
  screencast(
    _opts: ScreencastOptions,
    onFrame: (data: string, meta: ScreencastFrameMeta) => void,
  ): Promise<ScreencastHandle> {
    this.emit = onFrame;
    return Promise.resolve({ stop: () => Promise.resolve() });
  }
  override screenshot(options: ScreenshotOptions = {}): Promise<Shot> {
    this.shotOptions.push(options);
    if (this.shot === 'hang') return new Promise(() => undefined);
    return this.shot instanceof Error ? Promise.reject(this.shot) : Promise.resolve(this.shot);
  }
}

/** A task that ends when `end` is called, with the output given. */
async function task(
  registry: TaskRegistry,
  target?: CastTarget,
): Promise<{ entry: TaskEntry; end: (output?: Record<string, unknown>) => Promise<void> }> {
  let end: (output: Record<string, unknown>) => void = () => undefined;
  const entry = registry.start('find the travel books', (running) => {
    if (target) running.target = target;
    return new Promise((resolve) => (end = resolve));
  });
  await flush();
  return {
    entry,
    end: async (output: Record<string, unknown> = { ok: true, status: 'done', artifacts: [] }) => {
      end(output);
      await entry.done;
    },
  };
}

const dirs: string[] = [];
afterAll(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});
async function tmp(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'mb-watch-final-'));
  dirs.push(dir);
  return dir;
}

describe('a finished task keeps its last picture for the panel', () => {
  it('the newest live frame is kept on the task, and a panel opened after the end shows it with Done', async () => {
    const registry = new TaskRegistry(() => 5_000);
    const watches = new WatchRegistry(() => 5_000);
    const target = new CastTarget();
    const { entry, end } = await task(registry, target);
    const live = watches.open({ kind: 'task', entry });
    watches.poll(live);
    await flush();
    const data = jpeg(900, 560);
    target.emit?.(data, { ts: 1, width: 900, height: 560 });
    expect(entry.lastFrame).toMatchObject({ data, width: 900, height: 560 });
    await end();
    await watches.close(live);

    // The panel re-mounts: a new watch of the finished task.
    const later = watches.open({ kind: 'task', entry });
    const state = watches.poll(later);
    expect(state).toMatchObject({
      ok: true,
      state: 'finished',
      status: 'done',
      frame: { data, width: 900, height: 560, mimeType: 'image/jpeg', final: true },
    });
    await watches.dispose();
  });

  it('a live panel moves to the clean end picture once the task ends', async () => {
    let now = 5_000;
    const registry = new TaskRegistry(() => now);
    const watches = new WatchRegistry(() => now);
    const target = new CastTarget();
    const { entry, end } = await task(registry, target);
    const id = watches.open({ kind: 'task', entry });
    watches.poll(id);
    await flush();
    const marked = jpeg(900, 560);
    target.emit?.(marked, { ts: 1, width: 900, height: 560 });
    expect(watches.poll(id)).toMatchObject({ frame: { data: marked } });
    // The end picture is taken after the last live frame, then the task ends.
    now = 6_000;
    const clean = jpeg(1280, 800);
    entry.lastFrame = { data: clean, width: 1280, height: 800, bytes: 30, at: 6_000 };
    await end();
    const after = watches.poll(id);
    expect(after).toMatchObject({
      status: 'done',
      frame: { data: clean, width: 1280, final: true },
    });
    const seq = (after as { seq: number }).seq;
    // It moves once: the next poll since that seq carries no frame again.
    expect(watches.poll(id, seq)).not.toHaveProperty('frame');
    await watches.dispose();
  });

  it('a frame over the bound is not kept on the task', async () => {
    const registry = new TaskRegistry(() => 5_000);
    const watches = new WatchRegistry(() => 5_000);
    const target = new CastTarget();
    const { entry } = await task(registry, target);
    watches.poll(watches.open({ kind: 'task', entry }));
    await flush();
    target.emit?.('A'.repeat(Math.ceil(((KEPT_FRAME_MAX_BYTES + 10) * 4) / 3)), {
      ts: 1,
      width: 1920,
      height: 1200,
    });
    expect(entry.lastFrame).toBeNull();
    await watches.dispose();
  });

  it('a re-mounted panel of a running task shows the kept frame at once, not marked final', async () => {
    const registry = new TaskRegistry(() => 5_000);
    const watches = new WatchRegistry(() => 5_000);
    const { entry } = await task(registry);
    entry.lastFrame = { data: jpeg(640, 400), width: 640, height: 400, bytes: 26, at: 4_000 };
    const state = watches.poll(watches.open({ kind: 'task', entry }));
    expect(state).toMatchObject({ state: 'running', frame: { width: 640, height: 400 } });
    expect((state as { frame: Record<string, unknown> }).frame).not.toHaveProperty('final');
    await watches.dispose();
  });

  it('with no kept frame, a finished task falls back to its final screenshot file (PNG size from IHDR)', async () => {
    const dir = await tmp();
    const file = path.join(dir, 'final.png');
    await writeFile(file, png(1280, 800));
    const registry = new TaskRegistry(() => 5_000);
    const watches = new WatchRegistry(() => 5_000);
    const { entry, end } = await task(registry);
    await end({
      ok: true,
      status: 'blocked',
      artifacts: [
        { kind: 'screenshot', label: 'step-1', path: path.join(dir, 'missing.png') },
        { kind: 'screenshot', label: 'final', path: file },
      ],
    });
    const id = watches.open({ kind: 'task', entry });
    expect(watches.poll(id)).not.toHaveProperty('frame');
    // The file is read in the background; the panel polls again until it is there.
    let state = watches.poll(id);
    for (let tries = 0; tries < 100 && !('frame' in state); tries += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      state = watches.poll(id);
    }
    expect(state).toMatchObject({
      status: 'blocked',
      frame: { mimeType: 'image/png', width: 1280, height: 800, final: true },
    });
    await watches.dispose();
  });

  it('a missing, oversized or non-image file gives no picture (the end status alone)', async () => {
    const dir = await tmp();
    const big = path.join(dir, 'big.png');
    await writeFile(big, png(10, 10));
    await truncate(big, 4_000_001);
    const text = path.join(dir, 'note.png');
    await writeFile(text, 'not an image at all, just words');
    for (const file of [path.join(dir, 'gone.png'), big, text, dir]) {
      const registry = new TaskRegistry(() => 5_000);
      const watches = new WatchRegistry(() => 5_000);
      const { entry, end } = await task(registry);
      await end({
        ok: true,
        status: 'done',
        artifacts: [{ kind: 'screenshot', label: 'final', path: file }],
      });
      const id = watches.open({ kind: 'task', entry });
      watches.poll(id);
      // Long enough for a 4 MB read to finish, so an absent picture is a refusal, not a slow read.
      await new Promise((resolve) => setTimeout(resolve, 400));
      await flush();
      expect(watches.poll(id), file).toMatchObject({ status: 'done' });
      expect(watches.poll(id), file).not.toHaveProperty('frame');
      await watches.dispose();
    }
  });

  it('finalScreenshot prefers the final label, else the last screenshot, and ignores videos', () => {
    expect(
      finalScreenshot({
        artifacts: [
          { kind: 'screenshot', label: 'final', path: '/a.png' },
          { kind: 'screenshot', label: 'step-2', path: '/b.png' },
        ],
      }),
    ).toBe('/a.png');
    expect(
      finalScreenshot({
        artifacts: [
          { kind: 'screenshot', label: 'step-1', path: '/a.png' },
          { kind: 'screenshot', label: 'step-2', path: '/b.png' },
          { kind: 'video', label: 'session', path: '/c.webm' },
        ],
      }),
    ).toBe('/b.png');
    expect(finalScreenshot({ artifacts: [{ kind: 'video', path: '/c.webm' }] })).toBeNull();
    expect(finalScreenshot(null)).toBeNull();
  });
});

describe('keepEndPicture: one clean JPEG before the tab closes', () => {
  const entryOf = async (): Promise<TaskEntry> => (await task(new TaskRegistry(() => 1))).entry;

  it('keeps a bounded JPEG of the page', async () => {
    const entry = await entryOf();
    const target = new CastTarget();
    await keepEndPicture(entry, target, () => 7_000);
    expect(target.shotOptions).toEqual([{ format: 'jpeg', width: 1280, quality: 70 }]);
    expect(entry.lastFrame).toMatchObject({ width: 1280, height: 800, at: 7_000 });
  });

  it('replaces the live frame a watch kept (it can carry the decision marks)', async () => {
    const entry = await entryOf();
    entry.lastFrame = { data: jpeg(10, 10), width: 10, height: 10, bytes: 26, at: 1 };
    await keepEndPicture(entry, new CastTarget(), () => 7_000);
    expect(entry.lastFrame).toMatchObject({ width: 1280, height: 800, at: 7_000 });
  });

  it('a dead page, a hung capture, a non-JPEG or an oversized picture keeps what was there', async () => {
    const cases: CastTarget['shot'][] = [
      new Error('Target closed'),
      'hang',
      { data: png(10, 10).toString('base64'), mimeType: 'image/png' },
      { data: jpeg(1280, 800, KEPT_FRAME_MAX_BYTES), mimeType: 'image/jpeg' },
      { data: 'AAAA', mimeType: 'image/jpeg' },
    ];
    const live = { data: jpeg(10, 10), width: 10, height: 10, bytes: 26, at: 1 };
    for (const shot of cases)
      for (const before of [null, live]) {
        const entry = await entryOf();
        entry.lastFrame = before;
        const target = new CastTarget();
        target.shot = shot;
        const started = Date.now();
        await keepEndPicture(entry, target);
        expect(entry.lastFrame, String(shot)).toBe(before);
        expect(Date.now() - started).toBeLessThan(2_500);
      }
  });
});
