/**
 * Step-by-step session operations without a browser: action parsing (named keys only), the person's Chrome through a
 * scripted bridge (keys, history, unsupported kinds, the secret-field rule), the typed setup when that Chrome is not
 * paired, and the backend-neutral operations over a fake target (wait, read, evaluate/log/dialog refusals).
 */
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BrowserService, parseAction } from '../src/capabilities.js';
import { findChrome } from '../src/chrome/launcher.js';
import { checkUploadPaths } from '../src/chrome/tab.js';
import * as ops from '../src/session-ops.js';
import { BridgeError, type BridgeClient, type BridgeElement } from '../src/user/bridge.js';
import { CONNECT_YOUR_BROWSER } from '../src/user/routing.js';
import {
  BRIDGE_ADDRESS,
  setupFor,
  userBrowserStatus,
  WEBSITE_INSTALL,
  type UserBrowserReason,
} from '../src/user/status.js';
import { UserTab } from '../src/user/tab.js';
import { FakeDecider, FakeTarget, el, page } from './helpers.js';

const URL = 'https://shop.example.com/account';
const PAIRED = {
  listening: true,
  connected: true,
  browser: { origin: 'chrome-extension://x', hello: { extensionVersion: '0.9.0' } },
};

function item(ref: string, extra: Partial<BridgeElement> = {}): BridgeElement {
  return {
    ref,
    role: 'button',
    name: `Button ${ref}`,
    tag: 'button',
    inViewport: true,
    x: 1,
    y: 1,
    w: 9,
    h: 9,
    ...extra,
  };
}

type Handler = (input: Record<string, unknown>) => unknown;

class FakeBridge implements BridgeClient {
  readonly calls: { name: string; input: Record<string, unknown> }[] = [];
  handlers: Record<string, Handler>;
  constructor(elements: BridgeElement[] = [item('e1')], handlers: Record<string, Handler> = {}) {
    this.handlers = {
      'browserbridge.status': () => PAIRED,
      'browserbridge.tabs.open': () => ({ tabId: 7, url: URL }),
      'browserbridge.tabs.navigate': () => ({ tabId: 7 }),
      'browserbridge.tabs.list': () => ({ tabs: [{ tabId: 7, url: URL, loading: false }] }),
      'browserbridge.tabs.close': () => ({ closed: true }),
      'browserbridge.key': () => ({ pressed: true }),
      'browserbridge.snapshot': () => ({
        tabId: 7,
        url: URL,
        title: 'Account',
        viewport: { width: 100, height: 50 },
        scroll: { x: 0, y: 0, height: 50 },
        text: 'Your account',
        elements,
      }),
      ...handlers,
    };
  }
  call<T>(name: string, input: Record<string, unknown>): Promise<T> {
    this.calls.push({ name, input });
    const handler = this.handlers[name];
    if (!handler) return Promise.reject(new BridgeError('unsupported', `${name} missing`));
    try {
      return Promise.resolve(handler(input) as T);
    } catch (error) {
      return Promise.reject(error as Error);
    }
  }
  named(name: string): Record<string, unknown>[] {
    return this.calls.filter((call) => call.name === name).map((call) => call.input);
  }
}

const services: BrowserService[] = [];
afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.dispose()));
});
function service(bridge: BridgeClient | undefined): BrowserService {
  const created = new BrowserService(
    () => new FakeDecider([]),
    { artifactDir: path.join(os.tmpdir(), 'mb-session-ops') },
    bridge ? () => bridge : undefined,
  );
  services.push(created);
  return created;
}
const out = async (
  s: BrowserService,
  name: string,
  input: Record<string, unknown>,
): Promise<Record<string, unknown>> =>
  (await s.invoke(name, input)).output as Record<string, unknown>;

describe('parseAction: the session-only kinds', () => {
  it('press takes named keys and modifiers only', () => {
    expect(parseAction({ kind: 'press', key: 'Enter' })).toEqual({
      kind: 'press',
      key: 'Enter',
      modifiers: [],
    });
    expect(parseAction({ kind: 'press', key: 'Tab', modifiers: ['Shift', 'Shift'] })).toEqual({
      kind: 'press',
      key: 'Tab',
      modifiers: ['Shift'],
    });
    // A printable character (and so Meta+V, a paste) is not a key press: text goes through type.
    expect(() => parseAction({ kind: 'press', key: 'a' })).toThrow(/BROWSER_BAD_INPUT/);
    expect(() => parseAction({ kind: 'press', key: 'v', modifiers: ['Meta'] })).toThrow(
      /BROWSER_BAD_INPUT/,
    );
    expect(() => parseAction({ kind: 'press', key: 'Enter', modifiers: ['Hyper'] })).toThrow(
      /BROWSER_BAD_INPUT/,
    );
  });

  it('hover needs a ref; upload needs a list of paths; forward and reload take nothing', () => {
    expect(parseAction({ kind: 'hover', ref: 'e3' })).toEqual({ kind: 'hover', ref: 'e3' });
    expect(() => parseAction({ kind: 'hover' })).toThrow(/BROWSER_BAD_INPUT/);
    expect(parseAction({ kind: 'upload', paths: ['/a'] })).toEqual({
      kind: 'upload',
      ref: '',
      paths: ['/a'],
    });
    expect(() => parseAction({ kind: 'upload', paths: '/a' })).toThrow(/BROWSER_BAD_INPUT/);
    expect(parseAction({ kind: 'forward' })).toEqual({ kind: 'forward' });
    expect(parseAction({ kind: 'reload' })).toEqual({ kind: 'reload' });
  });

  it('upload paths must be absolute existing files within the limits', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'mb-upload-'));
    const file = path.join(dir, 'a.txt');
    writeFileSync(file, 'x');
    expect(await checkUploadPaths([file])).toEqual([file]);
    expect(await checkUploadPaths(['a.txt'])).toMatch(/not an absolute path/);
    expect(await checkUploadPaths([dir])).toMatch(/not a readable file/);
    expect(await checkUploadPaths([path.join(dir, 'missing')])).toMatch(/not a readable file/);
    expect(await checkUploadPaths([])).toMatch(/no file/);
    expect(await checkUploadPaths(Array.from({ length: 11 }, () => file))).toMatch(/at most 10/);
  });
});

describe("the person's own Chrome (user backend) through the bridge", () => {
  const sleep = { sleep: () => Promise.resolve() };

  it('press goes to browserbridge.key; forward and reload go to tabs.navigate', async () => {
    const bridge = new FakeBridge();
    const tab = await UserTab.open(bridge, URL, sleep);
    await tab.snapshot();
    expect(await tab.act({ kind: 'press', key: 'Escape', modifiers: [] })).toMatchObject({
      ok: true,
    });
    expect(await tab.act({ kind: 'press', key: 'Space', modifiers: ['Shift'] })).toMatchObject({
      ok: true,
    });
    expect(bridge.named('browserbridge.key')).toEqual([
      { tabId: 7, key: 'Escape' },
      { tabId: 7, key: ' ', modifiers: ['Shift'] },
    ]);
    await tab.act({ kind: 'forward' });
    await tab.act({ kind: 'reload' });
    expect(bridge.named('browserbridge.tabs.navigate').map((call) => call['url'])).toEqual([
      'forward',
      'reload',
    ]);
  });

  it('a key that edits text is refused while the page shows a password field; Enter is not', async () => {
    const bridge = new FakeBridge([
      item('e1'),
      item('e2', { tag: 'input', type: 'password', role: 'textbox' }),
    ]);
    const tab = await UserTab.open(bridge, URL, sleep);
    await tab.snapshot();
    for (const key of ['Backspace', 'Delete', 'Space'] as const) {
      const outcome = await tab.act({ kind: 'press', key, modifiers: [] });
      expect(outcome.ok, key).toBe(false);
      expect(outcome.error).toMatch(/secret-field/);
    }
    expect(bridge.named('browserbridge.key')).toEqual([]);
    expect(await tab.act({ kind: 'press', key: 'Enter', modifiers: [] })).toMatchObject({
      ok: true,
    });
  });

  it('hover and upload are unsupported_on_backend there, never a substitute', async () => {
    const bridge = new FakeBridge();
    const s = service(bridge);
    const opened = await out(s, 'browser.session.open', { on: 'user', url: URL });
    const sessionId = opened['sessionId'];
    await out(s, 'browser.session.snapshot', { sessionId });
    for (const action of [
      { kind: 'hover', ref: 'e1' },
      { kind: 'upload', ref: 'e1', paths: ['/etc/hosts'] },
    ]) {
      const result = await out(s, 'browser.session.act', { sessionId, action });
      expect(result).toMatchObject({
        ok: false,
        status: 'unsupported_on_backend',
        backend: 'user',
      });
    }
    expect(bridge.calls.some((call) => call.name === 'browserbridge.click')).toBe(false);
  });

  it('evaluate, HTML, log and dialog are unsupported there; wait and text read work', async () => {
    const bridge = new FakeBridge();
    const s = service(bridge);
    const { sessionId } = (await out(s, 'browser.session.open', { on: 'user', url: URL })) as {
      sessionId: string;
    };
    for (const [name, input] of [
      ['browser.session.evaluate', { expression: '1 + 1' }],
      ['browser.session.read', { format: 'html' }],
      ['browser.session.log', {}],
      ['browser.session.dialog', {}],
    ] as const) {
      expect(await out(s, name, { sessionId, ...input }), name).toMatchObject({
        ok: false,
        status: 'unsupported_on_backend',
        backend: 'user',
      });
    }
    // The bridge's evaluate verb is never called, whatever was asked.
    expect(bridge.calls.some((call) => call.name === 'browserbridge.evaluate')).toBe(false);
    expect(await out(s, 'browser.session.wait', { sessionId, text: 'Your account' })).toMatchObject(
      { ok: true, met: true },
    );
    expect(await out(s, 'browser.session.read', { sessionId })).toMatchObject({
      ok: true,
      format: 'text',
    });
  });
});

describe("setup: how to connect the person's Chrome", () => {
  const reasons: Exclude<UserBrowserReason, 'paired'>[] = [
    'port_in_use',
    'no_socket',
    'control_off',
    'not_connected',
    'error',
  ];

  it('every not-ready reason carries steps; paired carries none', async () => {
    for (const reason of reasons) {
      const setup = setupFor(reason);
      expect(setup.reason).toBe(reason);
      expect(setup.steps.length, reason).toBeGreaterThan(0);
      expect(setup.storeListing).toBeNull();
    }
    expect((await userBrowserStatus(new FakeBridge())).setup).toBeUndefined();
    expect((await userBrowserStatus(undefined)).setup?.reason).toBe('no_socket');
  });

  it('not_connected names the carried folder by its absolute path, the bridge address and the switch; website and store copies are said not to connect', () => {
    const setup = setupFor('not_connected');
    const folder = setup.chromeExtension.folder;
    expect(folder && path.isAbsolute(folder)).toBe(true);
    expect(existsSync(path.join(String(folder), 'manifest.json'))).toBe(true);
    const text = setup.steps.join('\n');
    expect(text).toContain('chrome://extensions');
    expect(text).toContain('Developer mode');
    expect(text).toContain(`Load unpacked and pick this folder: ${String(folder)}`);
    expect(text).toContain(BRIDGE_ADDRESS);
    expect(text).toContain('Let Marley use this browser');
    expect(setup.chromeExtension).toMatchObject({
      repository: 'https://github.com/zyg-edge/marley-browser-extension',
      install: 'developer (Load unpacked)',
      version: '0.5.0',
      commit: '48cf63fb02b6533750bd114a7ae381cff2ce839b',
    });
    expect(setup.otherInstalls).toMatch(/Chrome Web Store/);
    expect(setup.otherInstalls).toMatch(/never to Marshal/);
    expect(setup.websiteInstall.url).toBe(WEBSITE_INSTALL);
    expect(setup.websiteInstall.note).toMatch(/does not connect this Marshal/);
    // A port configured elsewhere is the address the steps name.
    const other = setupFor('not_connected', { url: 'ws://127.0.0.1:17999/bridge', port: 17999 });
    expect(other.steps.join('\n')).toContain('ws://127.0.0.1:17999/bridge');
    // No carried folder (a broken install): the first step says so.
    expect(setupFor('not_connected', undefined, { folder: null }).steps[0]).toMatch(
      /carries no Chrome extension/,
    );
  });

  it('browser.status, a refused on:"user" session and a refused task all carry the setup', async () => {
    const bridge = new FakeBridge([], {
      'browserbridge.status': () => ({ listening: true, connected: false }),
    });
    const s = service(bridge);
    const status = await out(s, 'browser.status', {});
    const user = (status['backends'] as Record<string, unknown>[]).find(
      (entry) => entry['name'] === 'user',
    );
    expect(user).toMatchObject({
      ready: false,
      reason: 'not_connected',
      setup: { reason: 'not_connected' },
    });

    const opened = await out(s, 'browser.session.open', { on: 'user', url: URL });
    expect(opened).toMatchObject({
      ok: false,
      status: 'needs_owner',
      reason: 'user_browser_not_paired',
      userBrowser: { reason: 'not_connected' },
      setup: { reason: 'not_connected' },
    });
    expect(bridge.calls.some((call) => call.name === 'browserbridge.tabs.open')).toBe(false);

    const asked = await out(s, 'browser.ask', {
      on: 'user',
      url: URL,
      questions: { q: { type: 'predicate', instructions: 'x' } },
    });
    expect(asked).toMatchObject({ ok: false, setup: { reason: 'not_connected' } });
  });

  it("a task that needs the person's login stops with connect your browser and the setup", async () => {
    const bridge = new FakeBridge([], { 'browserbridge.status': () => ({ listening: false }) });
    const s = service(bridge);
    const result = await out(s, 'browser.task', {
      goal: 'read my inbox',
      on: 'user',
      startUrl: URL,
    });
    expect(result).toMatchObject({
      status: 'needs_owner',
      reason: CONNECT_YOUR_BROWSER,
      setup: { reason: 'no_socket' },
    });
  });
});

describe('backend-neutral operations over a target', () => {
  it('wait: met when the text shows, a timeout otherwise; textGone and urlIncludes', async () => {
    const target = new FakeTarget([page('https://a.example/done', [])]);
    expect(await ops.waitFor(target, { text: 'price 42' })).toMatchObject({ ok: true, met: true });
    expect(await ops.waitFor(target, { textGone: 'nothing like this' })).toMatchObject({
      met: true,
    });
    expect(await ops.waitFor(target, { urlIncludes: '/done' })).toMatchObject({
      met: true,
      url: 'https://a.example/done',
    });
    let clock = 0;
    const timedOut = await ops.waitFor(
      target,
      { text: 'never', timeoutMs: 1000 },
      () => {
        clock += 250;
        return Promise.resolve();
      },
      () => clock,
    );
    expect(timedOut).toMatchObject({ ok: false, met: false });
    await expect(ops.waitFor(target, {})).rejects.toThrow(/BROWSER_BAD_INPUT/);
  });

  it('read: text from every backend, cut at maxChars; HTML only where the backend has it', async () => {
    const target = new FakeTarget([page('https://a.example', [el('e1')])]);
    expect(await ops.read(target, { maxChars: 9 })).toMatchObject({
      ok: true,
      content: 'full page',
      truncated: true,
    });
    expect(await ops.read(target, { format: 'html' })).toMatchObject({
      status: 'unsupported_on_backend',
    });
  });

  it('evaluate runs only on a managed target that offers it', async () => {
    const target = new FakeTarget([page('https://a.example', [])]);
    expect(await ops.evaluate(target, { expression: '1' })).toMatchObject({
      status: 'unsupported_on_backend',
    });
    const managed = Object.assign(new FakeTarget([page('https://a.example', [])]), {
      evaluateExpression: () => Promise.resolve({ two: 2 }),
    });
    expect(await ops.evaluate(managed, { expression: '1 + 1' })).toEqual({
      ok: true,
      value: { two: 2 },
    });
    const user = Object.assign(new FakeTarget([page('https://a.example', [])]), {
      backend: 'user' as const,
      evaluateExpression: () => Promise.resolve(1),
    });
    expect(await ops.evaluate(user, { expression: '1' })).toMatchObject({
      status: 'unsupported_on_backend',
    });
    const huge = Object.assign(new FakeTarget([page('https://a.example', [])]), {
      evaluateExpression: () => Promise.resolve('x'.repeat(ops.EVALUATE_RESULT_MAX + 1)),
    });
    expect(await ops.evaluate(huge, { expression: 'x' })).toMatchObject({
      ok: false,
      error: expect.stringMatching(/result-too-large/),
    });
  });

  it('log kinds are validated', () => {
    expect(ops.logKinds(undefined)).toEqual(['console', 'network']);
    expect(ops.logKinds(['network', 'network'])).toEqual(['network']);
    expect(() => ops.logKinds(['cookies'])).toThrow(/BROWSER_BAD_INPUT/);
    expect(() => ops.logKinds([])).toThrow(/BROWSER_BAD_INPUT/);
  });
});

describe('Page Studio operations: viewport, screenshot options, the SDK host Chrome', () => {
  it('viewport input is checked field by field', () => {
    expect(
      ops.parseViewport({
        width: 390,
        height: 844,
        deviceScaleFactor: 2,
        mobile: true,
        touch: true,
      }),
    ).toEqual({ width: 390, height: 844, deviceScaleFactor: 2, mobile: true, touch: true });
    expect(ops.parseViewport({ sessionId: 's', width: 1280, height: 800 })).toEqual({
      width: 1280,
      height: 800,
    });
    for (const [bad, field] of [
      [{ width: 50, height: 800 }, /width/],
      [{ width: 1280.5, height: 800 }, /width/],
      [{ width: 1280, height: 20_000 }, /height/],
      [{ width: 1280, height: 800, deviceScaleFactor: 0 }, /deviceScaleFactor/],
      [{ width: 1280, height: 800, deviceScaleFactor: 5 }, /deviceScaleFactor/],
      [{ width: 1280, height: 800, mobile: 'yes' }, /mobile/],
      [{ width: 1280, height: 800, touch: 1 }, /touch/],
    ] as const)
      expect(() => ops.parseViewport(bad), JSON.stringify(bad)).toThrow(field);
  });

  it('screenshot options: png or jpeg, quality 0-100, a clip within the capture limit', () => {
    expect(ops.screenshotOptions({})).toEqual({ format: 'png' });
    expect(
      ops.screenshotOptions({
        format: 'jpeg',
        quality: 72,
        clip: { x: 0, y: 4000, width: 390, height: 1100 },
      }),
    ).toEqual({ format: 'jpeg', quality: 72, clip: { x: 0, y: 4000, width: 390, height: 1100 } });
    expect(() => ops.screenshotOptions({ format: 'webp' })).toThrow(/format/);
    expect(() => ops.screenshotOptions({ quality: 101 })).toThrow(/quality/);
    expect(() => ops.screenshotOptions({ clip: { x: -1, y: 0, width: 10, height: 10 } })).toThrow(
      /clip/,
    );
    expect(() =>
      ops.screenshotOptions({ clip: { x: 0, y: 0, width: 10, height: 30_001 } }),
    ).toThrow(/clip/);
    expect(
      ops.screenshotOptions({ clip: { x: 0, y: 0, width: 1280, height: 25_000 } }),
    ).toMatchObject({ clip: { height: 25_000 } });
  });

  it("the person's own Chrome is never resized or clipped: unsupported_on_backend, nothing sent", async () => {
    const bridge = new FakeBridge();
    const s = service(bridge);
    expect(
      await out(s, 'browser.session.open', {
        on: 'user',
        url: URL,
        viewport: { width: 390, height: 844 },
      }),
    ).toMatchObject({ ok: false, status: 'unsupported_on_backend', backend: 'user' });
    expect(bridge.named('browserbridge.tabs.open')).toEqual([]);
    const { sessionId } = (await out(s, 'browser.session.open', { on: 'user', url: URL })) as {
      sessionId: string;
    };
    expect(
      await out(s, 'browser.session.viewport', { sessionId, width: 390, height: 844 }),
    ).toMatchObject({ ok: false, status: 'unsupported_on_backend', backend: 'user' });
    expect(
      await out(s, 'browser.session.screenshot', {
        sessionId,
        clip: { x: 0, y: 0, width: 100, height: 100 },
      }),
    ).toMatchObject({ ok: false, status: 'unsupported_on_backend', backend: 'user' });
    expect(bridge.named('browserbridge.screenshot')).toEqual([]);
  });

  it('a marshal-sdk host Chrome (MARSHAL_SDK_CHROME) is found; MARSHAL_BROWSER_CHROME and chromePath come first', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'mb-chrome-env-'));
    const sdk = path.join(dir, 'sdk-chrome');
    const own = path.join(dir, 'own-chrome');
    writeFileSync(sdk, '');
    writeFileSync(own, '');
    expect(findChrome({ env: { MARSHAL_SDK_CHROME: sdk }, platform: 'aix' })).toEqual({
      path: sdk,
      source: 'env',
    });
    expect(
      findChrome({
        env: { MARSHAL_SDK_CHROME: sdk, MARSHAL_BROWSER_CHROME: own },
        platform: 'aix',
      }),
    ).toEqual({ path: own, source: 'env' });
    expect(
      findChrome({ chromePath: own, env: { MARSHAL_SDK_CHROME: sdk }, platform: 'aix' }),
    ).toEqual({ path: own, source: 'config' });
    expect(
      findChrome({ env: { MARSHAL_SDK_CHROME: path.join(dir, 'missing') }, platform: 'aix' }).path,
    ).toBeNull();
  });
});
