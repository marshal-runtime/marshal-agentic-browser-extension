/**
 * The person's-Chrome backend with only this package: the Chrome extension carried in dist/chrome-extension, loaded
 * unchanged into a throwaway headless Chrome for Testing profile, and the bridge carried in src/user/local-bridge.ts on a
 * free port (never the person's 17373). The one setup step is done as the person does it: the address entered in the
 * extension's popup. Nothing here touches the person's own Chrome or profile. Skipped, with a notice, without Chrome
 * for Testing (MB_CHROME_FOR_TESTING, or Playwright's cached copy). MB_PROOF_DIR, when set, receives the screenshots.
 */
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { createServer, type AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BrowserService } from '../src/capabilities.js';
import type {
  CapabilityProvider,
  DecideAnswer,
  DecideMultiInput,
  RuntimeExtensionActivationContext,
} from '../src/contracts.js';
import type { Decider } from '../src/engine/decider.js';
import { activate } from '../src/extension.js';
import type { BridgeClient } from '../src/user/bridge.js';
import { createLocalBridgeClient, LocalBridge } from '../src/user/local-bridge.js';
import { carriedExtension } from '../src/user/status.js';
import { UserTab } from '../src/user/tab.js';
import { chromeForTesting, launchThrowawayChrome } from '../scripts/carried-chrome.mjs';

type ThrowawayChrome = Awaited<ReturnType<typeof launchThrowawayChrome>>;

const CHROME = chromeForTesting();
const CARRIED = fileURLToPath(new URL('../dist/chrome-extension', import.meta.url));
const PROOF_DIR = process.env['MB_PROOF_DIR'];
const ready = Boolean(CHROME && existsSync(path.join(CARRIED, 'manifest.json')));
if (!ready)
  console.warn(
    '[user.real] SKIPPED: needs Chrome for Testing (MB_CHROME_FOR_TESTING) and a build (dist/chrome-extension)',
  );

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

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
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

describe.skipIf(!ready)(
  'user backend: carried Chrome extension + carried bridge, throwaway Chrome for Testing',
  () => {
    let server: http.Server;
    let base = '';
    let chrome: ThrowawayChrome;
    let localBridge: LocalBridge;
    let bridge: BridgeClient;
    const scratch = mkdtempSync(path.join(os.tmpdir(), 'mb-user-real-'));

    beforeAll(async () => {
      server = http.createServer((req, res) => {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(req.url === '/two' ? '<title>Orders</title><p>No orders yet</p>' : PAGE);
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      base = `http://127.0.0.1:${String((server.address() as { port: number }).port)}`;
      // Pinned to the carried extension's id, as activate() does.
      localBridge = new LocalBridge(await freePort(), {
        extensionId: String(carriedExtension([CARRIED]).extensionId),
      });
      await localBridge.start();
      bridge = createLocalBridgeClient(localBridge, path.join(scratch, 'shots'));
      chrome = await launchThrowawayChrome(CHROME as string, CARRIED);
      await chrome.setBridgeAddress(String(localBridge.status().url));
      if (!(await localBridge.waitForBrowser(20_000)))
        throw new Error('the throwaway Chrome never connected to the bridge');
    }, 60_000);

    afterAll(async () => {
      await chrome.close();
      await localBridge.stop();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(scratch, { recursive: true, force: true });
    });

    it('Chrome assigns the carried extension exactly the id the bridge is pinned to', async () => {
      // The carried manifest's service worker is background.js; Chrome also runs its own component extensions.
      const pinned = String(carriedExtension([CARRIED]).extensionId);
      const workers = (await chrome.loadedExtensionIds()) as { id: string; url: string }[];
      expect(workers.filter((worker) => worker.url.endsWith('/background.js'))).toEqual([
        { id: pinned, url: `chrome-extension://${pinned}/background.js` },
      ]);
    });

    it('browser.status: paired with the carried Marley 0.5.1 (main has no frame forwarding, so polled screenshots)', async () => {
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
        extensionVersion: '0.5.1',
        screencast: 'polling',
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
      const snap = (
        await service.invoke('browser.session.snapshot', { sessionId, screenshot: true })
      ).output as {
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
      const refusedType = async (field: string): Promise<unknown> =>
        (
          await service.invoke('browser.session.act', {
            sessionId,
            action: { kind: 'type', ref: refOf(field), text: 'hunter2' },
          })
        ).output;
      expect(await refusedType('textbox "Password"')).toMatchObject({
        ok: false,
        error: expect.stringContaining('secret-field'),
      });
      // An EMPTY one-time-code field: the pinned main build flags a secret field only by masking a value it holds (page.js),
      // so the code guard cannot see it; PR #4 adds the snapshot's secret flag. Known gap of this pin: the moment the carried
      // build flags it, the refusal is required; until then the pin must still be 48cf63f, so a re-pin forces this check.
      const otp = (snap.elements as { description: string; secret?: boolean }[]).find((element) =>
        element.description.includes('textbox "Verification code"'),
      );
      if (otp?.secret === true)
        expect(await refusedType('textbox "Verification code"')).toMatchObject({
          ok: false,
          error: expect.stringContaining('secret-field'),
        });
      else
        expect(
          (
            JSON.parse(
              readFileSync(path.join(CARRIED, '..', 'chrome-extension.lock.json'), 'utf8'),
            ) as { commit: string }
          ).commit,
        ).toBe('21c1e1575fe85bfec8bb22bb501214de692e733a');
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

    it('screencast: polled screenshots (the carried main build forwards no frames)', async () => {
      const tab = await UserTab.open(bridge, base);
      const frames: { data: string; width: number }[] = [];
      const handle = await tab.screencast({ maxWidth: 480 }, (data, meta) => {
        frames.push({ data, width: meta.width });
      });
      for (let i = 0; i < 6 && frames.length < 2; i += 1) {
        await tab.act({ kind: 'scroll', direction: i % 2 ? 'up' : 'down' });
        await new Promise((resolve) => setTimeout(resolve, 700));
      }
      await handle.stop();
      await tab.close();
      expect(frames.length).toBeGreaterThanOrEqual(1);
      const image = Buffer.from(frames[0]?.data ?? '', 'base64');
      expect(image.length).toBeGreaterThan(100);
      if (PROOF_DIR) writeFileSync(path.join(PROOF_DIR, 'carried-screencast-polling.jpg'), image);
    }, 60_000);

    it('browser.task on:"user": types the supplied value, then stops for the owner before a form whose target the carried build does not report', async () => {
      const decider = new Script([
        offer('type', '"Email"'),
        offer('click', '"Save"'),
        () => 'done',
      ]);
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
      // The leak guard: the main build sends no formAction, so a form holding a supplied value is never sent blind.
      expect(out, JSON.stringify(out).slice(0, 3000)).toMatchObject({
        ok: true,
        status: 'needs_owner',
        reason: 'form_target_unknown',
        backend: 'user',
        element: { label: 'Save' },
      });
      const trace = out['trace'] as { action: string; outcome: string }[];
      expect(trace[0]).toMatchObject({ action: expect.stringContaining('type'), outcome: 'ok' });
      expect(decider.judged.every((input) => input.images === undefined)).toBe(true);
      const left = await bridge.call<{ tabs: { url: string }[] }>('browserbridge.tabs.list', {});
      expect(left.tabs.some((tab) => tab.url.startsWith(base))).toBe(false);
    }, 60_000);

    it('activate(): the extension entry point starts the carried bridge on bridgePort; the Chrome follows the address the popup gets', async () => {
      const port = await freePort();
      const context = {
        configuration: {
          bridgePort: port,
          artifactDir: path.join(scratch, 'activated'),
          chromeExtensionDir: path.join(scratch, 'stable', 'chrome-extension'),
        },
        execute: () => Promise.reject(new Error('no model in this test')),
      } as unknown as RuntimeExtensionActivationContext<Record<string, unknown>>;
      const activation = await activate(context);
      try {
        const provider = activation.capabilityProviders?.[0] as CapabilityProvider;
        const invoke = async (
          name: string,
          input: Record<string, unknown>,
        ): Promise<Record<string, unknown>> =>
          (await provider.invoke(name, input, {
            principal: { id: 'user-real', kind: 'agent' },
          } as never)) as unknown as Record<string, unknown>;
        const userOf = (out: Record<string, unknown>): Record<string, unknown> =>
          ((out['output'] ?? out) as { backends: Record<string, unknown>[] }).backends.find(
            (backend) => backend['name'] === 'user',
          ) as Record<string, unknown>;
        const before = userOf(await invoke('browser.status', {}));
        expect(before).toMatchObject({ ready: false, reason: 'not_connected' });
        const setup = before['setup'] as {
          chromeExtension: { folder: string; bridgeAddress: string };
          steps: string[];
        };
        expect(setup.chromeExtension.folder).toBe(path.join(scratch, 'stable', 'chrome-extension'));
        expect(readFileSync(path.join(setup.chromeExtension.folder, 'background.js'))).toEqual(
          readFileSync(path.join(CARRIED, 'background.js')),
        );
        expect(setup.chromeExtension.bridgeAddress).toBe(`ws://127.0.0.1:${String(port)}/bridge`);
        await chrome.setBridgeAddress(setup.chromeExtension.bridgeAddress);
        const deadline = Date.now() + 20_000;
        let after = userOf(await invoke('browser.status', {}));
        while (after['ready'] !== true && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 200));
          after = userOf(await invoke('browser.status', {}));
        }
        expect(after).toMatchObject({ ready: true, reason: 'paired' });
        const opened = (await invoke('browser.session.open', { on: 'user', url: base })) as Record<
          string,
          unknown
        >;
        const out = (opened['output'] ?? opened) as Record<string, unknown>;
        expect(out).toMatchObject({ ok: true, profile: 'own', title: 'Account fixture' });
        const snap = (await invoke('browser.session.snapshot', {
          sessionId: out['sessionId'],
        })) as Record<string, unknown>;
        expect(JSON.stringify(snap)).toContain('Your account');
        const closed = (await invoke('browser.session.close', {
          sessionId: out['sessionId'],
        })) as Record<string, unknown>;
        expect((closed['output'] ?? closed) as Record<string, unknown>).toMatchObject({
          closed: true,
        });
      } finally {
        await activation.dispose?.();
        await chrome.setBridgeAddress(String(localBridge.status().url));
      }
    }, 60_000);
  },
);
