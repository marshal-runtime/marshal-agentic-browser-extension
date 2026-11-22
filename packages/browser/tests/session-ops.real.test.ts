/**
 * The step-by-step session operations in a real Chrome, through BrowserService.invoke (the capability entry point):
 * key presses (and the secret-field refusal), hover, forward/reload, wait, read, evaluate, dialogs, console and network
 * logs, and uploads. Skipped, with a notice, when no Chrome is installed.
 */
import http from 'node:http';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BrowserService } from '../src/capabilities.js';
import { findChrome } from '../src/chrome/launcher.js';
import { decodePng } from '../src/user/image.js';
import { FakeDecider } from './helpers.js';

const chrome = findChrome();
if (!chrome.path) console.warn(`[session-ops.real] SKIPPED: ${chrome.reason}`);

const PAGES: Record<string, string> = {
  '/form': `<!doctype html><title>Form</title>
<form action="/sent" method="get"><label>Query <input id="q" name="q" value="shoes"></label>
<label>Password <input id="pw" name="pw" type="password" value="hunter2"></label><button>Go</button></form>`,
  '/sent': `<!doctype html><title>Sent</title><p>Thanks, sent.</p>`,
  '/hover': `<!doctype html><title>Hover</title><button id="b" onmouseover="document.getElementById('tip').textContent='Tip shown'">Info</button><p id="tip">no tip</p>`,
  '/late': `<!doctype html><title>Late</title><p id="s">Loading</p><script>setTimeout(()=>{document.getElementById('s').textContent='Ready now'},600)</script>`,
  '/dialogs': `<!doctype html><title>Dialogs</title>
<button onclick="alert('Hello there')">Alert</button>
<button onclick="document.getElementById('r').textContent = confirm('Sure?') ? 'yes' : 'no'">Confirm</button>
<button onclick="document.getElementById('r').textContent = 'name:' + prompt('Name?', 'x')">Prompt</button>
<p id="r">none</p>`,
  '/logs': `<!doctype html><title>Logs</title><script>console.log('hello from page', 7); console.error('bad thing'); fetch('/api/data?x=1').then(()=>{}); setTimeout(()=>{throw new Error('boom')},10)</script>`,
  '/upload': `<!doctype html><title>Upload</title><input type="file" id="f" style="display:none" multiple onchange="document.getElementById('n').textContent=[...this.files].map(f=>f.name).join(',')">
<button onclick="document.getElementById('f').click()">Choose files</button><p id="n">none</p>`,
  '/one-input': `<!doctype html><title>One</title><input type="file" id="f" onchange="document.getElementById('n').textContent=this.files[0].name"><p id="n">none</p>`,
  '/single': `<!doctype html><title>Single</title><input type="file" id="f" style="display:none"><button onclick="document.getElementById('f').click()">Pick</button>`,
  '/tall': `<!doctype html><title>Tall</title><meta name="viewport" content="width=device-width"><style>body{margin:0}div{height:1000px}</style>${Array.from({ length: 17 }, (_, i) => `<div style="background:rgb(${String(i * 15)},0,${String(255 - i * 15)})"></div>`).join('')}`,
};

let server: http.Server;
let base = '';
const seen: { path: string; cookie?: string }[] = [];
let service: BrowserService;
let files: string[] = [];

beforeAll(async () => {
  server = http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://x');
    seen.push({
      path: url.pathname,
      ...(request.headers.cookie ? { cookie: request.headers.cookie } : {}),
    });
    const body = PAGES[url.pathname];
    if (url.pathname === '/api/data') {
      response.writeHead(201, { 'content-type': 'application/json', 'set-cookie': 'sid=secret' });
      response.end('{"ok":true}');
      return;
    }
    response.writeHead(body ? 200 : 404, { 'content-type': 'text/html' });
    response.end(body ?? 'not found');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${String((server.address() as { port: number }).port)}`;
  const dir = mkdtempSync(path.join(os.tmpdir(), 'mb-upload-real-'));
  files = ['first.txt', 'second.txt'].map((name) => {
    const file = path.join(dir, name);
    writeFileSync(file, name);
    return file;
  });
  service = new BrowserService(() => new FakeDecider([]), {
    artifactDir: path.join(os.tmpdir(), 'mb-session-ops-real'),
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

async function open(page: string, extra: Record<string, unknown> = {}): Promise<string> {
  const opened = await call('browser.session.open', { url: `${base}${page}`, ...extra });
  expect(opened['ok'], JSON.stringify(opened)).toBe(true);
  return opened['sessionId'] as string;
}

async function refOf(sessionId: string, label: RegExp): Promise<string> {
  const snap = await call('browser.session.snapshot', { sessionId });
  const elements = snap['elements'] as { ref: string; description: string }[];
  const found = elements.find((element) => label.test(element.description));
  if (!found) throw new Error(`no element ${String(label)} in ${JSON.stringify(elements)}`);
  return found.ref;
}

const evaluate = async (sessionId: string, expression: string): Promise<unknown> =>
  (await call('browser.session.evaluate', { sessionId, expression }))['value'];

describe.skipIf(!chrome.path)('session operations in a real Chrome', () => {
  it('press: Enter in a field sends its form; Tab moves focus', async () => {
    const sessionId = await open('/form');
    await evaluate(sessionId, "document.getElementById('q').focus(), true");
    await call('browser.session.act', { sessionId, action: { kind: 'press', key: 'Tab' } });
    expect(await evaluate(sessionId, 'document.activeElement.id')).toBe('pw');
    await evaluate(sessionId, "document.getElementById('q').focus(), true");
    const sent = await call('browser.session.act', {
      sessionId,
      action: { kind: 'press', key: 'Enter' },
    });
    expect(sent).toMatchObject({ ok: true, title: 'Sent' });
    await call('browser.session.close', { sessionId });
  });

  it('press: a key that edits text never reaches a focused password field', async () => {
    const sessionId = await open('/form');
    await evaluate(sessionId, "document.getElementById('pw').focus(), true");
    for (const key of ['Backspace', 'Delete', 'Space']) {
      const result = await call('browser.session.act', {
        sessionId,
        action: { kind: 'press', key },
      });
      expect(result['ok'], key).toBe(false);
      expect(String(result['error'])).toMatch(/secret-field/);
    }
    expect(await evaluate(sessionId, "document.getElementById('pw').value")).toBe('hunter2');
    // The same key in an ordinary field goes through.
    await evaluate(
      sessionId,
      "(() => { const q = document.getElementById('q'); q.focus(); q.setSelectionRange(5, 5); return true; })()",
    );
    await call('browser.session.act', { sessionId, action: { kind: 'press', key: 'Backspace' } });
    expect(await evaluate(sessionId, "document.getElementById('q').value")).toBe('shoe');
    await call('browser.session.close', { sessionId });
  });

  it('hover moves the real mouse over the element', async () => {
    const sessionId = await open('/hover');
    const ref = await refOf(sessionId, /Info/);
    expect(
      await call('browser.session.act', { sessionId, action: { kind: 'hover', ref } }),
    ).toMatchObject({ ok: true });
    expect(await evaluate(sessionId, "document.getElementById('tip').textContent")).toBe(
      'Tip shown',
    );
    await call('browser.session.close', { sessionId });
  });

  it('back, forward and reload', async () => {
    const sessionId = await open('/form');
    await call('browser.session.act', {
      sessionId,
      action: { kind: 'navigate', url: `${base}/sent` },
    });
    expect(
      await call('browser.session.act', { sessionId, action: { kind: 'back' } }),
    ).toMatchObject({ title: 'Form' });
    expect(
      await call('browser.session.act', { sessionId, action: { kind: 'forward' } }),
    ).toMatchObject({ title: 'Sent' });
    await evaluate(sessionId, 'window.__marker = 1, true');
    expect(
      await call('browser.session.act', { sessionId, action: { kind: 'reload' } }),
    ).toMatchObject({ ok: true, title: 'Sent' });
    expect(await evaluate(sessionId, 'window.__marker === undefined')).toBe(true);
    await call('browser.session.close', { sessionId });
  });

  it('wait for text to appear, and a timeout when it never does', async () => {
    const sessionId = await open('/late');
    expect(
      await call('browser.session.wait', { sessionId, text: 'Ready now', timeoutMs: 5000 }),
    ).toMatchObject({ ok: true, met: true });
    expect(await call('browser.session.wait', { sessionId, textGone: 'Loading' })).toMatchObject({
      met: true,
    });
    expect(
      await call('browser.session.wait', { sessionId, text: 'Never', timeoutMs: 600 }),
    ).toMatchObject({ ok: false, met: false });
    await call('browser.session.close', { sessionId });
  });

  it('read: visible text and HTML, cut at maxChars', async () => {
    const sessionId = await open('/sent');
    expect(await call('browser.session.read', { sessionId })).toMatchObject({
      ok: true,
      content: 'Thanks, sent.',
    });
    const html = await call('browser.session.read', { sessionId, format: 'html' });
    expect(String(html['content'])).toContain('<p>Thanks, sent.</p>');
    expect(
      await call('browser.session.read', { sessionId, format: 'html', maxChars: 10 }),
    ).toMatchObject({ truncated: true });
    await call('browser.session.close', { sessionId });
  });

  it('evaluate: values, awaited promises, page errors and an over-long result', async () => {
    const sessionId = await open('/sent');
    expect(await evaluate(sessionId, '({ title: document.title, n: 1 + 2 })')).toEqual({
      title: 'Sent',
      n: 3,
    });
    expect(await evaluate(sessionId, 'new Promise((r) => setTimeout(() => r("later"), 50))')).toBe(
      'later',
    );
    expect(await evaluate(sessionId, 'undefined')).toBeNull();
    const failed = await call('browser.session.evaluate', { sessionId, expression: 'nope.nope' });
    expect(failed).toMatchObject({ ok: false });
    expect(String(failed['error'])).toMatch(/page script failed/);
    const huge = await call('browser.session.evaluate', {
      sessionId,
      expression: '"x".repeat(600000)',
    });
    expect(String(huge['error'])).toMatch(/result-too-large/);
    await call('browser.session.close', { sessionId });
  });

  it('dialogs: an alert returns from the click, blocks reads until answered; confirm and prompt get answers', async () => {
    const sessionId = await open('/dialogs');
    const alertRef = await refOf(sessionId, /Alert/);
    const clicked = await call('browser.session.act', {
      sessionId,
      action: { kind: 'click', ref: alertRef },
    });
    expect(clicked).toMatchObject({ ok: true, dialog: { type: 'alert', message: 'Hello there' } });
    const blocked = await call('browser.session.snapshot', { sessionId });
    expect(String(blocked['error'])).toMatch(/BROWSER_DIALOG_OPEN/);
    expect(await call('browser.session.dialog', { sessionId })).toMatchObject({
      dialog: { type: 'alert' },
    });
    expect(await call('browser.session.dialog', { sessionId, accept: true })).toMatchObject({
      ok: true,
      accepted: true,
    });

    const confirmRef = await refOf(sessionId, /Confirm/);
    await call('browser.session.act', { sessionId, action: { kind: 'click', ref: confirmRef } });
    await call('browser.session.dialog', { sessionId, accept: false });
    expect(await evaluate(sessionId, "document.getElementById('r').textContent")).toBe('no');

    const promptRef = await refOf(sessionId, /Prompt/);
    const prompted = await call('browser.session.act', {
      sessionId,
      action: { kind: 'click', ref: promptRef },
    });
    expect(prompted['dialog']).toMatchObject({ type: 'prompt', defaultPrompt: 'x' });
    await call('browser.session.dialog', { sessionId, accept: true, promptText: 'Omer' });
    expect(await evaluate(sessionId, "document.getElementById('r').textContent")).toBe('name:Omer');
    expect(await call('browser.session.dialog', { sessionId, accept: true })).toMatchObject({
      ok: false,
    });
    await call('browser.session.close', { sessionId });
  });

  it('a dialog opened by a script being evaluated does not hang the call', async () => {
    const sessionId = await open('/sent');
    const result = await call('browser.session.evaluate', {
      sessionId,
      expression: 'alert("from script")',
    });
    expect(String(result['error'])).toMatch(/BROWSER_DIALOG_OPEN/);
    await call('browser.session.dialog', { sessionId, accept: true });
    expect(await evaluate(sessionId, '1')).toBe(1);
    await call('browser.session.close', { sessionId });
  });

  it("log: off by default; with observe the first load's console and requests are there, without headers or cookies", async () => {
    const quiet = await open('/logs');
    const first = await call('browser.session.log', { sessionId: quiet });
    expect(first).toMatchObject({ ok: true, startedNow: ['console', 'network'] });
    expect(first['entries']).toEqual([]);
    await call('browser.session.close', { sessionId: quiet });

    const sessionId = await open('/logs', { observe: ['console', 'network'] });
    await call('browser.session.wait', { sessionId, text: '', urlIncludes: '/logs' });
    await new Promise((resolve) => setTimeout(resolve, 300));
    const logged = await call('browser.session.log', { sessionId });
    const entries = logged['entries'] as Record<string, unknown>[];
    const consoleTexts = entries
      .filter((entry) => entry['kind'] === 'console')
      .map((entry) => String(entry['text']));
    expect(consoleTexts).toContain('hello from page 7');
    expect(consoleTexts).toContain('bad thing');
    expect(consoleTexts.some((text) => text.includes('boom'))).toBe(true);
    const api = entries.find(
      (entry) => entry['kind'] === 'network' && String(entry['url']).includes('/api/data'),
    );
    expect(api).toMatchObject({ method: 'GET', status: 201 });
    expect(Object.keys(api ?? {}).sort()).toEqual([
      'at',
      'kind',
      'method',
      'resourceType',
      'status',
      'url',
    ]);
    expect(JSON.stringify(entries)).not.toContain('sid=secret');
    const cleared = await call('browser.session.log', {
      sessionId,
      kinds: ['console'],
      clear: true,
    });
    expect((cleared['entries'] as unknown[]).length).toBeGreaterThan(0);
    const after = await call('browser.session.log', { sessionId, kinds: ['console'] });
    expect(after['entries']).toEqual([]);
    await call('browser.session.close', { sessionId });
  });

  it('upload: through the button that opens the chooser, to the only input, and the refusals', async () => {
    const sessionId = await open('/upload');
    const ref = await refOf(sessionId, /Choose files/);
    expect(
      await call('browser.session.act', {
        sessionId,
        action: { kind: 'upload', ref, paths: files },
      }),
    ).toMatchObject({ ok: true });
    expect(await evaluate(sessionId, "document.getElementById('n').textContent")).toBe(
      'first.txt,second.txt',
    );
    const relative = await call('browser.session.act', {
      sessionId,
      action: { kind: 'upload', ref, paths: ['first.txt'] },
    });
    expect(String(relative['error'])).toMatch(/not an absolute path/);
    await call('browser.session.close', { sessionId });

    const one = await open('/one-input');
    expect(
      await call('browser.session.act', {
        sessionId: one,
        action: { kind: 'upload', paths: [files[0]] },
      }),
    ).toMatchObject({ ok: true });
    expect(await evaluate(one, "document.getElementById('n').textContent")).toBe('first.txt');
    await call('browser.session.close', { sessionId: one });

    const single = await open('/single');
    const pick = await refOf(single, /Pick/);
    const two = await call('browser.session.act', {
      sessionId: single,
      action: { kind: 'upload', ref: pick, paths: files },
    });
    expect(String(two['error'])).toMatch(/single-file/);
    await call('browser.session.close', { sessionId: single });
  });

  it('viewport: a phone size with touch at open, then desktop; screenshots take format, quality and a clip', async () => {
    const sessionId = await open('/tall', {
      viewport: { width: 390, height: 844, deviceScaleFactor: 2, mobile: true, touch: true },
    });
    expect(
      await evaluate(
        sessionId,
        '({w: innerWidth, h: innerHeight, dpr: devicePixelRatio, touch: navigator.maxTouchPoints, coarse: matchMedia("(pointer: coarse)").matches})',
      ),
    ).toEqual({ w: 390, h: 844, dpr: 2, touch: 5, coarse: true });

    const tile = await call('browser.session.screenshot', {
      sessionId,
      format: 'jpeg',
      quality: 72,
      clip: { x: 0, y: 5000, width: 390, height: 1100 },
    });
    expect(tile['ok'], JSON.stringify(tile)).toBe(true);
    expect(String(tile['path'])).toMatch(/\.jpg$/);
    expect(jpegSize(readFileSync(String(tile['path'])))).toEqual({ width: 780, height: 2200 });

    // A whole page taller than the old 12,000 px cap, at a pixel ratio of 2 (Page Studio's page shots).
    const whole = await call('browser.session.screenshot', { sessionId, fullPage: true });
    expect(pngSize(readFileSync(String(whole['path'])))).toEqual({ width: 780, height: 34_000 });
    // Past 16,384 device px a GPU-composited capture repeats the top of the page: every block must be its own colour.
    expect(blockColours(String(whole['path']), 2)).toEqual(TALL_BLOCKS);

    expect(
      await call('browser.session.viewport', { sessionId, width: 1280, height: 800 }),
    ).toMatchObject({ ok: true, viewport: { width: 1280, height: 800 } });
    expect(
      await evaluate(
        sessionId,
        '({w: innerWidth, dpr: devicePixelRatio, touch: navigator.maxTouchPoints})',
      ),
    ).toEqual({ w: 1280, dpr: 1, touch: 0 });
    const desktop = await call('browser.session.screenshot', {
      sessionId,
      clip: { x: 0, y: 0, width: 1280, height: 17_000 },
    });
    expect(blockColours(String(desktop['path']), 1)).toEqual(TALL_BLOCKS);
    const bad = await call('browser.session.viewport', { sessionId, width: 20, height: 800 });
    expect(String(bad['error'])).toMatch(/BROWSER_BAD_INPUT: viewport.width/);
    await call('browser.session.close', { sessionId });
  });

  it('a file:// page opens on visitor and on offline', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'mb-file-page-'));
    const file = path.join(dir, 'page.html');
    writeFileSync(file, '<!doctype html><title>Local page</title><p>Made here</p>');
    for (const profile of ['visitor', 'offline']) {
      const opened = await call('browser.session.open', { profile, url: `file://${file}` });
      expect(opened, profile).toMatchObject({ ok: true, title: 'Local page' });
      const text = await call('browser.session.read', { sessionId: opened['sessionId'] });
      expect(text['content']).toContain('Made here');
      await call('browser.session.close', { sessionId: opened['sessionId'] });
    }
  });
});

const TALL_BLOCKS = Array.from({ length: 17 }, (_, i) => [i * 15, 0, 255 - i * 15]);

/** The colour in the middle of each 1000 CSS px block of /tall, read from the captured PNG. */
function blockColours(file: string, ratio: number): number[][] {
  const image = decodePng(readFileSync(file));
  return TALL_BLOCKS.map((_, i) => {
    const offset = ((i * 1000 + 500) * ratio * image.width + 10) * 4;
    return Array.from(image.data.subarray(offset, offset + 3));
  });
}

function pngSize(data: Buffer): { width: number; height: number } {
  return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
}

function jpegSize(data: Buffer): { width: number; height: number } {
  let offset = 2;
  while (offset < data.length) {
    const marker = data[offset + 1] ?? 0;
    const length = data.readUInt16BE(offset + 2);
    if (marker >= 0xc0 && marker <= 0xc2)
      return { height: data.readUInt16BE(offset + 5), width: data.readUInt16BE(offset + 7) };
    offset += 2 + length;
  }
  throw new Error('no JPEG frame header');
}
