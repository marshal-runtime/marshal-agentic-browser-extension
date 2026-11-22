import { writeFileSync, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { BrowserService } from '../src/capabilities.js';
import { ManagedTab } from '../src/chrome/tab.js';
import type { DecideMultiInput } from '../src/contracts.js';
import { DecideError, type Decider } from '../src/engine/decider.js';
import { runTask } from '../src/engine/task.js';
import {
  BridgeError,
  createHostBridge,
  type BridgeClient,
  type BridgeElement,
  type BridgeSnapshot,
} from '../src/user/bridge.js';
import { decodePng, encodeJpeg, encodePng, scaleTo, type Rgba } from '../src/user/image.js';
import { CONNECT_YOUR_BROWSER } from '../src/user/routing.js';
import { bridgeToSnapshot } from '../src/user/snapshot.js';
import { userBrowserStatus } from '../src/user/status.js';
import { UserTab, type UserTabDeps } from '../src/user/tab.js';
import { FakeDecider, saveShot, type Turn } from './helpers.js';

const URL = 'https://shop.example.com/account';
const PAIRED = {
  listening: true,
  url: 'ws://127.0.0.1:17373/bridge',
  connected: true,
  browser: { origin: 'chrome-extension://x', hello: { extensionVersion: '0.9.0' } },
};

function solid(width: number, height: number, value = 255): Rgba {
  return { width, height, data: new Uint8Array(width * height * 4).fill(value) };
}

/** 200x100 PNG of a 100x50 CSS-pixel viewport (device pixel ratio 2). */
const PNG = encodePng(solid(200, 100));

function item(ref: string, extra: Partial<BridgeElement> = {}): BridgeElement {
  return {
    ref,
    role: 'button',
    name: `Button ${ref}`,
    tag: 'button',
    inViewport: true,
    x: 10,
    y: 10,
    w: 30,
    h: 10,
    ...extra,
  };
}

function snap(elements: BridgeElement[], extra: Partial<BridgeSnapshot> = {}): BridgeSnapshot {
  return {
    tabId: 7,
    url: URL,
    title: 'Account',
    viewport: { width: 100, height: 50 },
    scroll: { x: 0, y: 0, height: 50 },
    text: 'Your account',
    elements,
    ...extra,
  };
}

type Handler = (input: Record<string, unknown>) => unknown;
const SHOT_DIR = mkdtempSync(path.join(os.tmpdir(), 'mb-user-test-'));
let shots = 0;

/** A scripted browser bridge: each capability answers from a handler (or throws a BridgeError). */
class FakeBridge implements BridgeClient {
  readonly calls: { name: string; input: Record<string, unknown> }[] = [];
  readonly removed: string[] = [];
  handlers: Record<string, Handler>;
  constructor(handlers: Record<string, Handler> = {}) {
    this.handlers = {
      'browserbridge.status': () => PAIRED,
      'browserbridge.tabs.open': () => ({ tabId: 7, url: URL, title: 'Account' }),
      'browserbridge.tabs.navigate': (input) => ({ tabId: 7, url: input['url'] }),
      'browserbridge.tabs.close': () => ({ closed: true, tabId: 7 }),
      'browserbridge.tabs.list': () => ({ tabs: [{ tabId: 7, url: URL, loading: false }] }),
      'browserbridge.snapshot': () =>
        snap([item('e4'), item('e9', { tag: 'input', type: 'email', role: 'textbox' })]),
      // Like the bridge: a fresh PNG file per screenshot.
      'browserbridge.screenshot': () => {
        shots += 1;
        const file = path.join(SHOT_DIR, `tab-7-${String(shots)}.png`);
        writeFileSync(file, PNG);
        return { tabId: 7, width: 100, height: 50, path: file };
      },
      'browserbridge.click': () => ({ clicked: true, url: URL, loading: false }),
      'browserbridge.type': () => ({ typed: true }),
      'browserbridge.scroll': () => ({ scrolled: true }),
      ...handlers,
    };
  }
  call<T>(name: string, input: Record<string, unknown>): Promise<T> {
    this.calls.push({ name, input });
    const handler = this.handlers[name];
    if (!handler)
      return Promise.reject(
        new BridgeError('extension_missing', `${name} is not offered by this host`),
      );
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

const tabDeps = (bridge: FakeBridge): UserTabDeps => ({
  readFile: () => Promise.resolve(PNG),
  removeFile: (file: string) => {
    bridge.removed.push(file);
    return Promise.resolve();
  },
  sleep: () => Promise.resolve(),
});

async function openTab(bridge = new FakeBridge()): Promise<{ bridge: FakeBridge; tab: UserTab }> {
  const tab = await UserTab.open(bridge, URL, tabDeps(bridge));
  return { bridge, tab };
}

describe("browser.status: is the person's Chrome paired, and if not why", () => {
  it('extension_missing when the host has no browserbridge capability (or no bridge at all)', async () => {
    expect((await userBrowserStatus(undefined)).reason).toBe('extension_missing');
    const status = await userBrowserStatus(
      new FakeBridge({ 'browserbridge.status': undefined as never }),
    );
    expect(status).toMatchObject({ ready: false, reason: 'extension_missing' });
  });

  it('no_socket when the bridge is installed but not listening', async () => {
    const status = await userBrowserStatus(
      new FakeBridge({
        'browserbridge.status': () => ({ listening: false, connected: false, browser: null }),
      }),
    );
    expect(status).toMatchObject({ ready: false, reason: 'no_socket' });
  });

  it('not_connected when no Chrome said hello (extension absent, off, or no address: an old extension cannot say which)', async () => {
    const status = await userBrowserStatus(
      new FakeBridge({
        'browserbridge.status': () => ({ listening: true, connected: false, browser: null }),
      }),
    );
    expect(status).toMatchObject({ ready: false, reason: 'not_connected' });
    expect(status.detail).toContain('control switch is off');
  });

  it('control_off when the Chrome extension said it was switched off', async () => {
    const status = await userBrowserStatus(
      new FakeBridge({
        'browserbridge.status': () => ({
          listening: true,
          connected: false,
          browser: null,
          lastDisconnect: { reason: 'switched-off', at: '2026-11-22T10:00:00Z' },
        }),
      }),
    );
    expect(status).toMatchObject({ ready: false, reason: 'control_off' });
  });

  it('a socket that is open but has not said hello yet is not paired', async () => {
    const status = await userBrowserStatus(
      new FakeBridge({
        'browserbridge.status': () => ({
          listening: true,
          connected: true,
          browser: { hello: null },
        }),
      }),
    );
    expect(status.ready).toBe(false);
  });

  it('denied when the host policy refuses the bridge; error on anything else', async () => {
    const denied = new FakeBridge({
      'browserbridge.status': () => {
        throw new BridgeError('denied', 'policy');
      },
    });
    expect((await userBrowserStatus(denied)).reason).toBe('denied');
    const broken = new FakeBridge({
      'browserbridge.status': () => {
        throw new BridgeError('failed', 'boom');
      },
    });
    expect((await userBrowserStatus(broken)).reason).toBe('error');
  });

  it('paired, with the extension version and the screencast transport', async () => {
    expect(await userBrowserStatus(new FakeBridge())).toMatchObject({
      ready: true,
      reason: 'paired',
      extensionVersion: '0.9.0',
      screencast: 'polling',
    });
    const events = new FakeBridge({
      'browserbridge.status': () => ({
        ...PAIRED,
        browser: { hello: { extensionVersion: '1.0.0', capabilities: ['screencast'] } },
      }),
    });
    expect((await userBrowserStatus(events)).screencast).toBe('events');
  });
});

describe('host bridge client: host answers become typed codes', () => {
  const respond = (response: unknown): BridgeClient =>
    createHostBridge(() => Promise.resolve(response as never), undefined);
  it("maps not_found, denied, approval_required and the bridge's own codes", async () => {
    const codeOf = async (response: unknown): Promise<string> =>
      respond(response)
        .call('browserbridge.snapshot', { tabId: 1 })
        .then(
          () => 'ok',
          (error: BridgeError) => error.code,
        );
    expect(await codeOf({ status: 'not_found' })).toBe('extension_missing');
    expect(await codeOf({ status: 'denied' })).toBe('denied');
    expect(await codeOf({ status: 'approval_required' })).toBe('denied');
    expect(
      await codeOf({ status: 'failed', error: { code: 'browser-not-connected', message: 'x' } }),
    ).toBe('not_connected');
    expect(await codeOf({ status: 'failed', error: { code: 'stale-ref', message: 'x' } })).toBe(
      'stale_ref',
    );
    expect(
      await codeOf({ status: 'failed', error: { code: 'tab-not-in-group', message: 'x' } }),
    ).toBe('no_tab');
    expect(await codeOf({ status: 'failed', error: { code: 'page-error', message: 'x' } })).toBe(
      'failed',
    );
    const ok = await respond({ status: 'success', result: { output: { a: 1 } } }).call('x', {});
    expect(ok).toEqual({ a: 1 });
  });

  it("sends the exact capability name and input through execute with the caller's context", async () => {
    const seen: unknown[] = [];
    const context = { requestId: 'r1' } as never;
    const bridge = createHostBridge((request, ctx) => {
      seen.push(request, ctx);
      return Promise.resolve({
        protocolVersion: '1.0.0',
        status: 'success',
        result: { output: {} },
      });
    }, context);
    await bridge.call('browserbridge.tabs.open', { url: URL, active: false });
    expect(seen[0]).toMatchObject({
      targetType: 'operation',
      target: 'browserbridge.tabs.open',
      input: { url: URL, active: false },
    });
    expect(seen[1]).toBe(context);
  });
});

describe('snapshot: the same eN shape as the managed backend', () => {
  it('renumbers refs per snapshot, keeps the bridge ref as node, and maps kind, box, where, checked, offscreen', () => {
    const result = bridgeToSnapshot(
      snap(
        [
          item('e12', {
            tag: 'a',
            role: 'link',
            href: 'https://shop.example.com/orders',
            x: 80,
            y: 40,
          }),
          item('e3', { tag: 'input', type: 'checkbox', role: 'checkbox', checked: true }),
          item('e5', { tag: 'textarea', role: 'textbox', value: 'hello' }),
          item('e6', { disabled: true }),
          item('e7', { inViewport: false, y: 400 }),
          item('e8', { tag: 'select', role: 'combobox' }),
        ],
        { scroll: { x: 0, y: 0, height: 500 } },
      ),
    );
    expect(result.elements.map((element) => [element.ref, element.node, element.kind])).toEqual([
      ['e1', 'e12', 'click'],
      ['e2', 'e3', 'click'],
      ['e3', 'e5', 'fill'],
      ['e4', 'e7', 'click'],
      ['e5', 'e8', 'click'],
    ]);
    expect(result.elements[0]).toMatchObject({
      href: 'https://shop.example.com/orders',
      box: [80, 40, 30, 10],
      where: 'bottom-right',
    });
    expect(result.elements[1]?.checked).toBe('true');
    expect(result.elements[2]?.value).toBe('hello');
    expect(result.elements[3]).toMatchObject({ offscreen: true, where: 'below' });
    expect(result.omitted).toBe(1);
    expect(result.canScrollDown).toBe(true);
    expect(result.canScrollUp).toBe(false);
    expect(result.viewport).toEqual({ w: 100, h: 50 });
  });

  it("marks a field secret from the bridge's typed signals: password type, a masked value, or its secret flag", () => {
    const result = bridgeToSnapshot(
      snap([
        item('e1', { tag: 'input', type: 'password', role: 'textbox' }),
        item('e2', { tag: 'input', type: 'text', role: 'textbox', value: '(hidden)' }),
        item('e3', { tag: 'input', type: 'text', role: 'textbox', secret: true }),
        item('e4', { tag: 'input', type: 'text', role: 'textbox', value: 'plain' }),
      ]),
    );
    expect(result.elements.map((element) => element.secret === true)).toEqual([
      true,
      true,
      true,
      false,
    ]);
  });
});

describe("UserTab: the person's Chrome behind Target", () => {
  it('opens one background tab (never active) and closes only that tab', async () => {
    const { bridge, tab } = await openTab();
    expect(bridge.named('browserbridge.tabs.open')).toEqual([{ url: URL, active: false }]);
    expect(tab.backend).toBe('user');
    await tab.close();
    await tab.close();
    expect(bridge.named('browserbridge.tabs.close')).toEqual([{ tabId: 7 }]);
    expect(bridge.calls.some((call) => call.name === 'browserbridge.tabs.focus')).toBe(false);
  });

  it('refuses a non-http address before asking the bridge', async () => {
    const bridge = new FakeBridge();
    await expect(UserTab.open(bridge, 'file:///etc/passwd')).rejects.toThrow('BROWSER_BAD_INPUT');
    expect(bridge.calls).toHaveLength(0);
    const { tab } = await openTab(bridge);
    expect(await tab.act({ kind: 'navigate', url: 'javascript:alert(1)' })).toMatchObject({
      ok: false,
    });
    expect(bridge.named('browserbridge.tabs.navigate')).toHaveLength(0);
  });

  it("acts through the bridge with the element's own bridge ref", async () => {
    const { bridge, tab } = await openTab();
    await tab.snapshot();
    expect(await tab.act({ kind: 'click', ref: 'e1' })).toMatchObject({ ok: true });
    expect(bridge.named('browserbridge.click')).toEqual([{ tabId: 7, ref: 'e4' }]);
    expect(await tab.act({ kind: 'type', ref: 'e2', text: 'a@b.co' })).toMatchObject({ ok: true });
    expect(bridge.named('browserbridge.type')[0]).toEqual({
      tabId: 7,
      ref: 'e9',
      text: 'a@b.co',
      clear: true,
    });
    await tab.act({ kind: 'submit', ref: 'e2' });
    expect(bridge.named('browserbridge.type')[1]).toEqual({
      tabId: 7,
      ref: 'e9',
      text: '',
      submit: true,
    });
    await tab.act({ kind: 'scroll', direction: 'down' });
    expect(bridge.named('browserbridge.scroll')).toEqual([{ tabId: 7, dy: 40 }]);
    await tab.act({ kind: 'back' });
    expect(bridge.named('browserbridge.tabs.navigate')).toEqual([{ tabId: 7, url: 'back' }]);
  });

  it('never types into or clicks a secret field, even on a direct act', async () => {
    const bridge = new FakeBridge({
      'browserbridge.snapshot': () =>
        snap([
          item('e1', { tag: 'input', type: 'password', role: 'textbox' }),
          item('e2', { tag: 'input', type: 'text', role: 'textbox', secret: true }),
          item('e3', { tag: 'input', type: 'text', role: 'textbox', value: '(hidden)' }),
        ]),
    });
    const { tab } = await openTab(bridge);
    await tab.snapshot();
    for (const ref of ['e1', 'e2', 'e3']) {
      expect(await tab.act({ kind: 'type', ref, text: 'hunter2' })).toMatchObject({
        ok: false,
        error: expect.stringContaining('secret-field'),
      });
      expect(await tab.act({ kind: 'click', ref })).toMatchObject({ ok: false });
      expect(await tab.act({ kind: 'submit', ref })).toMatchObject({ ok: false });
    }
    expect(bridge.named('browserbridge.type')).toHaveLength(0);
    expect(bridge.named('browserbridge.click')).toHaveLength(0);
  });

  it('refuses an unknown ref, typing into a button and select (no options yet)', async () => {
    const { bridge, tab } = await openTab();
    await tab.snapshot();
    expect((await tab.act({ kind: 'click', ref: 'e99' })).ok).toBe(false);
    expect((await tab.act({ kind: 'type', ref: 'e1', text: 'x' })).ok).toBe(false);
    expect((await tab.act({ kind: 'select', ref: 'e1', value: 'x' })).error).toContain(
      'select-unsupported',
    );
    expect(bridge.named('browserbridge.type')).toHaveLength(0);
  });

  it('a failed bridge call is a failed step, and a vanished tab ends the session', async () => {
    const bridge = new FakeBridge({
      'browserbridge.click': () => {
        throw new BridgeError('no_tab', 'Tab 7 does not exist');
      },
    });
    const { tab } = await openTab(bridge);
    await tab.snapshot();
    expect(await tab.act({ kind: 'click', ref: 'e1' })).toMatchObject({ ok: false });
    expect(tab.isClosed).toBe(true);
  });

  it('marked screenshot: boxes and ref labels drawn on the picture at the device pixel ratio, file removed after reading', async () => {
    const { bridge, tab } = await openTab();
    const page = await tab.snapshot();
    const plain = await tab.screenshot();
    expect(plain.mimeType).toBe('image/png');
    expect(Buffer.from(plain.data, 'base64').equals(PNG)).toBe(true);
    const marked = await tab.screenshot({ marks: page.elements.slice(0, 1) });
    const image = decodePng(Buffer.from(marked.data, 'base64'));
    expect([image.width, image.height]).toEqual([200, 100]);
    // e1's box is [10, 10, 30, 10] CSS px: its left border at x=20, y=25 image px is the first mark colour.
    const at = (x: number, y: number): number[] => [
      ...image.data.subarray((y * 200 + x) * 4, (y * 200 + x) * 4 + 3),
    ];
    expect(at(20, 25)).toEqual([0xe6, 0x19, 0x4b]);
    expect(at(100, 90)).toEqual([255, 255, 255]);
    expect(bridge.removed).toHaveLength(2);
    const shot = await tab.screenshot({ format: 'jpeg', width: 50, quality: 70 });
    expect(shot.mimeType).toBe('image/jpeg');
    expect(Buffer.from(shot.data, 'base64').subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
  });

  it("fullText reads the page text with the bridge's largest text cap", async () => {
    const { bridge, tab } = await openTab();
    expect(await tab.fullText()).toBe('Your account');
    expect(bridge.named('browserbridge.snapshot')[0]).toMatchObject({ maxText: 50_000 });
  });
});

describe('screencast on the user backend', () => {
  it('falls back to polled screenshots when the bridge has no screencast verbs, and stops cleanly', async () => {
    const { bridge, tab } = await openTab();
    const frames: { data: string; width: number }[] = [];
    let stopHandle: { stop(): Promise<void> } | null = null;
    await new Promise<void>((resolve) => {
      void tab
        .screencast({ maxWidth: 100 }, (data, meta) => {
          frames.push({ data, width: meta.width });
          if (frames.length === 3) resolve();
        })
        .then((handle) => {
          stopHandle = handle;
        });
    });
    await (stopHandle as unknown as { stop(): Promise<void> }).stop();
    const after = bridge.named('browserbridge.screenshot').length;
    expect(frames.length).toBeGreaterThanOrEqual(3);
    expect(frames[0]?.width).toBe(100);
    expect(Buffer.from(frames[0]?.data ?? '', 'base64').subarray(0, 2)).toEqual(
      Buffer.from([0xff, 0xd8]),
    );
    expect(bridge.named('browserbridge.screencast.start')).toHaveLength(1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(bridge.named('browserbridge.screenshot').length).toBe(after);
  });

  it('pulls forwarded debugger frames when the bridge offers them, and stops the cast in Chrome', async () => {
    let seq = 0;
    const jpeg = encodeJpeg(solid(10, 10), 60).toString('base64');
    const bridge = new FakeBridge({
      'browserbridge.screencast.start': () => ({ started: true }),
      'browserbridge.screencast.next': (input) => {
        seq += 1;
        expect(input['after']).toBe(seq - 1);
        return { seq, data: jpeg, width: 10, height: 10, ts: 1000 + seq };
      },
      'browserbridge.screencast.stop': () => ({ stopped: true }),
    });
    const { tab } = await openTab(bridge);
    const seen: number[] = [];
    let handle: { stop(): Promise<void> } | null = null;
    await new Promise<void>((resolve) => {
      void tab
        .screencast({ maxWidth: 640, everyNthFrame: 2 }, (_data, meta) => {
          seen.push(meta.ts);
          if (seen.length === 2) resolve();
        })
        .then((h) => {
          handle = h;
        });
    });
    await (handle as unknown as { stop(): Promise<void> }).stop();
    expect(bridge.named('browserbridge.screencast.start')[0]).toMatchObject({
      tabId: 7,
      maxWidth: 640,
      everyNthFrame: 2,
    });
    expect(bridge.named('browserbridge.screencast.stop')).toEqual([{ tabId: 7 }]);
    expect(bridge.named('browserbridge.screenshot')).toHaveLength(0);
    expect(seen.slice(0, 2)).toEqual([1001, 1002]);
  });

  it("a start that fails for another reason is the caller's error, not a silent fallback", async () => {
    const bridge = new FakeBridge({
      'browserbridge.screencast.start': () => {
        throw new BridgeError('denied', 'policy');
      },
    });
    const { tab } = await openTab(bridge);
    // A started cast is stopped right away, so a wrong fallback fails here instead of polling on.
    const outcome = await tab
      .screencast({ maxWidth: 100 }, () => undefined)
      .then(
        async (handle) => {
          await handle.stop();
          return 'started';
        },
        (error: unknown) => (error instanceof BridgeError ? error.code : 'other'),
      );
    expect(outcome).toBe('denied');
  });
});

describe('image helpers', () => {
  it('round-trips a PNG and scales by area average', () => {
    const image = solid(4, 2, 0);
    image.data.set([255, 255, 255, 255], 0);
    const back = decodePng(encodePng(image));
    expect([...back.data]).toEqual([...image.data]);
    expect(scaleTo(back, 2)).toMatchObject({ width: 2, height: 1 });
    expect(scaleTo(back, 8)).toBe(back);
  });
});

/** A decider that answers the routing question, and the step questions from a FakeDecider. */
class RoutingDecider implements Decider {
  readonly routing: DecideMultiInput[] = [];
  constructor(
    private readonly needsLogin: number | Error,
    readonly steps = new FakeDecider([{ choice: 'done', goalMet: 0.95 } satisfies Turn]),
  ) {}
  judge(input: DecideMultiInput): ReturnType<Decider['judge']> {
    if ('needs_login' in input.questions) {
      this.routing.push(input);
      if (this.needsLogin instanceof Error) return Promise.reject(this.needsLogin);
      return Promise.resolve({
        success: true as const,
        answers: { needs_login: { type: 'predicate' as const, probability: this.needsLogin } },
      });
    }
    return this.steps.judge(input);
  }
  extract(input: Parameters<Decider['extract']>[0]): ReturnType<Decider['extract']> {
    return this.steps.extract(input);
  }
  probe(): ReturnType<Decider['probe']> {
    return this.steps.probe();
  }
}

describe("routing: a goal that needs the person's login never runs in another browser", () => {
  const services: BrowserService[] = [];
  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(services.splice(0).map((service) => service.dispose()));
  });
  const managedOpened = (): MockInstance<typeof ManagedTab.open> =>
    vi.spyOn(ManagedTab, 'open').mockRejectedValue(new Error('MANAGED_OPENED'));
  function service(
    decider: Decider,
    bridge: BridgeClient | undefined,
    configuration = {},
  ): BrowserService {
    const created = new BrowserService(
      () => decider,
      { artifactDir: '/tmp/marshal-browser-test', ...configuration },
      () => bridge as BridgeClient,
    );
    services.push(created);
    return created;
  }
  const unpaired = (): FakeBridge =>
    new FakeBridge({
      'browserbridge.status': () => ({ listening: true, connected: false, browser: null }),
    });

  it('auto + a login goal + Chrome not paired: needs_owner "connect your browser", no managed tab, no user tab', async () => {
    const spy = managedOpened();
    const bridge = unpaired();
    const decider = new RoutingDecider(0.93);
    const out = (
      await service(decider, bridge).invoke('browser.task', {
        goal: 'read my latest Shopify orders',
        startUrl: URL,
      })
    ).output as Record<string, unknown>;
    expect(out).toMatchObject({
      status: 'needs_owner',
      reason: CONNECT_YOUR_BROWSER,
      userBrowser: { reason: 'not_connected' },
    });
    expect(spy).not.toHaveBeenCalled();
    expect(bridge.named('browserbridge.tabs.open')).toHaveLength(0);
    expect(decider.routing).toHaveLength(1);
    expect(decider.steps.judged).toHaveLength(0);
  });

  it('auto + explicit needsLogin skips the routing question; each pairing reason is reported', async () => {
    const spy = managedOpened();
    const cases: [FakeBridge | undefined, string][] = [
      [undefined, 'extension_missing'],
      [new FakeBridge({ 'browserbridge.status': () => ({ listening: false }) }), 'no_socket'],
      [
        new FakeBridge({
          'browserbridge.status': () => ({
            listening: true,
            connected: false,
            lastDisconnect: { reason: 'switched-off' },
          }),
        }),
        'control_off',
      ],
    ];
    for (const [bridge, reason] of cases) {
      const decider = new RoutingDecider(0);
      const out = (
        await service(decider, bridge).invoke('browser.task', {
          goal: 'post on my Instagram',
          needsLogin: true,
          startUrl: URL,
        })
      ).output;
      expect(out).toMatchObject({
        status: 'needs_owner',
        reason: CONNECT_YOUR_BROWSER,
        userBrowser: { reason },
      });
      expect(decider.routing).toHaveLength(0);
    }
    expect(spy).not.toHaveBeenCalled();
  });

  it('on:"user" with Chrome not paired also stops with connect your browser (never managed)', async () => {
    const spy = managedOpened();
    const out = (
      await service(new RoutingDecider(0), unpaired()).invoke('browser.task', {
        goal: 'check my inbox',
        on: 'user',
        startUrl: URL,
      })
    ).output;
    expect(out).toMatchObject({ status: 'needs_owner', reason: CONNECT_YOUR_BROWSER });
    expect(spy).not.toHaveBeenCalled();
  });

  it("auto + a login goal + Chrome paired: runs in the person's Chrome, text-only decisions by default", async () => {
    const spy = managedOpened();
    const bridge = new FakeBridge();
    const decider = new RoutingDecider(
      0.9,
      new FakeDecider([{ choice: 'click e1' }, { choice: 'done', goalMet: 0.95 }]),
    );
    const out = (
      await service(decider, bridge).invoke('browser.task', {
        goal: 'open my orders page',
        startUrl: URL,
      })
    ).output as Record<string, unknown>;
    expect(out).toMatchObject({ ok: true, status: 'done', backend: 'user', profile: 'own' });
    expect(spy).not.toHaveBeenCalled();
    expect(bridge.named('browserbridge.tabs.open')).toEqual([{ url: URL, active: false }]);
    // Opened at startUrl once: no second load of the person's page.
    expect(bridge.named('browserbridge.tabs.navigate')).toHaveLength(0);
    expect(bridge.named('browserbridge.click')).toEqual([{ tabId: 7, ref: 'e4' }]);
    expect(decider.steps.judged.length).toBeGreaterThan(0);
    for (const judged of decider.steps.judged) expect(judged.images).toBeUndefined();
    // A per-call vision:true cannot override the owner's config on this backend.
    const again = new RoutingDecider(0.9);
    await service(again, new FakeBridge()).invoke('browser.task', {
      goal: 'open my orders page',
      startUrl: URL,
      vision: true,
    });
    expect(again.steps.judged[0]?.images).toBeUndefined();
    // The tab it opened is closed when the task ends.
    expect(bridge.named('browserbridge.tabs.close')).toEqual([{ tabId: 7 }]);
  });

  it('userVision:true attaches the marked 768-wide JPEG to decisions on the user backend', async () => {
    managedOpened();
    const decider = new RoutingDecider(0.9);
    await service(decider, new FakeBridge(), { userVision: true }).invoke('browser.task', {
      goal: 'open my orders',
      on: 'user',
      startUrl: URL,
    });
    expect((decider.steps.judged[0]?.images?.[0] as { url: string } | undefined)?.url).toMatch(
      /^data:image\/jpeg;base64,/,
    );
  });

  it('auto + a public goal goes to the managed Chrome (no bridge call at all)', async () => {
    const spy = managedOpened();
    const bridge = new FakeBridge();
    const out = (
      await service(new RoutingDecider(0.05), bridge).invoke('browser.task', {
        goal: 'find the price of a public product',
        startUrl: URL,
      })
    ).output;
    expect(spy).toHaveBeenCalledOnce();
    expect(out).toMatchObject({ ok: false, error: 'MANAGED_OPENED' });
    expect(bridge.calls).toHaveLength(0);
  });

  it('on:"managed" never asks the routing question', async () => {
    const spy = managedOpened();
    const decider = new RoutingDecider(0.99);
    await service(decider, new FakeBridge()).invoke('browser.task', {
      goal: 'read my orders',
      on: 'managed',
    });
    expect(decider.routing).toHaveLength(0);
    expect(spy).toHaveBeenCalledOnce();
  });

  it('decide unavailable while routing: decisions_unavailable, no tab anywhere', async () => {
    const spy = managedOpened();
    const bridge = new FakeBridge();
    const out = (
      await service(new RoutingDecider(new DecideError('NOT_FOUND', 'no decide')), bridge).invoke(
        'browser.task',
        { goal: 'read my orders', startUrl: URL },
      )
    ).output;
    expect(out).toMatchObject({ status: 'decisions_unavailable' });
    expect(spy).not.toHaveBeenCalled();
    expect(bridge.named('browserbridge.tabs.open')).toHaveLength(0);
  });

  it('browser.status reports the user backend with its reason', async () => {
    const out = (await service(new RoutingDecider(0), unpaired()).invoke('browser.status', {}))
      .output as { backends: { name: string; reason?: string }[] };
    expect(out.backends.find((backend) => backend.name === 'user')).toMatchObject({
      ready: false,
      reason: 'not_connected',
    });
  });

  it('browser.session.* with on:"user": open, snapshot (marked screenshot for the caller), act, close', async () => {
    managedOpened();
    const bridge = new FakeBridge();
    const svc = service(new RoutingDecider(0), bridge);
    const opened = (await svc.invoke('browser.session.open', { on: 'user', url: URL }))
      .output as Record<string, unknown>;
    expect(opened).toMatchObject({ ok: true, profile: 'own', url: URL });
    const sessionId = opened['sessionId'];
    const snapped = (await svc.invoke('browser.session.snapshot', { sessionId, screenshot: true }))
      .output as Record<string, unknown>;
    expect(snapped['elements']).toEqual([
      expect.objectContaining({ ref: 'e1', kind: 'click' }),
      expect.objectContaining({ ref: 'e2', kind: 'fill' }),
    ]);
    expect(String(snapped['screenshotPath'])).toMatch(/marked-\d+\.jpg$/);
    const acted = (
      await svc.invoke('browser.session.act', {
        sessionId,
        action: { kind: 'type', ref: 'e2', text: 'x' },
      })
    ).output;
    expect(acted).toMatchObject({ ok: true });
    expect((await svc.invoke('browser.session.close', { sessionId })).output).toMatchObject({
      closed: true,
    });
    expect(bridge.named('browserbridge.tabs.close')).toEqual([{ tabId: 7 }]);
  });

  it('browser.session.open on:"user" when not paired says why and opens nothing', async () => {
    const bridge = unpaired();
    const out = (
      await service(new RoutingDecider(0), bridge).invoke('browser.session.open', {
        on: 'user',
        url: URL,
      })
    ).output;
    expect(out).toMatchObject({
      ok: false,
      error: expect.stringContaining('BROWSER_USER_NOT_PAIRED: not_connected'),
    });
    expect(bridge.named('browserbridge.tabs.open')).toHaveLength(0);
  });

  it('browser.ask on:"user" answers from text only by default, and still saves the picture for the caller', async () => {
    const decider = new RoutingDecider(0);
    const bridge = new FakeBridge();
    const out = (
      await service(decider, bridge).invoke('browser.ask', {
        on: 'user',
        url: URL,
        questions: { signed_in: { type: 'predicate', instructions: 'signed in?' } },
      })
    ).output as Record<string, unknown>;
    expect(out).toMatchObject({ ok: true, url: URL });
    expect(decider.steps.judged[0]?.images).toBeUndefined();
    expect(String(out['screenshotPath'])).toMatch(/asked-\d+\.jpg$/);
    // Opened at the url once, no second load; the tab is closed afterwards.
    expect(bridge.named('browserbridge.tabs.navigate')).toHaveLength(0);
    expect(bridge.named('browserbridge.tabs.close')).toEqual([{ tabId: 7 }]);
  });
});

describe("the engine's guards hold on the user backend", () => {
  it('a secret field is never offered and an off-site link stops with needs_owner', async () => {
    const bridge = new FakeBridge({
      'browserbridge.snapshot': () =>
        snap([
          item('e1', { tag: 'input', type: 'password', role: 'textbox' }),
          item('e2', { tag: 'a', role: 'link', href: 'https://evil.example.org/oauth/authorize' }),
        ]),
    });
    const { tab } = await openTab(bridge);
    const decider = new FakeDecider([{ choice: 'click e2' }]);
    const result = await runTask(
      { target: tab, decider, saveShot, sleep: () => Promise.resolve() },
      { goal: 'connect my account', vision: false, values: { pw: 'hunter2' } },
    );
    expect(result.status).toBe('needs_owner');
    const question = decider.judged[0]?.questions['next_action'] as {
      criteria: Record<string, string>;
    };
    expect(Object.keys(question.criteria)).toContain('click e2');
    expect(Object.keys(question.criteria).some((action) => action.includes('e1'))).toBe(false);
    expect(bridge.named('browserbridge.click')).toHaveLength(0);
    expect(bridge.named('browserbridge.type')).toHaveLength(0);
  });
});
