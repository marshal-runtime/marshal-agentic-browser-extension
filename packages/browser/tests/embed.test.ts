/**
 * Embedding in a host that is not Marshal (activateEmbedded, 0.4.0): no loopback listener and no carried folder unless
 * configured, the host's decide function, its own transport to the person's Chrome with typed refusals (approval,
 * lost answer, gone), its own setup words, per-slot profiles, the Chrome sandbox switch and `on: "app"` off macOS.
 * Unit level: no Chrome starts (the managed backend is not used); tests/embed.real.test.ts covers the launcher.
 */
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  CapabilityProvider,
  DecideMultiInput,
  DecideSchemaInput,
  RuntimeExecuteFn,
  RuntimeExtensionActivation,
} from '../src/contracts.js';
import { activate, activateEmbedded } from '../src/extension.js';
import { agentProfileDir, chromeArgs, ChromeLauncher, isHeaded } from '../src/chrome/launcher.js';
import { BridgeError, type BridgeClient, type BridgeElement } from '../src/user/bridge.js';
import { encodePng } from '../src/user/image.js';
import { FakeDecider, type Turn } from './helpers.js';

const URL = 'https://shop.example.com/account';
const PAIRED = {
  listening: true,
  connected: true,
  browser: { origin: 'relay', hello: { extensionVersion: '0.5.0' } },
};
const PNG = encodePng({ width: 200, height: 100, data: new Uint8Array(200 * 100 * 4).fill(255) });

function item(ref: string): BridgeElement {
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
  };
}

type Handler = (input: Record<string, unknown>) => unknown;

/** A relay-like transport: answers from handlers; the PNG comes back inline (no file), as an embedding relay may. */
class RelayBridge implements BridgeClient {
  readonly calls: { name: string; input: Record<string, unknown> }[] = [];
  handlers: Record<string, Handler>;
  constructor(handlers: Record<string, Handler> = {}) {
    this.handlers = {
      'browserbridge.status': () => PAIRED,
      'browserbridge.tabs.open': () => ({ tabId: 7, url: URL }),
      'browserbridge.tabs.close': () => ({ closed: true }),
      'browserbridge.tabs.list': () => ({ tabs: [{ tabId: 7, url: URL, loading: false }] }),
      'browserbridge.snapshot': () => ({
        tabId: 7,
        url: URL,
        title: 'Account',
        viewport: { width: 100, height: 50 },
        scroll: { x: 0, y: 0, height: 50 },
        text: 'Your account',
        elements: [item('e4')],
      }),
      'browserbridge.screenshot': () => ({ width: 100, data: PNG.toString('base64') }),
      'browserbridge.click': () => ({ clicked: true, url: URL, loading: false }),
      ...handlers,
    };
  }
  call<T>(name: string, input: Record<string, unknown>): Promise<T> {
    this.calls.push({ name, input });
    const handler = this.handlers[name];
    if (!handler) return Promise.reject(new BridgeError('unsupported', name));
    try {
      return Promise.resolve(handler(input) as T);
    } catch (error) {
      return Promise.reject(error as Error);
    }
  }
  named(name: string): Record<string, unknown>[] {
    return this.calls.filter((call) => call.name === name).map((call) => call.input);
  }
  after(name: string): string[] {
    const at = this.calls.findIndex((call) => call.name === name);
    return at < 0 ? [] : this.calls.slice(at + 1).map((call) => call.name);
  }
}

/** The host's decide function, answering from a FakeDecider (so the decider's own answer checks run on it). */
function decideFrom(fake: FakeDecider): {
  decide: (input: DecideMultiInput | DecideSchemaInput) => Promise<unknown>;
  inputs: (DecideMultiInput | DecideSchemaInput)[];
} {
  const inputs: (DecideMultiInput | DecideSchemaInput)[] = [];
  return {
    inputs,
    decide: (input) => {
      inputs.push(input);
      return 'questions' in input ? fake.judge(input) : fake.extract(input);
    },
  };
}

const activations: RuntimeExtensionActivation[] = [];
afterEach(async () => {
  await Promise.all(activations.splice(0).map((activation) => activation.dispose?.()));
});

async function embedded(
  options: Parameters<typeof activateEmbedded>[0],
): Promise<CapabilityProvider> {
  const activation = await activateEmbedded({
    ...options,
    configuration: {
      artifactDir: mkdtempSync(path.join(os.tmpdir(), 'mb-embed-art-')),
      ...options.configuration,
    },
  });
  activations.push(activation);
  return activation.capabilityProviders?.[0] as CapabilityProvider;
}

const CONTEXT = { principal: { id: 'test', kind: 'agent' } };
const run = async (
  provider: CapabilityProvider,
  name: string,
  input: Record<string, unknown>,
): Promise<Record<string, unknown>> =>
  (await provider.invoke(name, input, CONTEXT)).output as Record<string, unknown>;

/** A free loopback port (bound and released), so no test touches 17373 that a running Marshal may hold. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as net.AddressInfo).port;
      server.close(() => resolve(port));
    });
  });
}

function accepts(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1');
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });
}

const noDecide: RuntimeExecuteFn = () =>
  Promise.resolve({ protocolVersion: '1.0.0', status: 'not_found' });

describe('activateEmbedded: secure defaults for a host that is not Marshal', () => {
  it('opens no loopback listener and copies no Chrome extension folder unless configured', async () => {
    const port = await freePort();
    const folder = path.join(
      mkdtempSync(path.join(os.tmpdir(), 'mb-embed-ext-')),
      'chrome-extension',
    );
    const provider = await embedded({
      decide: () => Promise.resolve({ success: true, answers: {} }),
      configuration: { bridgePort: port, chromeExtensionDir: folder },
    });
    expect(await accepts(port)).toBe(false);
    expect(existsSync(folder)).toBe(false);
    // Without a transport the person's Chrome is simply not there (never a socket to load a folder for).
    const status = await run(provider, 'browser.status', {});
    const user = (status['backends'] as { name: string; reason?: string }[]).find(
      (b) => b.name === 'user',
    );
    expect(user?.reason).toBe('no_socket');
  });

  it('control: configured on, the same entry listens on the port and carries the folder', async () => {
    const port = await freePort();
    const folder = path.join(
      mkdtempSync(path.join(os.tmpdir(), 'mb-embed-ext-')),
      'chrome-extension',
    );
    await embedded({
      decide: () => Promise.resolve({ success: true, answers: {} }),
      configuration: {
        bridgePort: port,
        chromeExtensionDir: folder,
        localBridge: true,
        carryChromeExtension: true,
      },
    });
    expect(await accepts(port)).toBe(true);
    expect(existsSync(path.join(folder, 'manifest.json'))).toBe(true);
  });

  it("Marshal's activate keeps its defaults (listens, carries) and honours localBridge:false / carryChromeExtension:false", async () => {
    const on = await freePort();
    const onFolder = path.join(
      mkdtempSync(path.join(os.tmpdir(), 'mb-embed-ext-')),
      'chrome-extension',
    );
    const context = (configuration: Record<string, unknown>): Parameters<typeof activate>[0] =>
      ({
        manifest: { identity: '@marshal/browser', version: '0.4.0' },
        configuration,
        services: { get: () => undefined as never, tryGet: () => undefined },
        execute: noDecide,
      }) as unknown as Parameters<typeof activate>[0];
    activations.push(await activate(context({ bridgePort: on, chromeExtensionDir: onFolder })));
    expect(await accepts(on)).toBe(true);
    expect(existsSync(path.join(onFolder, 'manifest.json'))).toBe(true);
    const off = await freePort();
    const offFolder = path.join(
      mkdtempSync(path.join(os.tmpdir(), 'mb-embed-ext-')),
      'chrome-extension',
    );
    activations.push(
      await activate(
        context({
          bridgePort: off,
          chromeExtensionDir: offFolder,
          localBridge: false,
          carryChromeExtension: false,
        }),
      ),
    );
    expect(await accepts(off)).toBe(false);
    expect(existsSync(offFolder)).toBe(false);
  });

  it('refuses to start without a decide function or an execute, and a bridge that is not a factory', async () => {
    await expect(activateEmbedded({})).rejects.toThrow(/needs decide or execute/);
    await expect(
      activateEmbedded({ decide: () => Promise.resolve({}), bridge: {} as never }),
    ).rejects.toThrow(/bridge must be a function/);
  });
});

describe("the host's decide function", () => {
  it("answers every step of a task on the person's Chrome; status reports decide as offered", async () => {
    const { decide, inputs } = decideFrom(
      new FakeDecider([{ choice: 'click e1' }, { choice: 'done', goalMet: 0.95 }] satisfies Turn[]),
    );
    const bridge = new RelayBridge();
    const provider = await embedded({ decide, bridge: () => bridge });
    const status = await run(provider, 'browser.status', {});
    expect(status['decide']).toMatchObject({ available: true });
    // The probe made no model call.
    expect(inputs).toHaveLength(0);
    const out = await run(provider, 'browser.task', {
      goal: 'open my orders',
      on: 'user',
      startUrl: URL,
    });
    expect(out).toMatchObject({ ok: true, status: 'done', backend: 'user' });
    expect(inputs.length).toBeGreaterThanOrEqual(2);
    expect(bridge.named('browserbridge.click')).toEqual([{ tabId: 7, ref: 'e4' }]);
  });

  it('a decide that throws ends the task with decisions_unavailable, never a page verdict', async () => {
    const provider = await embedded({
      decide: () => Promise.reject(new Error('relay to /zs/decide refused')),
      bridge: () => new RelayBridge(),
    });
    const out = await run(provider, 'browser.task', {
      goal: 'open my orders',
      on: 'user',
      startUrl: URL,
    });
    expect(out['status']).toBe('decisions_unavailable');
  });

  it('decide wins over execute for marshal.models.decide; other targets still reach execute', async () => {
    const targets: string[] = [];
    const { decide, inputs } = decideFrom(new FakeDecider([{ choice: 'done', goalMet: 0.95 }]));
    const provider = await embedded({
      decide,
      execute: (request) => {
        targets.push(request.target);
        return Promise.resolve({ protocolVersion: '1.0.0', status: 'not_found' });
      },
      bridge: () => new RelayBridge(),
    });
    await run(provider, 'browser.task', { goal: 'open my orders', on: 'user', startUrl: URL });
    expect(inputs.length).toBeGreaterThan(0);
    expect(targets).not.toContain('marshal.models.decide');
  });
});

describe("the host's transport to the person's Chrome: typed refusals end the task, never retried", () => {
  it('needs_owner (an approval the relay asks for) on a click: status needs_owner with the reason; one click, nothing after', async () => {
    const bridge = new RelayBridge({
      'browserbridge.click': () => {
        throw new BridgeError(
          'needs_owner',
          'site shop.example.com: card sent',
          'approval_required',
        );
      },
    });
    const { decide } = decideFrom(new FakeDecider([{ choice: 'click e1' }]));
    const provider = await embedded({ decide, bridge: () => bridge });
    const out = await run(provider, 'browser.task', {
      goal: 'open my orders',
      on: 'user',
      startUrl: URL,
    });
    expect(out).toMatchObject({
      status: 'needs_owner',
      reason: 'approval_required: site shop.example.com: card sent',
    });
    expect(bridge.named('browserbridge.click')).toHaveLength(1);
    // No final picture through the same refusal: only the tab's own close follows.
    expect(bridge.after('browserbridge.click')).toEqual(['browserbridge.tabs.close']);
  });

  it('unknown (an answer the relay lost) on a click: status unknown, the click is never repeated', async () => {
    const bridge = new RelayBridge({
      'browserbridge.click': () => {
        throw new BridgeError(
          'unknown',
          'the step was sent; its answer was lost',
          'outcome_unknown',
        );
      },
    });
    const { decide } = decideFrom(new FakeDecider([{ choice: 'click e1' }]));
    const provider = await embedded({ decide, bridge: () => bridge });
    const out = await run(provider, 'browser.task', {
      goal: 'open my orders',
      on: 'user',
      startUrl: URL,
    });
    expect(out).toMatchObject({ status: 'unknown' });
    expect(String(out['reason'])).toMatch(/^outcome_unknown: /);
    expect(bridge.named('browserbridge.click')).toHaveLength(1);
    expect(bridge.after('browserbridge.click')).toEqual(['browserbridge.tabs.close']);
  });

  it("not_connected mid-task (the person's Chrome left): needs_owner with the host's own setup words", async () => {
    let snapshots = 0;
    const bridge = new RelayBridge({
      'browserbridge.snapshot': () => {
        snapshots += 1;
        throw new BridgeError('not_connected', 'offline', 'offline');
      },
    });
    const { decide } = decideFrom(new FakeDecider([{ choice: 'click e1' }]));
    const provider = await embedded({
      decide,
      bridge: () => bridge,
      userSetup: () => ({
        summary: 'Pair Chrome with Marley',
        steps: ['Open the pairing page'],
        pairUrl: 'https://app.example.com/browser',
      }),
    });
    const out = await run(provider, 'browser.task', {
      goal: 'open my orders',
      on: 'user',
      startUrl: URL,
    });
    expect(out).toMatchObject({ status: 'needs_owner', reason: 'user_browser_not_connected' });
    expect(snapshots).toBe(1);
  });

  it('a refused tab opening (approval) stops the task before anything else runs', async () => {
    const bridge = new RelayBridge({
      'browserbridge.tabs.open': () => {
        throw new BridgeError(
          'needs_owner',
          'site shop.example.com: card sent',
          'approval_required',
        );
      },
    });
    const { decide, inputs } = decideFrom(new FakeDecider([{ choice: 'click e1' }]));
    const provider = await embedded({ decide, bridge: () => bridge });
    const out = await run(provider, 'browser.task', {
      goal: 'open my orders',
      on: 'user',
      startUrl: URL,
    });
    expect(out).toMatchObject({
      ok: true,
      status: 'needs_owner',
      reason: 'approval_required: site shop.example.com: card sent',
    });
    expect(inputs).toHaveLength(0);
    expect(bridge.named('browserbridge.snapshot')).toHaveLength(0);
  });

  it('a session act refused by the relay answers needs_owner (a direct act, not only tasks)', async () => {
    const bridge = new RelayBridge({
      'browserbridge.click': () => {
        throw new BridgeError(
          'needs_owner',
          'site shop.example.com: card sent',
          'approval_required',
        );
      },
    });
    const provider = await embedded({ decide: () => Promise.resolve({}), bridge: () => bridge });
    const opened = await run(provider, 'browser.session.open', { on: 'user', url: URL });
    await run(provider, 'browser.session.snapshot', { sessionId: opened['sessionId'] });
    const acted = await run(provider, 'browser.session.act', {
      sessionId: opened['sessionId'],
      action: { kind: 'click', ref: 'e1' },
    });
    expect(acted).toMatchObject({
      ok: false,
      status: 'needs_owner',
      reason: 'approval_required: site shop.example.com: card sent',
    });
    expect(bridge.named('browserbridge.click')).toHaveLength(1);
    // No read after the refused step.
    expect(bridge.after('browserbridge.click')).toEqual([]);
  });

  it("an error of the host's own BridgeError copy (another bundle) counts by name and code", async () => {
    class ForeignBridgeError extends Error {
      constructor(
        readonly code: string,
        message: string,
      ) {
        super(`${code}: ${message}`);
        this.name = 'BridgeError';
      }
    }
    const bridge = new RelayBridge({
      'browserbridge.click': () => {
        throw new ForeignBridgeError('unknown', 'lost');
      },
    });
    const { decide } = decideFrom(new FakeDecider([{ choice: 'click e1' }]));
    const provider = await embedded({ decide, bridge: () => bridge });
    const out = await run(provider, 'browser.task', {
      goal: 'open my orders',
      on: 'user',
      startUrl: URL,
    });
    expect(out['status']).toBe('unknown');
    expect(bridge.named('browserbridge.click')).toHaveLength(1);
  });

  it("userVision:true: decisions on the person's Chrome carry the picture the relay handed over inline", async () => {
    const { decide, inputs } = decideFrom(new FakeDecider([{ choice: 'done', goalMet: 0.95 }]));
    const provider = await embedded({
      decide,
      bridge: () => new RelayBridge(),
      configuration: { userVision: true },
    });
    await run(provider, 'browser.task', { goal: 'open my orders', on: 'user', startUrl: URL });
    const judged = inputs.find(
      (input): input is DecideMultiInput =>
        'questions' in input && 'next_action' in input.questions,
    );
    expect((judged?.images?.[0] as { url: string } | undefined)?.url).toMatch(
      /^data:image\/jpeg;base64,/,
    );
  });

  it('control: userVision left out, the same task sends text only', async () => {
    const { decide, inputs } = decideFrom(new FakeDecider([{ choice: 'done', goalMet: 0.95 }]));
    const provider = await embedded({ decide, bridge: () => new RelayBridge() });
    await run(provider, 'browser.task', { goal: 'open my orders', on: 'user', startUrl: URL });
    const judged = inputs.find(
      (input): input is DecideMultiInput =>
        'questions' in input && 'next_action' in input.questions,
    );
    expect(judged).toBeDefined();
    expect(judged?.images).toBeUndefined();
  });
});

describe("the host's setup words for the person's Chrome", () => {
  const unpaired = (): RelayBridge =>
    new RelayBridge({
      'browserbridge.status': () => ({ listening: true, connected: false, browser: null }),
    });

  it('replace the Load-unpacked steps in browser.status and in a refused task, with an https pair address', async () => {
    const seen: string[] = [];
    const provider = await embedded({
      decide: () => Promise.resolve({}),
      bridge: unpaired,
      userSetup: (reason) => {
        seen.push(reason);
        return {
          summary: 'Pair Chrome with Marley',
          steps: ['Open the pairing page and sign in'],
          pairUrl: 'https://app.example.com/browser',
        };
      },
    });
    const status = await run(provider, 'browser.status', {});
    const user = (status['backends'] as Record<string, unknown>[]).find(
      (b) => b['name'] === 'user',
    );
    expect(user?.['setup']).toEqual({
      reason: 'not_connected',
      summary: 'Pair Chrome with Marley',
      steps: ['Open the pairing page and sign in'],
      pairUrl: 'https://app.example.com/browser',
      source: 'host',
    });
    const task = await run(provider, 'browser.task', {
      goal: 'open my orders',
      on: 'user',
      startUrl: URL,
    });
    expect(task['status']).toBe('needs_owner');
    expect((task['setup'] as Record<string, unknown>)['source']).toBe('host');
    expect(JSON.stringify(task)).not.toMatch(/Load unpacked/);
    expect(seen).toContain('not_connected');
  });

  it('drops a pair address that is not https and caps the text', async () => {
    const provider = await embedded({
      decide: () => Promise.resolve({}),
      bridge: unpaired,
      userSetup: () => ({
        summary: 'x'.repeat(900),
        steps: Array.from({ length: 30 }, () => 'step'),
        pairUrl: 'javascript:alert(1)',
      }),
    });
    const status = await run(provider, 'browser.status', {});
    const setup = (status['backends'] as Record<string, unknown>[]).find(
      (b) => b['name'] === 'user',
    )?.['setup'] as Record<string, unknown>;
    expect(setup['pairUrl']).toBeUndefined();
    expect(String(setup['summary'])).toHaveLength(500);
    expect(setup['steps']).toHaveLength(10);
  });

  it('control: without userSetup the carried steps stay', async () => {
    const provider = await embedded({ decide: () => Promise.resolve({}), bridge: unpaired });
    const status = await run(provider, 'browser.status', {});
    const setup = (status['backends'] as Record<string, unknown>[]).find(
      (b) => b['name'] === 'user',
    )?.['setup'] as Record<string, unknown>;
    expect(setup['source']).toBeUndefined();
    expect(JSON.stringify(setup['steps'])).toMatch(/Load unpacked/);
  });
});

describe('on:"app" off macOS', () => {
  it('answers unavailable (not_macos) without looking for a helper', async () => {
    const provider = await embedded({
      decide: () => Promise.resolve({}),
      configuration: { platform: 'linux' },
    });
    for (const name of ['browser.session.open', 'browser.task']) {
      const out = await run(provider, name, {
        on: 'app',
        app: 'Notes',
        goal: 'read the first note',
      });
      expect(out, name).toMatchObject({
        ok: false,
        status: 'unavailable',
        reason: 'not_macos',
        backend: 'app',
      });
    }
  });
});

describe('launcher options for an embedding host', () => {
  it('a worker slot gets its own lasting profile; a slot that is not a plain name is refused', () => {
    expect(agentProfileDir({ profileRoot: '/home/c/chrome-profiles' })).toBe(
      '/home/c/chrome-profiles/agent',
    );
    expect(
      agentProfileDir({ profileRoot: '/home/c/chrome-profiles', profileSlot: 'wabc123def0' }),
    ).toBe('/home/c/chrome-profiles/agent-wabc123def0');
    for (const slot of ['../x', 'a/b', '', 'x'.repeat(65), 'a b'])
      expect(() => agentProfileDir({ profileRoot: '/r', profileSlot: slot }), slot).toThrow(
        /profileSlot/,
      );
  });

  it('chromeSandbox:false adds --no-sandbox for a non-root user; the default keeps the sandbox', () => {
    expect(chromeArgs('lasting', '/p', false, 'linux', 1000)).not.toContain('--no-sandbox');
    expect(chromeArgs('lasting', '/p', false, 'linux', 1000, false)).toContain('--no-sandbox');
    expect(chromeArgs('ephemeral', '/p', false, 'darwin', 501, false)).toContain('--no-sandbox');
  });

  it('headed is the configured value whatever DISPLAY says', () => {
    expect(isHeaded({ headed: false, platform: 'linux', env: { DISPLAY: ':1' } })).toBe(false);
    expect(isHeaded({ headed: true, platform: 'linux', env: {} })).toBe(true);
  });
});

describe("prepareLaunch: the host's display, never an inherited one", () => {
  /** A stand-in Chrome that writes its environment and exits (the start then fails; the environment is the evidence). */
  function fakeChrome(): { bin: string; out: string } {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'mb-fake-chrome-'));
    const out = path.join(dir, 'env.txt');
    const bin = path.join(dir, 'chrome');
    writeFileSync(bin, `#!/bin/sh\nenv > '${out}'\necho "ARGS $*" >> '${out}'\nexit 3\n`, {
      mode: 0o755,
    });
    return { bin, out };
  }

  /** Runs `work` with DISPLAY / XAUTHORITY of a dead X server in this process's environment. */
  async function withDeadDisplay(work: () => Promise<void>): Promise<void> {
    const saved = { display: process.env['DISPLAY'], auth: process.env['XAUTHORITY'] };
    process.env['DISPLAY'] = ':99-dead';
    process.env['XAUTHORITY'] = '/tmp/dead-auth';
    try {
      await work();
    } finally {
      if (saved.display === undefined) delete process.env['DISPLAY'];
      else process.env['DISPLAY'] = saved.display;
      if (saved.auth === undefined) delete process.env['XAUTHORITY'];
      else process.env['XAUTHORITY'] = saved.auth;
    }
  }

  it("drops DISPLAY and XAUTHORITY from the inherited environment and passes the host's", async () => {
    const { bin, out } = fakeChrome();
    const saved = { display: process.env['DISPLAY'], auth: process.env['XAUTHORITY'] };
    process.env['DISPLAY'] = ':99-dead';
    process.env['XAUTHORITY'] = '/tmp/dead-auth';
    try {
      const launcher = new ChromeLauncher(
        {
          chromePath: bin,
          profileRoot: mkdtempSync(path.join(os.tmpdir(), 'mb-prof-')),
          platform: 'linux',
        },
        () =>
          Promise.resolve({
            env: { DISPLAY: ':1042', XAUTHORITY: '/home/c/.zs-display/Xauthority' },
            headed: true,
          }),
      );
      await expect(launcher.processFor('agent')).rejects.toThrow(/BROWSER_START_FAILED/);
      const env = readFileSync(out, 'utf8');
      expect(env).toMatch(/^DISPLAY=:1042$/m);
      expect(env).toMatch(/^XAUTHORITY=\/home\/c\/\.zs-display\/Xauthority$/m);
      expect(env).not.toMatch(/:99-dead|dead-auth/);
    } finally {
      if (saved.display === undefined) delete process.env['DISPLAY'];
      else process.env['DISPLAY'] = saved.display;
      if (saved.auth === undefined) delete process.env['XAUTHORITY'];
      else process.env['XAUTHORITY'] = saved.auth;
    }
  });

  it('with no display from the host, a Linux Chrome runs headless (no inherited DISPLAY) even if headed was asked', async () => {
    const { bin, out } = fakeChrome();
    await withDeadDisplay(async () => {
      const launcher = new ChromeLauncher(
        {
          chromePath: bin,
          profileRoot: mkdtempSync(path.join(os.tmpdir(), 'mb-prof-')),
          platform: 'linux',
          headed: true,
        },
        () => Promise.resolve({}),
      );
      await expect(launcher.processFor('agent')).rejects.toThrow(/BROWSER_START_FAILED/);
    });
    const seen = readFileSync(out, 'utf8');
    expect(seen).not.toMatch(/^(DISPLAY|XAUTHORITY)=/m);
    expect(seen).toMatch(/^ARGS .*--headless=new/m);
  });

  it("control: the host's display makes it headed (no --headless)", async () => {
    const { bin, out } = fakeChrome();
    const launcher = new ChromeLauncher(
      {
        chromePath: bin,
        profileRoot: mkdtempSync(path.join(os.tmpdir(), 'mb-prof-')),
        platform: 'linux',
        headed: true,
      },
      () => Promise.resolve({ env: { DISPLAY: ':1042' } }),
    );
    await expect(launcher.processFor('agent')).rejects.toThrow(/BROWSER_START_FAILED/);
    expect(readFileSync(out, 'utf8')).not.toMatch(/--headless/);
  });
});
