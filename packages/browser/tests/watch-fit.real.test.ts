/**
 * The live panel as a browser pane, against a real Chrome: the page takes the pane's size and pixel ratio, the panel's
 * clicks land on the resized page, a typed address navigates, a still at rest carries the page's own device pixels,
 * screenshots keep the size they have when nobody watches, and a size the caller set is never changed. Skipped, with a
 * notice, when no Chrome is installed.
 */
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BrowserService } from '../src/capabilities.js';
import { ChromeLauncher, findChrome } from '../src/chrome/launcher.js';
import { jpegSize } from '../src/chrome/screencast.js';
import { ManagedTab } from '../src/chrome/tab.js';
import { DECISION_SHOT } from '../src/target.js';
import { FakeDecider } from './helpers.js';

const chrome = findChrome();
if (!chrome.path) console.warn(`[watch-fit.real] SKIPPED: ${chrome.reason}`);

const PAGES: Record<string, string> = {
  '/form': `<!doctype html><title>Pane form</title><style>body{margin:0}input,button{position:absolute;left:100px;width:400px;height:40px;font-size:20px}</style>
<input id="q" style="top:100px" value=""><button id="go" style="top:200px">Go</button>`,
  '/other': `<!doctype html><title>Other</title><p>Other page</p>`,
};

let server: http.Server;
let base = '';

beforeAll(async () => {
  server = http.createServer((request, response) => {
    const body = PAGES[new URL(request.url ?? '/', 'http://x').pathname];
    response.writeHead(body ? 200 : 404, { 'content-type': 'text/html' });
    response.end(body ?? 'not found');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${String((server.address() as { port: number }).port)}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const pngSize = (data: Buffer): { width: number; height: number } => ({
  width: data.readUInt32BE(16),
  height: data.readUInt32BE(20),
});
const METRICS = 'return [innerWidth, innerHeight, devicePixelRatio];';

describe.skipIf(!chrome.path)('a tab sized to the panel (real Chrome)', () => {
  it('takes the size and pixel ratio; screenshots keep their size; a still has every pixel', async () => {
    const launcher = new ChromeLauncher();
    try {
      const tab = await ManagedTab.open(launcher, 'visitor');
      await tab.act({ kind: 'navigate', url: `${base}/form` });
      expect(tab.viewport()).toEqual({
        width: 1280,
        height: 800,
        deviceScaleFactor: 1,
        pinned: false,
      });
      expect(await tab.fitToPanel({ width: 1000, height: 700, deviceScaleFactor: 2 })).toBe(true);
      expect(await tab.evaluate(METRICS)).toEqual([1000, 700, 2]);
      expect(tab.viewport()).toEqual({
        width: 1000,
        height: 700,
        deviceScaleFactor: 2,
        pinned: false,
      });

      // The decision image stays 768 wide and a plain screenshot one pixel per CSS pixel, whoever watches.
      const snap = await tab.snapshot();
      const decision = await tab.screenshot({ ...DECISION_SHOT, marks: snap.elements });
      expect(jpegSize(decision.data)).toEqual({ width: 768, height: 538 });
      const plain = await tab.screenshot();
      expect(pngSize(Buffer.from(plain.data, 'base64'))).toEqual({ width: 1000, height: 700 });
      const clipped = await tab.screenshot({ clip: { x: 0, y: 0, width: 300, height: 200 } });
      expect(pngSize(Buffer.from(clipped.data, 'base64'))).toEqual({ width: 300, height: 200 });

      // Right after the marks left the page no still is taken (a frame in flight may still show them); then it is.
      expect(await tab.still()).toBeNull();
      await sleep(200);
      const still = await tab.still();
      expect(still).toMatchObject({
        mimeType: 'image/png',
        width: 2000,
        height: 1400,
        pageWidth: 1000,
        pageHeight: 700,
      });
      expect(pngSize(Buffer.from(still?.data ?? '', 'base64'))).toEqual({
        width: 2000,
        height: 1400,
      });

      // The automation's click is where the panel draws its pointer.
      const button = snap.elements.find((element) => element.label === 'Go');
      expect(button).toBeDefined();
      const before = Date.now();
      await tab.act({ kind: 'click', ref: button?.ref ?? '' });
      const pointer = tab.pointer;
      expect(pointer?.x).toBeGreaterThanOrEqual(100);
      expect(pointer?.x).toBeLessThanOrEqual(500);
      expect(pointer?.y).toBeGreaterThanOrEqual(200);
      expect(pointer?.y).toBeLessThanOrEqual(240);
      expect(pointer?.at).toBeGreaterThanOrEqual(before);

      // The toolbar: not loading once loaded, back only after a second page.
      expect(await tab.location()).toMatchObject({
        title: 'Pane form',
        loading: false,
        canGoBack: false,
        canGoForward: false,
      });
      await tab.act({ kind: 'navigate', url: `${base}/other` });
      expect(await tab.location()).toMatchObject({ title: 'Other', canGoBack: true });

      // Nobody looks any more: the default size is back.
      expect(await tab.fitToPanel(null)).toBe(true);
      expect(await tab.evaluate(METRICS)).toEqual([1280, 800, 1]);
      const after = await tab.screenshot();
      expect(pngSize(Buffer.from(after.data, 'base64'))).toEqual({ width: 1280, height: 800 });
      await tab.close();
    } finally {
      await launcher.closeAll();
    }
  }, 60_000);

  it('never changes a size the caller set', async () => {
    const launcher = new ChromeLauncher();
    try {
      const tab = await ManagedTab.open(launcher, 'visitor');
      await tab.act({ kind: 'navigate', url: `${base}/form` });
      await tab.setViewport({ width: 390, height: 844, deviceScaleFactor: 3 });
      expect(await tab.fitToPanel({ width: 1000, height: 700, deviceScaleFactor: 1 })).toBe(false);
      expect(await tab.fitToPanel(null)).toBe(false);
      expect(await tab.evaluate(METRICS)).toEqual([390, 844, 3]);
      expect(tab.viewport()).toEqual({
        width: 390,
        height: 844,
        deviceScaleFactor: 3,
        pinned: true,
      });
      // The caller's own pixel ratio is kept in its screenshots.
      const shot = await tab.screenshot();
      expect(pngSize(Buffer.from(shot.data, 'base64'))).toEqual({ width: 1170, height: 2532 });
      await tab.close();
    } finally {
      await launcher.closeAll();
    }
  }, 60_000);
});

describe.skipIf(!chrome.path)('the panel as a browser pane, through the capabilities', () => {
  it('fits the page to the pane, clicks land, an address navigates, a sharp still arrives, and it lets go', async () => {
    const service = new BrowserService(() => new FakeDecider([]), {
      artifactDir: path.join(os.tmpdir(), 'mb-watch-fit-real'),
    });
    const call = async (
      name: string,
      input: Record<string, unknown>,
    ): Promise<Record<string, unknown>> =>
      (await service.invoke(name, input)).output as Record<string, unknown>;
    const value = async (sessionId: string, expression: string): Promise<unknown> =>
      (await call('browser.session.evaluate', { sessionId, expression }))['value'];
    try {
      const opened = await call('browser.session.open', { url: `${base}/form` });
      const sessionId = opened['sessionId'] as string;
      const watchId = (await call('browser.watch', { sessionId, open: false }))[
        'watchId'
      ] as string;
      // A dense screen: 1800x1200 device pixels at ratio 2 is a 900x600 page.
      const view = { width: 1800, height: 1200, dpr: 2, fit: true, viewer: 'p-test' };
      const until = async (
        what: string,
        done: (state: Record<string, unknown>) => boolean,
        sent: Record<string, unknown> = view,
      ): Promise<Record<string, unknown>> => {
        const deadline = Date.now() + 10_000;
        let state: Record<string, unknown> = {};
        while (Date.now() < deadline) {
          state = await call('browser.watch.frame', { watchId, view: sent });
          if (done(state)) return state;
          await sleep(120);
        }
        throw new Error(`${what}: ${JSON.stringify({ ...state, frame: undefined })}`);
      };
      const fitted = await until(
        'the page never took the pane size',
        (state) => (state['page'] as { fit?: boolean } | undefined)?.fit === true,
      );
      expect(fitted['page']).toEqual({
        width: 900,
        height: 600,
        deviceScaleFactor: 2,
        fit: true,
        pinned: false,
      });
      expect(await value(sessionId, '[innerWidth, innerHeight, devicePixelRatio]')).toEqual([
        900, 600, 2,
      ]);

      // At rest the picture becomes a still with every device pixel of the page.
      const started = Date.now();
      const sharp = await until(
        'no sharp still',
        (state) => (state['frame'] as { sharp?: boolean } | undefined)?.sharp === true,
      );
      const frame = sharp['frame'] as {
        data: string;
        mimeType: string;
        width: number;
        height: number;
      };
      expect(frame).toMatchObject({ mimeType: 'image/png', width: 1800, height: 1200 });
      expect(pngSize(Buffer.from(frame.data, 'base64'))).toEqual({ width: 1800, height: 1200 });
      console.info(
        `[watch-fit.real] sharp still 1800x1200, ${String(Math.round((frame.data.length * 3) / 4 / 1024))} KB, ${String(Date.now() - started)} ms after the fit`,
      );

      // The q field is at 100..500 x 100..140 of the 900x600 page.
      expect(
        await call('browser.watch.input', {
          watchId,
          event: { kind: 'click', nx: 300 / 900, ny: 120 / 600 },
        }),
      ).toMatchObject({ ok: true });
      expect(await value(sessionId, 'document.activeElement.id')).toBe('q');

      // A screenshot the agent takes meanwhile keeps one pixel per CSS pixel.
      const shot = await call('browser.session.screenshot', { sessionId });
      expect(pngSize(readFileSync(String(shot['path'])))).toEqual({ width: 900, height: 600 });

      // A typed address (a bare loopback host gets http) navigates; the toolbar then offers back.
      const typed = `${base.replace('http://', '')}/other`;
      expect(
        await call('browser.watch.input', { watchId, event: { kind: 'navigate', url: typed } }),
      ).toMatchObject({ ok: true, navigated: true });
      expect(String(await value(sessionId, 'location.pathname'))).toBe('/other');
      const moved = await until('the toolbar never showed the new page', (state) =>
        String(state['url']).endsWith('/other'),
      );
      expect(moved).toMatchObject({ title: 'Other', canGoBack: true, canGoForward: false });
      const refused = await call('browser.watch.input', {
        watchId,
        event: { kind: 'navigate', url: 'file:///etc/hosts' },
      });
      expect(refused['ok']).toBe(false);
      expect(String(refused['error'])).toMatch(/BROWSER_BAD_INPUT/);
      expect(String(await value(sessionId, 'location.pathname'))).toBe('/other');

      // The panel stops asking: the default size is back.
      await until(
        'the page kept the pane size',
        (state) => (state['page'] as { width?: number } | undefined)?.width === 1280,
        { ...view, fit: false },
      );
      expect(await value(sessionId, '[innerWidth, innerHeight, devicePixelRatio]')).toEqual([
        1280, 800, 1,
      ]);

      // A size the caller sets is the caller's: the panel is told, and never changes it.
      await call('browser.session.viewport', { sessionId, width: 600, height: 500 });
      const pinned = await until(
        'the panel was not told the size is pinned',
        (state) => (state['page'] as { pinned?: boolean } | undefined)?.pinned === true,
      );
      expect(pinned['page']).toMatchObject({ width: 600, height: 500, fit: false, pinned: true });
      await sleep(400);
      expect(await value(sessionId, '[innerWidth, innerHeight]')).toEqual([600, 500]);
      await call('browser.session.close', { sessionId });
    } finally {
      await service.dispose();
    }
  }, 90_000);
});
