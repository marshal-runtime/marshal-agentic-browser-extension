/**
 * The user backend against the real transport: a throwaway headless Chrome for Testing profile with the Marley Chrome
 * extension unpacked, the real browser bridge (its `activate`, on a free port, never the person's 17373) and a local
 * fixture page. Nothing here touches the person's own Chrome. Skipped, with a notice, unless both are given:
 *   MB_BRIDGE_REPO=<a marley-browser-extension checkout>  MB_CHROME_FOR_TESTING=<Chrome for Testing binary>
 * MB_PROOF_DIR, when set, receives the marked screenshot and a screencast frame.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BrowserService } from '../src/capabilities.js';
import type {
  CapabilityProvider,
  DecideAnswer,
  DecideMultiInput,
  RuntimeExecResponse,
} from '../src/contracts.js';
import type { Decider } from '../src/engine/decider.js';
import { createHostBridge, type BridgeClient } from '../src/user/bridge.js';
import { UserTab } from '../src/user/tab.js';

const BRIDGE_REPO = process.env['MB_BRIDGE_REPO'];
const CHROME = process.env['MB_CHROME_FOR_TESTING'];
const PROOF_DIR = process.env['MB_PROOF_DIR'];
const ready = Boolean(
  BRIDGE_REPO &&
    CHROME &&
    existsSync(path.join(BRIDGE_REPO, 'chrome-extension/background.js')) &&
    existsSync(CHROME),
);
if (!ready)
  console.warn('[user.real] SKIPPED: set MB_BRIDGE_REPO and MB_CHROME_FOR_TESTING to run it');

const PAGE = `<!doctype html><html><head><title>Account fixture</title></head><body>
<h1>Your account</h1>
<label for="email">Email</label><input id="email">
<label for="pw">Password</label><input id="pw" type="password">
<label for="otp">Verification code</label><input id="otp" autocomplete="one-time-code">
<button id="save" onclick="document.getElementById('out').textContent='Saved: '+document.getElementById('email').value">Save</button>
<div id="out"></div>
<a href="/two">Orders</a>
<div style="height:2000px"></div><p>Bottom</p>
</body></html>`;

/** The host's execute, for a test: browserbridge.* to the real bridge provider, everything else not_found. */
function hostOver(
  provider: CapabilityProvider,
  hide: ReadonlySet<string> = new Set(),
): BridgeClient {
  return createHostBridge(async (request): Promise<RuntimeExecResponse> => {
    const context = { principal: { id: 'user-real', kind: 'agent' } } as never;
    const known = await provider.get?.(request.target, context);
    if (!known || hide.has(request.target))
      return { protocolVersion: '1.0.0', status: 'not_found' };
    try {
      const result = await provider.invoke(request.target, request.input, {
        principal: { id: 'user-real', kind: 'agent' },
      } as never);
      return { protocolVersion: '1.0.0', status: 'success', result };
    } catch (error) {
      const failure = error as { code?: string; message?: string };
      return {
        protocolVersion: '1.0.0',
        status: 'failed',
        error: { code: failure.code ?? 'error', message: failure.message ?? String(error) },
      };
    }
  });
}

/** A scripted decide service that records what it was sent. */
class Script implements Decider {
  readonly judged: DecideMultiInput[] = [];
  constructor(private readonly choices: ((input: DecideMultiInput) => string)[]) {}
  judge(input: DecideMultiInput): ReturnType<Decider['judge']> {
    this.judged.push(input);
    if ('needs_login' in input.questions)
      return Promise.resolve({
        success: true as const,
        answers: { needs_login: { type: 'predicate' as const, probability: 0.9 } },
      });
    const pick = this.choices[Math.min(this.judged.length - 1, this.choices.length - 1)];
    const choice = pick ? pick(input) : 'done';
    const answers: Record<string, DecideAnswer> = {
      next_action: { type: 'choice', choice, confidence: 0.95, probabilities: { [choice]: 0.95 } },
      goal_met: { type: 'predicate', probability: choice === 'done' ? 0.95 : 0.05 },
      needs_owner: { type: 'predicate', probability: 0.02 },
      page_ready: { type: 'predicate', probability: 0.97 },
    };
    return Promise.resolve({ success: true as const, answers });
  }
  extract(): ReturnType<Decider['extract']> {
    return Promise.resolve({ success: true as const, choice: {} });
  }
  probe(): ReturnType<Decider['probe']> {
    return Promise.resolve({ available: true, detail: 'script' });
  }
}

/** The offered action whose description names `label` (as the model would pick it). */
const offer =
  (prefix: string, label: string) =>
  (input: DecideMultiInput): string => {
    const question = input.questions['next_action'] as { criteria: Record<string, string> };
    const found = Object.entries(question.criteria).find(
      ([action, description]) => action.startsWith(prefix) && description.includes(label),
    );
    return found?.[0] ?? 'blocked';
  };

describe.skipIf(!ready)('user backend over the real bridge and a throwaway Chrome', () => {
  let server: http.Server;
  let base = '';
  let chrome: ChildProcess;
  let activation: { capabilityProviders: CapabilityProvider[]; dispose(): Promise<void> };
  let provider: CapabilityProvider;
  let bridge: BridgeClient;
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'mb-user-real-'));

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(req.url === '/two' ? '<title>Orders</title><p>No orders yet</p>' : PAGE);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${String((server.address() as { port: number }).port)}`;
    const port = 17600 + Math.floor(Math.random() * 300);
    const extension = path.join(scratch, 'ext');
    cpSync(path.join(BRIDGE_REPO as string, 'chrome-extension'), extension, { recursive: true });
    const background = path.join(extension, 'background.js');
    writeFileSync(
      background,
      readFileSync(background, 'utf8').replace(
        'const DEFAULTS = { enabled: true, bridgeUrl: "" };',
        `const DEFAULTS = { enabled: true, bridgeUrl: "ws://127.0.0.1:${String(port)}/bridge" };`,
      ),
    );
    const require = createRequire(import.meta.url);
    const { activate } = require(
      path.join(BRIDGE_REPO as string, 'marshal-extension/src/extension.js'),
    ) as { activate: (context: unknown) => Promise<typeof activation> };
    activation = await activate({
      configuration: { port, screenshotDirectory: path.join(scratch, 'shots') },
    });
    provider = activation.capabilityProviders[0] as CapabilityProvider;
    bridge = hostOver(provider);
    chrome = spawn(
      CHROME as string,
      [
        '--headless=new',
        `--user-data-dir=${path.join(scratch, 'profile')}`,
        `--load-extension=${extension}`,
        `--disable-extensions-except=${extension}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--use-mock-keychain',
        '--password-store=basic',
        'about:blank',
      ],
      { stdio: 'ignore' },
    );
    const status = await bridge.call<{ connected?: boolean }>('browserbridge.status', {
      waitMs: 20_000,
    });
    if (!status.connected) throw new Error('the throwaway Chrome never connected to the bridge');
  }, 40_000);

  afterAll(async () => {
    chrome.kill();
    await activation.dispose();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(scratch, { recursive: true, force: true });
  });

  it('browser.status: paired, with live frames', async () => {
    const service = new BrowserService(
      () => new Script([]),
      {},
      () => bridge,
    );
    const out = (await service.invoke('browser.status', {})).output as {
      backends: { name: string }[];
    };
    await service.dispose();
    expect(out.backends.find((backend) => backend.name === 'user')).toMatchObject({
      ready: true,
      reason: 'paired',
      screencast: 'events',
    });
  });

  it('session: background tab in the Marley group, eN snapshot, marked screenshot, typing guarded, close', async () => {
    const artifactDir = path.join(scratch, 'artifacts');
    const service = new BrowserService(
      () => new Script([]),
      { artifactDir },
      () => bridge,
    );
    const opened = (await service.invoke('browser.session.open', { on: 'user', url: base }))
      .output as Record<string, unknown>;
    expect(opened).toMatchObject({ ok: true, profile: 'own', title: 'Account fixture' });
    const sessionId = opened['sessionId'];
    const listed = await bridge.call<{ tabs: { tabId: number; url: string; active: boolean }[] }>(
      'browserbridge.tabs.list',
      {},
    );
    expect(listed.tabs.find((tab) => tab.url.startsWith(base))?.active).toBe(false);
    const snap = (await service.invoke('browser.session.snapshot', { sessionId, screenshot: true }))
      .output as {
      elements: { ref: string; kind: string; description: string }[];
      screenshotPath: string;
    };
    const refOf = (label: string): string =>
      snap.elements.find((element) => element.description.includes(label))?.ref ?? 'missing';
    expect(snap.elements.map((element) => element.ref).slice(0, 3)).toEqual(['e1', 'e2', 'e3']);
    expect(readFileSync(snap.screenshotPath).subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
    if (PROOF_DIR) cpSync(snap.screenshotPath, path.join(PROOF_DIR, 'real-bridge-marked.jpg'));
    const typed = (
      await service.invoke('browser.session.act', {
        sessionId,
        action: { kind: 'type', ref: refOf('textbox "Email"'), text: 'owner@example.com' },
      })
    ).output;
    expect(typed, JSON.stringify({ typed, elements: snap.elements })).toMatchObject({ ok: true });
    for (const field of ['textbox "Password"', 'textbox "Verification code"']) {
      const refused = (
        await service.invoke('browser.session.act', {
          sessionId,
          action: { kind: 'type', ref: refOf(field), text: 'hunter2' },
        })
      ).output;
      expect(refused).toMatchObject({ ok: false, error: expect.stringContaining('secret-field') });
    }
    const clicked = (
      await service.invoke('browser.session.act', {
        sessionId,
        action: { kind: 'click', ref: refOf('button "Save"') },
      })
    ).output;
    expect(clicked).toMatchObject({ ok: true });
    const after = (await service.invoke('browser.session.snapshot', { sessionId })).output as {
      text: string;
    };
    expect(after.text).toContain('Saved: owner@example.com');
    expect((await service.invoke('browser.session.close', { sessionId })).output).toMatchObject({
      closed: true,
    });
    const left = await bridge.call<{ tabs: { url: string }[] }>('browserbridge.tabs.list', {});
    expect(left.tabs.some((tab) => tab.url.startsWith(base))).toBe(false);
    await service.dispose();
  }, 60_000);

  it('screencast: forwarded debugger frames, and polled screenshots from a bridge without them', async () => {
    for (const [mode, client] of [
      ['events', bridge],
      [
        'polling',
        hostOver(
          provider,
          new Set([
            'browserbridge.screencast.start',
            'browserbridge.screencast.next',
            'browserbridge.screencast.stop',
          ]),
        ),
      ],
    ] as const) {
      const tab = await UserTab.open(client, base);
      const frames: { data: string; width: number }[] = [];
      const handle = await tab.screencast({ maxWidth: 480 }, (data, meta) => {
        frames.push({ data, width: meta.width });
      });
      // Something to paint: the cast sends frames as the page changes.
      for (let i = 0; i < 6 && frames.length < 2; i += 1) {
        await tab.act({ kind: 'scroll', direction: i % 2 ? 'up' : 'down' });
        await new Promise((resolve) => setTimeout(resolve, 700));
      }
      await handle.stop();
      await tab.close();
      expect(frames.length, mode).toBeGreaterThanOrEqual(1);
      const jpeg = Buffer.from(frames[0]?.data ?? '', 'base64');
      expect(jpeg.subarray(0, 2), mode).toEqual(Buffer.from([0xff, 0xd8]));
      expect(frames[0]?.width ?? 0, mode).toBeLessThanOrEqual(480);
      if (PROOF_DIR)
        writeFileSync(path.join(PROOF_DIR, `real-bridge-screencast-${mode}.jpg`), jpeg);
    }
  }, 60_000);

  it('browser.task on:"user": the step engine fills and saves, text-only decisions, tab closed after', async () => {
    const decider = new Script([offer('type', '"Email"'), offer('click', '"Save"'), () => 'done']);
    const service = new BrowserService(
      () => decider,
      {},
      () => bridge,
    );
    const out = (
      await service.invoke('browser.task', {
        goal: 'save my email address on my account page',
        on: 'user',
        startUrl: base,
        values: { email: 'owner@example.com' },
        want: { text: true },
      })
    ).output as Record<string, unknown>;
    await service.dispose();
    expect(out).toMatchObject({ ok: true, status: 'done', backend: 'user' });
    expect(String(out['text'])).toContain('Saved: owner@example.com');
    expect(decider.judged.every((input) => input.images === undefined)).toBe(true);
    const left = await bridge.call<{ tabs: { url: string }[] }>('browserbridge.tabs.list', {});
    expect(left.tabs.some((tab) => tab.url.startsWith(base))).toBe(false);
  }, 60_000);
});
