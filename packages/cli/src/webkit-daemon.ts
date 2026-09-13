#!/usr/bin/env node

/**
 * WebKit engine daemon.
 *
 * The CDP engine talks to a browser that outlives each CLI invocation, so the
 * CLI can stay stateless. Playwright has no equivalent "attach from a fresh
 * process and reuse existing pages" model — a client's contexts die with its
 * connection. This daemon restores the CDP shape: it owns a single Playwright
 * WebKit browser + context and serves commands over a localhost-only HTTP JSON
 * API. Each CLI invocation POSTs one command and exits.
 *
 * HONEST SEMANTICS: this is Playwright's WebKit build (the engine Safari
 * uses), NOT the user's Safari.app. The profile is fresh and ephemeral —
 * no Safari cookies, logins, or extensions.
 *
 * Protocol (127.0.0.1 only, no auth — same trust model as local CDP):
 *   GET  /status    → { success, engine: 'webkit', ready, browserVersion, ... }
 *   POST /command   → body { command, values, positionals, cwd } → CmdResult
 *   POST /shutdown  → closes the browser and exits
 */

import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { writeFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { webkit } from 'playwright';
import type {
  Browser,
  BrowserContext,
  Page,
  Request as PwRequest,
  Response as PwResponse,
} from 'playwright';
import {
  getDomWalkerScript,
  normalizeAriaTree,
  renderAriaSnapshot,
  extractRefMap,
} from '@agentic-browser/shared';
import { DEVICE_PRESETS } from './commands.js';
import { WEBKIT_UNSUPPORTED, WEBKIT_TARGET_FLAG_ERROR } from './engine.js';

interface CmdResult {
  success: boolean;
  [key: string]: unknown;
}

interface CommandPayload {
  command: string;
  values: Record<string, string | boolean | undefined>;
  positionals: string[];
  cwd: string;
}

const ok = (data: Record<string, unknown> = {}): CmdResult => ({ success: true, ...data });
const fail = (error: string): CmdResult => ({ success: false, error });

const DEFAULT_VIEWPORT = { width: 1280, height: 800 };

// ---------------------------------------------------------------------------
// Daemon state
// ---------------------------------------------------------------------------

let browser: Browser;
let context: BrowserContext;
let activePage: Page;
let headless = false;

const tabIds = new WeakMap<Page, string>();
let tabCounter = 0;

function registerPage(page: Page): string {
  let id = tabIds.get(page);
  if (!id) {
    tabCounter += 1;
    id = `wk${String(tabCounter)}`;
    tabIds.set(page, id);
  }
  return id;
}

function getPage(): Page {
  if (!activePage.isClosed()) return activePage;
  const last = context.pages().at(-1);
  if (last) {
    activePage = last;
    return activePage;
  }
  throw new Error('No open tabs. Use create-tab or navigate.');
}

function findPage(idOrPrefix: string): Page | undefined {
  const pages = context.pages();
  const exact = pages.find((p) => tabIds.get(p) === idOrPrefix);
  if (exact) return exact;
  const matches = pages.filter((p) => tabIds.get(p)?.startsWith(idOrPrefix));
  if (matches.length > 1) {
    throw new Error(`Ambiguous tab prefix "${idOrPrefix}" matches ${String(matches.length)} tabs.`);
  }
  return matches[0];
}

// ---------------------------------------------------------------------------
// Payload helpers (mirror the CLI's flag conventions)
// ---------------------------------------------------------------------------

type Values = CommandPayload['values'];

const str = (values: Values, key: string): string | undefined => {
  const v = values[key];
  return typeof v === 'string' ? v : undefined;
};
const num = (values: Values, key: string): number | undefined => {
  const s = str(values, key);
  return s !== undefined ? parseInt(s, 10) : undefined;
};
const float = (values: Values, key: string): number | undefined => {
  const s = str(values, key);
  return s !== undefined ? parseFloat(s) : undefined;
};
const bool = (values: Values, key: string): boolean => values[key] === true;

type PwModifier = 'Alt' | 'Control' | 'Meta' | 'Shift';

function parseModifiers(modStr?: string): PwModifier[] {
  if (!modStr) return [];
  const map: Record<string, PwModifier> = {
    ctrl: 'Control',
    control: 'Control',
    alt: 'Alt',
    shift: 'Shift',
    meta: 'Meta',
    cmd: 'Meta',
    command: 'Meta',
  };
  return modStr
    .split(',')
    .map((m) => map[m.trim().toLowerCase()])
    .filter((m): m is PwModifier => m !== undefined);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Command handlers
// ---------------------------------------------------------------------------

type Handler = (payload: CommandPayload) => Promise<CmdResult>;

const handlers: Record<string, Handler> = {
  // -- Lifecycle ------------------------------------------------------------

  'profile-info': async () => {
    const cookies = await context.cookies();
    const domains = new Map<string, number>();
    for (const cookie of cookies) {
      domains.set(cookie.domain, (domains.get(cookie.domain) ?? 0) + 1);
    }
    const topDomains = [...domains.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 50)
      .map(([domain, count]) => ({ domain, cookies: count }));
    return ok({
      engine: 'webkit',
      profile: 'ephemeral (Playwright WebKit — no Safari/Chrome profile, cookies, or logins)',
      totalCookies: cookies.length,
      uniqueDomains: domains.size,
      topDomains,
      loggedInServices: [],
    });
  },

  // -- Navigation -----------------------------------------------------------

  navigate: async ({ positionals }) => {
    const url = positionals[0];
    if (!url) return fail('Usage: agentic-browser navigate <url>');
    const page = getPage();
    await page.goto(url, { waitUntil: 'load', timeout: 60_000 });
    return ok({ url: page.url(), title: await page.title() });
  },

  'go-back': async () => {
    const page = getPage();
    const resp = await page.goBack({ waitUntil: 'load' });
    if (resp === null) return fail('Cannot go back: no previous history entry');
    return ok({ url: page.url() });
  },

  'go-forward': async () => {
    const page = getPage();
    const resp = await page.goForward({ waitUntil: 'load' });
    if (resp === null) return fail('Cannot go forward: no next history entry');
    return ok({ url: page.url() });
  },

  reload: async ({ values }) => {
    const page = getPage();
    await page.reload({ waitUntil: 'load' });
    const hard = bool(values, 'hard');
    return ok(
      hard
        ? {
            note: 'cache-bypassing hard reload is not supported on webkit; performed a normal reload',
          }
        : {},
    );
  },

  // -- DOM interaction --------------------------------------------------------

  click: async ({ values, positionals }) => {
    const page = getPage();
    const selector = positionals[0] ?? str(values, 'selector');
    const x = num(values, 'x');
    const y = num(values, 'y');
    const button = (str(values, 'button') ?? 'left') as 'left' | 'right' | 'middle';
    const clickCount = num(values, 'click-count') ?? 1;
    const modifiers = parseModifiers(str(values, 'modifiers'));

    if (selector) {
      await page.click(selector, { button, clickCount, modifiers, timeout: 10_000 });
      return ok({ selector, button, clickCount });
    }
    if (x !== undefined && y !== undefined) {
      for (const m of modifiers) await page.keyboard.down(m);
      await page.mouse.click(x, y, { button, clickCount });
      for (const m of [...modifiers].reverse()) await page.keyboard.up(m);
      return ok({ x, y, button, clickCount });
    }
    return fail('Usage: agentic-browser click <selector>  OR  agentic-browser click --x N --y N');
  },

  type: async ({ values, positionals }) => {
    const page = getPage();
    const textFlag = str(values, 'text');
    if (textFlag !== undefined) {
      await page.keyboard.insertText(textFlag);
      return ok({ text: textFlag, mode: 'cursor' });
    }
    const selector = positionals[0];
    const text = positionals[1];
    if (!selector || !text) {
      return fail(
        'Usage: agentic-browser type <selector> <text>  OR  agentic-browser type --text "hello"',
      );
    }
    await page.focus(selector, { timeout: 10_000 });
    if (bool(values, 'clear')) {
      await page.evaluate(
        `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (el && 'value' in el) el.value = ''; else if (el) el.textContent = ''; })()`,
      );
    }
    await page.keyboard.insertText(text);
    return ok({ selector, text });
  },

  select: async ({ values, positionals }) => {
    const page = getPage();
    const selector = positionals[0] ?? str(values, 'selector');
    if (!selector) return fail('Usage: agentic-browser select <selector>');
    const value = str(values, 'value');
    const label = str(values, 'label');
    const index = num(values, 'index');
    let option: { value: string } | { label: string } | { index: number };
    if (value !== undefined) option = { value };
    else if (label !== undefined) option = { label };
    else if (index !== undefined) option = { index };
    else return fail('Provide one of --value, --label, or --index');
    const selected = await page.selectOption(selector, option, { timeout: 10_000 });
    return ok({ selector, selected });
  },

  hover: async ({ values, positionals }) => {
    const page = getPage();
    const selector = positionals[0] ?? str(values, 'selector');
    if (!selector) return fail('Usage: agentic-browser hover <selector>');
    await page.hover(selector, { timeout: 10_000 });
    return ok({ selector });
  },

  scroll: async ({ values }) => {
    const page = getPage();
    const x = num(values, 'x') ?? 0;
    const y = num(values, 'y') ?? 0;
    const selector = str(values, 'selector');
    if (selector) {
      const found = await page.evaluate(
        `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.scrollBy(${String(x)}, ${String(y)}); return true; })()`,
      );
      if (found === false) return fail(`Element not found: ${selector}`);
    } else {
      await page.evaluate(`window.scrollBy(${String(x)}, ${String(y)})`);
    }
    return ok({ x, y, selector });
  },

  keyboard: async ({ values, positionals }) => {
    const page = getPage();
    let combo = positionals[0];
    if (!combo) return fail('Usage: agentic-browser keyboard <key>');
    const modFlag = str(values, 'modifiers');
    if (modFlag) {
      const mods = parseModifiers(modFlag);
      combo = [...mods, combo].join('+');
    }
    await page.keyboard.press(combo);
    return ok({ key: combo });
  },

  drag: async ({ values }) => {
    const page = getPage();
    const startX = num(values, 'start-x');
    const startY = num(values, 'start-y');
    const endX = num(values, 'end-x');
    const endY = num(values, 'end-y');
    if (startX === undefined || startY === undefined || endX === undefined || endY === undefined) {
      return fail('Usage: agentic-browser drag --start-x N --start-y N --end-x N --end-y N');
    }
    const steps = num(values, 'steps') ?? 10;
    const modifiers = parseModifiers(str(values, 'modifiers'));
    for (const m of modifiers) await page.keyboard.down(m);
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(endX, endY, { steps });
    await page.mouse.up();
    for (const m of [...modifiers].reverse()) await page.keyboard.up(m);
    return ok({ startX, startY, endX, endY, steps });
  },

  // -- Content extraction -----------------------------------------------------

  screenshot: async ({ values, cwd }) => {
    const page = getPage();
    const format = (str(values, 'format') ?? 'png') as 'png' | 'jpeg';
    const quality = num(values, 'quality');
    const selector = str(values, 'selector');
    const output = str(values, 'output');

    const shotOptions: Record<string, unknown> = { type: format };
    if (quality !== undefined && format !== 'png') shotOptions['quality'] = quality;

    let data: Buffer;
    if (selector) {
      const locator = page.locator(selector).first();
      if ((await locator.count()) === 0) return fail(`Element not found: ${selector}`);
      data = await locator.screenshot(shotOptions);
    } else {
      if (bool(values, 'full-page')) shotOptions['fullPage'] = true;
      data = await page.screenshot(shotOptions);
    }

    if (output) {
      const outputPath = resolvePath(cwd, output);
      writeFileSync(outputPath, data);
      return ok({ path: outputPath, format });
    }
    return ok({ data: data.toString('base64'), format, encoding: 'base64' });
  },

  html: async ({ values }) => {
    const page = getPage();
    const selector = str(values, 'selector');
    const expression = selector
      ? `document.querySelector(${JSON.stringify(selector)})?.outerHTML ?? null`
      : 'document.documentElement.outerHTML';
    const html = await page.evaluate<string | null>(expression);
    if (html === null) {
      return fail(selector ? `Element not found: ${selector}` : 'Could not get HTML');
    }
    return ok({ html });
  },

  'accessibility-tree': async () => {
    const page = getPage();
    const walkerResult = await page.evaluate<{
      tree?: Record<string, unknown>;
      nodeCount?: number;
    } | null>(getDomWalkerScript());
    if (!walkerResult?.tree) return fail('DOM walker returned empty tree');
    const normalised = normalizeAriaTree(walkerResult.tree as never);
    const snapshot = renderAriaSnapshot(normalised);
    const refs = extractRefMap(normalised);
    return ok({
      snapshot,
      ...(Object.keys(refs).length > 0 ? { refs } : {}),
      nodeCount: walkerResult.nodeCount,
    });
  },

  'extract-data': async ({ values, positionals }) => {
    const page = getPage();
    const type = positionals[0] ?? str(values, 'action');
    const selector = str(values, 'selector');
    if (type === 'table') {
      const script = `(() => {
        const table = document.querySelector(${JSON.stringify(selector ?? 'table')});
        if (!table) return null;
        const headers = Array.from(table.querySelectorAll('th')).map(th => th.textContent?.trim());
        const rows = Array.from(table.querySelectorAll('tbody tr')).map(tr =>
          Array.from(tr.querySelectorAll('td')).map(td => td.textContent?.trim())
        );
        return { headers, rows };
      })()`;
      const data = await page.evaluate(script);
      if (!data) return fail('Table not found');
      return ok({ type: 'table', data });
    }
    if (type === 'structured') {
      const script = `(() => {
        const meta = {};
        document.querySelectorAll('meta').forEach(m => {
          const name = m.getAttribute('name') || m.getAttribute('property');
          if (name) meta[name] = m.getAttribute('content');
        });
        return {
          title: document.title,
          url: location.href,
          meta,
          headings: Array.from(document.querySelectorAll('h1,h2,h3')).map(h => ({
            level: h.tagName, text: h.textContent?.trim()
          })),
          links: Array.from(document.querySelectorAll('a[href]')).slice(0, 50).map(a => ({
            text: a.textContent?.trim(), href: a.href
          })),
          images: Array.from(document.querySelectorAll('img')).slice(0, 20).map(i => ({
            alt: i.alt, src: i.src
          })),
        };
      })()`;
      const data = await page.evaluate(script);
      return ok({ type: 'structured', data });
    }
    return fail(`Unknown extraction type: ${String(type)}. Use "table" or "structured".`);
  },

  metadata: async () => {
    const page = getPage();
    const script = `(() => ({
      title: document.title,
      url: location.href,
      description: document.querySelector('meta[name="description"]')?.content ?? '',
      canonical: document.querySelector('link[rel="canonical"]')?.href ?? '',
      favicon: document.querySelector('link[rel="icon"]')?.href ?? document.querySelector('link[rel="shortcut icon"]')?.href ?? '',
      ogTitle: document.querySelector('meta[property="og:title"]')?.content ?? '',
      ogDescription: document.querySelector('meta[property="og:description"]')?.content ?? '',
      ogImage: document.querySelector('meta[property="og:image"]')?.content ?? '',
      ogUrl: document.querySelector('meta[property="og:url"]')?.content ?? '',
      lang: document.documentElement.lang ?? '',
    }))()`;
    return ok({ metadata: await page.evaluate(script) });
  },

  // -- Script execution -------------------------------------------------------

  execute: async ({ values, positionals }) => {
    const script = positionals[0];
    if (!script) return fail('Usage: agentic-browser execute <script>');
    if (str(values, 'target')) return fail(WEBKIT_TARGET_FLAG_ERROR);
    const page = getPage();
    const result = await page.evaluate(script);
    return ok({ result });
  },

  console: async ({ positionals }) => {
    const script = positionals[0];
    if (!script) return fail('Usage: agentic-browser console <command>');
    const page = getPage();
    const result = await page.evaluate(script);
    return ok({ result });
  },

  // -- Wait operations --------------------------------------------------------

  'wait-for-selector': async ({ values, positionals }) => {
    const page = getPage();
    const selector = positionals[0] ?? str(values, 'selector');
    if (!selector) return fail('Usage: agentic-browser wait-for-selector <selector>');
    const condition = (str(values, 'condition') ?? 'visible') as 'visible' | 'hidden' | 'present';
    const timeout = num(values, 'timeout') ?? 30_000;
    const state = condition === 'present' ? 'attached' : condition;
    try {
      await page.waitForSelector(selector, { state, timeout });
      return ok({ selector, condition });
    } catch {
      return fail(
        `Timed out waiting for selector "${selector}" (${condition}) after ${String(timeout)}ms`,
      );
    }
  },

  'wait-for-navigation': async ({ values }) => {
    const page = getPage();
    const timeout = num(values, 'timeout') ?? 30_000;
    await page.waitForEvent('load', { timeout });
    return ok();
  },

  'wait-for-network-idle': async ({ values }) => {
    const page = getPage();
    const timeout = num(values, 'timeout') ?? 30_000;
    try {
      await page.waitForLoadState('networkidle', { timeout });
      return ok();
    } catch {
      return fail(`Network did not become idle within ${String(timeout)}ms`);
    }
  },

  'wait-for-condition': async ({ values, positionals }) => {
    const expression = positionals[0];
    if (!expression) return fail('Usage: agentic-browser wait-for-condition <expression>');
    const page = getPage();
    const timeout = num(values, 'timeout') ?? 30_000;
    try {
      const handle = await page.waitForFunction(expression, undefined, { timeout, polling: 250 });
      const value = await handle.jsonValue();
      return ok({ expression, value });
    } catch {
      return fail(`Condition not met within ${String(timeout)}ms: ${expression}`);
    }
  },

  // -- Tab management ---------------------------------------------------------

  'list-tabs': async () => {
    const pages = context.pages();
    const tabs = await Promise.all(
      pages.map(async (p) => ({
        id: registerPage(p),
        title: await p.title().catch(() => ''),
        url: p.url(),
        active: p === activePage,
      })),
    );
    return ok({ tabs, count: tabs.length });
  },

  'create-tab': async ({ values, positionals }) => {
    const url = str(values, 'url') ?? positionals[0];
    const page = await context.newPage();
    const id = registerPage(page);
    if (url) await page.goto(url, { waitUntil: 'load', timeout: 60_000 });
    activePage = page;
    return ok({ id, title: await page.title().catch(() => ''), url: page.url() });
  },

  'switch-tab': async ({ positionals }) => {
    const id = positionals[0];
    if (!id) return fail('Usage: agentic-browser switch-tab <tab-id>');
    const page = findPage(id);
    if (!page) return fail(`Tab not found: ${id}. Use list-tabs to see open tabs.`);
    activePage = page;
    await page.bringToFront();
    return ok({ id: tabIds.get(page) });
  },

  'close-tab': async ({ positionals }) => {
    const id = positionals[0];
    if (!id) return fail('Usage: agentic-browser close-tab <tab-id>');
    const page = findPage(id);
    if (!page) return fail(`Tab not found: ${id}. Use list-tabs to see open tabs.`);
    await page.close();
    return ok({ id });
  },

  // -- Device emulation ---------------------------------------------------------

  'emulate-device': async ({ values }) => {
    const page = getPage();
    const userAgent = str(values, 'user-agent');
    if (userAgent) {
      return fail(
        '--user-agent is not supported on the webkit engine: Playwright WebKit can only set the user agent at context creation. Use the chrome/edge engine for UA overrides.',
      );
    }
    const presetName = str(values, 'preset');
    let preset: (typeof DEVICE_PRESETS)[string] | undefined;
    if (presetName) {
      const key = presetName.toLowerCase().replace(/\s+/g, '-');
      preset = DEVICE_PRESETS[key];
      if (!preset) {
        return fail(
          `Unknown preset: ${presetName}. Available: ${Object.keys(DEVICE_PRESETS).join(', ')}`,
        );
      }
    }
    const width = num(values, 'width') ?? preset?.width ?? 375;
    const height = num(values, 'height') ?? preset?.height ?? 812;
    let finalWidth = width;
    let finalHeight = height;
    if (str(values, 'orientation') === 'landscape' && height > width) {
      finalWidth = height;
      finalHeight = width;
    }
    await page.setViewportSize({ width: finalWidth, height: finalHeight });
    const notApplied: string[] = [];
    if (preset?.userAgent ?? str(values, 'user-agent')) notApplied.push('userAgent');
    if (float(values, 'device-scale-factor') ?? preset?.deviceScaleFactor)
      notApplied.push('deviceScaleFactor');
    if (bool(values, 'mobile') || preset?.mobile) notApplied.push('touchEmulation');
    return ok({
      action: 'emulate',
      width: finalWidth,
      height: finalHeight,
      preset: presetName,
      ...(notApplied.length > 0
        ? {
            note: `webkit engine applied viewport size only; not applied (require context creation on webkit): ${notApplied.join(', ')}`,
          }
        : {}),
    });
  },

  'reset-emulation': async () => {
    const page = getPage();
    await page.setViewportSize(DEFAULT_VIEWPORT);
    return ok({ action: 'reset' });
  },

  // -- Dialog handling ----------------------------------------------------------

  'handle-dialog': async ({ values, positionals }) => {
    const action = (positionals[0] ?? str(values, 'action')) as 'accept' | 'dismiss' | undefined;
    if (!action || !['accept', 'dismiss'].includes(action)) {
      return fail('Usage: agentic-browser handle-dialog <accept|dismiss> --trigger <expr>');
    }
    const trigger = str(values, 'trigger');
    if (!trigger)
      return fail('Missing --trigger <expression>. Provide the JS that triggers the dialog.');
    const promptText = str(values, 'prompt-text');
    const timeout = num(values, 'timeout') ?? 10_000;
    const page = getPage();

    const dialogInfo = new Promise<{ type: string; message: string }>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`No dialog appeared within ${String(timeout)}ms`));
      }, timeout);
      page.once('dialog', (dialog) => {
        clearTimeout(timer);
        const info = { type: dialog.type(), message: dialog.message() };
        void (action === 'accept' ? dialog.accept(promptText) : dialog.dismiss())
          .then(() => {
            resolve(info);
          })
          .catch((e: unknown) => {
            reject(e instanceof Error ? e : new Error(String(e)));
          });
      });
    });

    void page.evaluate(trigger).catch(() => {
      /* resolves only after dialog handled */
    });
    const info = await dialogInfo;
    return ok({ action, dialogType: info.type, dialogMessage: info.message });
  },

  // -- File operations ------------------------------------------------------------

  'upload-file': async ({ values, positionals, cwd }) => {
    const page = getPage();
    const selector = positionals[0] ?? str(values, 'selector');
    if (!selector) return fail('Usage: agentic-browser upload-file <selector> <file...>');
    const files = positionals.slice(1).map((p) => resolvePath(cwd, p));
    if (files.length === 0) return fail('Usage: agentic-browser upload-file <selector> <file...>');
    await page.setInputFiles(selector, files, { timeout: 10_000 });
    return ok({ selector, files, count: files.length });
  },

  download: async ({ values, positionals, cwd }) => {
    const url = positionals[0] ?? str(values, 'url');
    if (!url) return fail('Usage: agentic-browser download <url> [--output path]');
    const page = getPage();
    const fetchScript = `(async () => {
      try {
        const res = await fetch(${JSON.stringify(url)});
        if (!res.ok) return { error: res.status + ' ' + res.statusText };
        const blob = await res.blob();
        const reader = new FileReader();
        return new Promise(resolve => {
          reader.onload = () => {
            const dataUrl = reader.result;
            const base64 = dataUrl.toString().split(',')[1] || '';
            resolve({ base64, type: blob.type, size: blob.size });
          };
          reader.readAsDataURL(blob);
        });
      } catch (e) {
        return { error: e.message };
      }
    })()`;
    const value = await page.evaluate<{
      base64?: string;
      type?: string;
      error?: string;
    } | null>(fetchScript);
    if (!value) return fail('Download failed: no response');
    if (value.error) return fail(`Download failed: ${value.error}`);
    if (!value.base64) return fail('Download failed: empty response body');
    const filename = str(values, 'output') ?? url.split('/').pop()?.split('?')[0] ?? 'download';
    const savePath = resolvePath(cwd, filename);
    const data = Buffer.from(value.base64, 'base64');
    writeFileSync(savePath, data);
    return ok({ url, path: savePath, size: data.length, mimeType: value.type });
  },

  // -- Network ---------------------------------------------------------------------

  'network-log': async ({ values }) => {
    const page = getPage();
    const duration = num(values, 'duration') ?? 5000;
    const entries = new Map<
      string,
      { url: string; method: string; type?: string; status?: number; mimeType?: string }
    >();
    const onRequest = (req: PwRequest): void => {
      entries.set(req.url() + '#' + req.method(), {
        url: req.url(),
        method: req.method(),
        type: req.resourceType(),
      });
    };
    const onResponse = (res: PwResponse): void => {
      const key = res.url() + '#' + res.request().method();
      const entry = entries.get(key);
      if (entry) {
        entry.status = res.status();
        entry.mimeType = res.headers()['content-type'];
      }
    };
    page.on('request', onRequest);
    page.on('response', onResponse);
    await sleep(duration);
    page.off('request', onRequest);
    page.off('response', onResponse);
    const requests = [...entries.values()];
    return ok({ requests, count: requests.length, durationMs: duration });
  },

  // -- Cookies ---------------------------------------------------------------------

  'get-cookies': async ({ values }) => {
    const domain = str(values, 'domain');
    let cookies = await context.cookies();
    if (domain) cookies = cookies.filter((c) => c.domain.includes(domain));
    return ok({ cookies, count: cookies.length });
  },

  'set-cookie': async ({ values }) => {
    const name = str(values, 'name');
    const value = str(values, 'value');
    const domain = str(values, 'domain');
    if (!name || !value || !domain) {
      return fail('Usage: agentic-browser set-cookie --name X --value Y --domain D');
    }
    const sameSiteRaw = str(values, 'same-site');
    const sameSite = sameSiteRaw
      ? ((sameSiteRaw.charAt(0).toUpperCase() + sameSiteRaw.slice(1).toLowerCase()) as
          | 'Strict'
          | 'Lax'
          | 'None')
      : undefined;
    await context.addCookies([
      {
        name,
        value,
        domain,
        path: str(values, 'path') ?? '/',
        secure: bool(values, 'secure'),
        httpOnly: bool(values, 'http-only'),
        ...(sameSite ? { sameSite } : {}),
        ...(num(values, 'expires') !== undefined ? { expires: num(values, 'expires') } : {}),
      },
    ]);
    return ok({ name, domain });
  },

  'delete-cookie': async ({ values }) => {
    const name = str(values, 'name');
    const domain = str(values, 'domain');
    if (!name || !domain) return fail('Usage: agentic-browser delete-cookie --name X --domain D');
    await context.clearCookies({ name, domain });
    return ok({ name, domain });
  },

  // -- DOM modification --------------------------------------------------------------

  'inject-css': async ({ positionals }) => {
    const css = positionals[0];
    if (!css) return fail('Usage: agentic-browser inject-css <css>');
    const page = getPage();
    const injected = await page.evaluate(`(() => {
      const style = document.createElement('style');
      style.setAttribute('data-agentic-browser', 'injected');
      style.textContent = ${JSON.stringify(css)};
      document.head.appendChild(style);
      return true;
    })()`);
    return ok({ injected: injected === true });
  },

  'modify-attribute': async ({ positionals, values }) => {
    const selector = positionals[0] ?? str(values, 'selector');
    const attribute = positionals[1];
    if (!selector || !attribute) {
      return fail('Usage: agentic-browser modify-attribute <selector> <attribute> [value]');
    }
    const value = positionals[2];
    const page = getPage();
    const script =
      value !== undefined
        ? `(() => {
          const el = document.querySelector(${JSON.stringify(selector)});
          if (!el) return null;
          el.setAttribute(${JSON.stringify(attribute)}, ${JSON.stringify(value)});
          return { set: true };
        })()`
        : `(() => {
          const el = document.querySelector(${JSON.stringify(selector)});
          if (!el) return null;
          el.removeAttribute(${JSON.stringify(attribute)});
          return { removed: true };
        })()`;
    const result = await page.evaluate(script);
    if (result === null) return fail(`Element not found: ${selector}`);
    return ok({ selector, attribute, ...(result as Record<string, unknown>) });
  },

  'insert-html': async ({ positionals, values }) => {
    const selector = positionals[0] ?? str(values, 'selector');
    const html = positionals[1];
    if (!selector || !html) return fail('Usage: agentic-browser insert-html <selector> <html>');
    const position = str(values, 'position') ?? 'beforeend';
    const page = getPage();
    const result = await page.evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      el.insertAdjacentHTML(${JSON.stringify(position)}, ${JSON.stringify(html)});
      return true;
    })()`);
    if (result === null) return fail(`Element not found: ${selector}`);
    return ok({ selector, position });
  },

  'remove-element': async ({ positionals, values }) => {
    const selector = positionals[0] ?? str(values, 'selector');
    if (!selector) return fail('Usage: agentic-browser remove-element <selector>');
    const page = getPage();
    const result = await page.evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      el.remove();
      return true;
    })()`);
    if (result === null) return fail(`Element not found: ${selector}`);
    return ok({ selector, removed: true });
  },
};

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

async function dispatch(payload: CommandPayload): Promise<CmdResult> {
  const { command, values } = payload;

  const unsupported = WEBKIT_UNSUPPORTED[command];
  if (unsupported) return fail(unsupported);

  // --target carries CDP target semantics; reject on every command.
  if (typeof values['target'] === 'string') return fail(WEBKIT_TARGET_FLAG_ERROR);

  const handler = handlers[command];
  if (!handler) {
    return fail(`Unknown command on webkit engine: ${command}. Run with --help for usage.`);
  }
  try {
    return await handler(payload);
  } catch (error: unknown) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk: Buffer) => (body += chunk.toString()));
    req.on('end', () => {
      resolve(body);
    });
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, data: unknown): void {
  const body = JSON.stringify(data);
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(body);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const portIdx = args.indexOf('--port');
  const port = portIdx >= 0 ? parseInt(args[portIdx + 1] ?? '9222', 10) : 9222;
  headless = args.includes('--headless');

  process.stderr.write(
    `[webkit-daemon] launching Playwright WebKit (headless=${String(headless)})...\n`,
  );
  browser = await webkit.launch({ headless });
  context = await browser.newContext({ viewport: DEFAULT_VIEWPORT });
  context.on('page', (page) => {
    registerPage(page);
  });
  activePage = await context.newPage();
  registerPage(activePage);

  browser.on('disconnected', () => {
    process.stderr.write('[webkit-daemon] browser disconnected, exiting\n');
    process.exit(0);
  });

  const server = createServer((req, res) => {
    void (async () => {
      try {
        if (req.method === 'GET' && req.url === '/status') {
          sendJson(res, {
            success: true,
            engine: 'webkit',
            ready: true,
            browserVersion: browser.version(),
            headless,
            pages: context.pages().length,
            pid: process.pid,
          });
          return;
        }
        if (req.method === 'POST' && req.url === '/shutdown') {
          sendJson(res, { success: true, message: 'WebKit engine stopped' });
          server.close();
          await browser.close().catch(() => undefined);
          process.exit(0);
        }
        if (req.method === 'POST' && req.url === '/command') {
          const body = await readBody(req);
          const payload = JSON.parse(body) as CommandPayload;
          const result = await dispatch(payload);
          sendJson(res, result);
          return;
        }
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Not found' }));
      } catch (error: unknown) {
        sendJson(res, {
          success: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    })();
  });

  // Localhost ONLY — the daemon has no authentication.
  server.listen(port, '127.0.0.1', () => {
    process.stderr.write(
      `[webkit-daemon] ready on 127.0.0.1:${String(port)} (${browser.version()})\n`,
    );
  });
}

main().catch((error: unknown) => {
  process.stderr.write(
    `[webkit-daemon] fatal: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
});
