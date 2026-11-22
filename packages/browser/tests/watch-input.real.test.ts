/**
 * The live panel against a real Chrome, through BrowserService.invoke (the capability entry point): frames sized to
 * the panel, the address bar, and the person's input from the panel (click, text, the password refusal, wheel,
 * back). Skipped, with a notice, when no Chrome is installed.
 */
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BrowserService } from '../src/capabilities.js';
import { findChrome } from '../src/chrome/launcher.js';
import { FRAME_MAX_BYTES } from '../src/watch/geometry.js';
import { FakeDecider } from './helpers.js';

const chrome = findChrome();
if (!chrome.path) console.warn(`[watch-input.real] SKIPPED: ${chrome.reason}`);

/** Fields placed at known spots so a click at a frame fraction lands on them (the managed viewport is 1280x800). */
const PAGES: Record<string, string> = {
  '/form': `<!doctype html><title>Panel form</title><style>body{margin:0}input{position:absolute;left:100px;width:400px;height:40px;font-size:20px}</style>
<input id="q" style="top:100px" value=""><input id="pw" type="password" style="top:300px" value="hunter2">`,
  '/tall': `<!doctype html><title>Tall</title><style>body{margin:0}div{height:1000px}</style>${Array.from({ length: 8 }, (_, i) => `<div style="background:rgb(${String(i * 30)},0,${String(255 - i * 30)})"></div>`).join('')}`,
};

let server: http.Server;
let base = '';
let service: BrowserService;

beforeAll(async () => {
  server = http.createServer((request, response) => {
    const body = PAGES[new URL(request.url ?? '/', 'http://x').pathname];
    response.writeHead(body ? 200 : 404, { 'content-type': 'text/html' });
    response.end(body ?? 'not found');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${String((server.address() as { port: number }).port)}`;
  service = new BrowserService(() => new FakeDecider([]), {
    artifactDir: path.join(os.tmpdir(), 'mb-watch-input-real'),
  });
});

afterAll(async () => {
  await service.dispose();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const call = async (
  name: string,
  input: Record<string, unknown>,
): Promise<Record<string, unknown>> =>
  (await service.invoke(name, input)).output as Record<string, unknown>;
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function watchSession(page: string): Promise<{ sessionId: string; watchId: string }> {
  const opened = await call('browser.session.open', { url: `${base}${page}` });
  expect(opened['ok'], JSON.stringify(opened)).toBe(true);
  const sessionId = opened['sessionId'] as string;
  const watched = await call('browser.watch', { sessionId, open: false });
  expect(watched['ok'], JSON.stringify(watched)).toBe(true);
  return { sessionId, watchId: watched['watchId'] as string };
}

/** Polls like the panel until a frame of the asked size arrives. */
async function frameOf(
  watchId: string,
  view: { width: number; height: number },
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 10_000;
  let last: Record<string, unknown> = {};
  while (Date.now() < deadline) {
    last = await call('browser.watch.frame', { watchId, view });
    const frame = last['frame'] as { width: number; height: number } | undefined;
    if (frame && frame.width <= view.width && frame.height <= view.height && last['title'])
      return last;
    await sleep(150);
  }
  throw new Error(`no frame within 10 s: ${JSON.stringify({ ...last, frame: undefined })}`);
}

const value = async (sessionId: string, expression: string): Promise<unknown> =>
  (await call('browser.session.evaluate', { sessionId, expression }))['value'];

describe.skipIf(!chrome.path)('live panel input in a real Chrome', () => {
  it('sizes frames to the panel, shows the address, types into a field and refuses the password field', async () => {
    const { sessionId, watchId } = await watchSession('/form');
    const started = Date.now();
    const state = await frameOf(watchId, { width: 872, height: 545 });
    const frame = state['frame'] as {
      width: number;
      height: number;
      pageWidth: number;
      pageHeight: number;
    };
    console.info(
      `[watch-input.real] first frame ${String(frame.width)}x${String(frame.height)} of page ${String(frame.pageWidth)}x${String(frame.pageHeight)}, ${String(state['frameBytes'])} B at q${String(state['quality'])} after ${String(Date.now() - started)} ms`,
    );
    expect(frame.width).toBeLessThanOrEqual(872);
    expect(frame.width).toBeGreaterThan(800); // the panel's own width, not the old 960 or a tiny thumbnail
    expect(state['frameBytes'] as number).toBeLessThanOrEqual(FRAME_MAX_BYTES);
    expect(state).toMatchObject({ title: 'Panel form', interactive: true, backend: 'managed' });
    expect(String(state['url'])).toBe(`${base}/form`);

    // The q field is at 100..500 x 100..140 of a 1280x800 page.
    const click = await call('browser.watch.input', {
      watchId,
      event: { kind: 'click', nx: 300 / frame.pageWidth, ny: 120 / frame.pageHeight },
    });
    expect(click, JSON.stringify(click)).toMatchObject({ ok: true });
    expect(await value(sessionId, 'document.activeElement.id')).toBe('q');
    expect(
      await call('browser.watch.input', { watchId, event: { kind: 'text', text: 'red shoes' } }),
    ).toMatchObject({
      ok: true,
    });
    expect(await value(sessionId, 'document.getElementById("q").value')).toBe('red shoes');

    await call('browser.watch.input', {
      watchId,
      event: { kind: 'click', nx: 300 / frame.pageWidth, ny: 320 / frame.pageHeight },
    });
    expect(await value(sessionId, 'document.activeElement.id')).toBe('pw');
    const refused = await call('browser.watch.input', {
      watchId,
      event: { kind: 'text', text: 'leak' },
    });
    expect(refused).toMatchObject({ ok: false, status: 'secret_field' });
    const backspace = await call('browser.watch.input', {
      watchId,
      event: { kind: 'key', key: 'Backspace' },
    });
    expect(backspace).toMatchObject({ ok: false });
    expect(await value(sessionId, 'document.getElementById("pw").value')).toBe('hunter2');
    await call('browser.session.close', { sessionId });
  });

  it('a wheel on the picture scrolls the page and back returns', async () => {
    const { sessionId, watchId } = await watchSession('/tall');
    await frameOf(watchId, { width: 600, height: 400 });
    const wheel = await call('browser.watch.input', {
      watchId,
      event: { kind: 'wheel', nx: 0.5, ny: 0.5, deltaY: 900 },
    });
    expect(wheel, JSON.stringify(wheel)).toMatchObject({ ok: true });
    let scrolled = 0;
    for (let index = 0; index < 20 && scrolled === 0; index += 1) {
      scrolled = Number(await value(sessionId, 'window.scrollY'));
      if (scrolled === 0) await sleep(100);
    }
    expect(scrolled).toBeGreaterThan(0);
    await call('browser.session.act', {
      sessionId,
      action: { kind: 'navigate', url: `${base}/form` },
    });
    expect(await call('browser.watch.input', { watchId, event: { kind: 'back' } })).toMatchObject({
      ok: true,
    });
    expect(String(await value(sessionId, 'location.pathname'))).toBe('/tall');
    await call('browser.session.close', { sessionId });
    expect(await call('browser.watch.input', { watchId, event: { kind: 'reload' } })).toMatchObject(
      {
        status: 'view_only',
        viewOnly: 'closed',
      },
    );
  });
});

describe.skipIf(!chrome.path)('a finished task, watched afterwards (real Chrome)', () => {
  it('a panel opened after the task ended shows its last picture and Done', async () => {
    const done = new BrowserService(() => new FakeDecider([{ choice: 'done', goalMet: 0.95 }]), {
      artifactDir: path.join(os.tmpdir(), 'mb-watch-final-real'),
    });
    try {
      const run = (
        await done.invoke('browser.task', { goal: 'look at the form', startUrl: `${base}/form` })
      ).output as Record<string, unknown>;
      expect(run['status'], JSON.stringify(run)).toBe('done');
      // A clean done saves no final screenshot file: the picture is the one kept before the tab closed.
      expect(run['artifacts']).toEqual([]);
      const watched = (await done.invoke('browser.watch', { taskId: run['taskId'], open: false }))
        .output as Record<string, unknown>;
      expect(watched['ok'], JSON.stringify(watched)).toBe(true);
      const state = (await done.invoke('browser.watch.frame', { watchId: watched['watchId'] }))
        .output as Record<string, unknown>;
      expect(state).toMatchObject({ state: 'finished', status: 'done' });
      expect(state['frame']).toMatchObject({
        mimeType: 'image/jpeg',
        width: 1280,
        height: 800,
        final: true,
      });
    } finally {
      await done.dispose();
    }
  }, 60_000);
});
