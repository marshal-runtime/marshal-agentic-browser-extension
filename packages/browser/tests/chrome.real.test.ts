/**
 * Real Chrome against a local fixture server: the three launcher profiles, eN refs, the secret flag, trusted
 * typing and clicking, the marked screenshot leaving no trace in the page, and the step engine driving a real form
 * with a scripted (fake) decide service. Skipped, with a notice, when no Chrome is installed.
 */
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ChromeLauncher, findChrome } from '../src/chrome/launcher.js';
import { ManagedTab } from '../src/chrome/tab.js';
import { MARKS_ID } from '../src/page/scripts.js';
import { runTask } from '../src/engine/task.js';
import type { Decider } from '../src/engine/decider.js';
import type { DecideAnswer, DecideMultiInput } from '../src/contracts.js';
import { saveShot } from './helpers.js';

const chrome = findChrome();
if (!chrome.path) console.warn(`[chrome.real] SKIPPED: ${chrome.reason}`);

const FORM = `<!doctype html><html><head><title>Fixture form</title></head><body>
<h1>Contact us</h1>
<form action="/done" method="get">
  <label>Name <input name="name" autocomplete="name"></label>
  <label>Password <input name="pw" type="password"></label>
  <button type="submit">Send</button>
</form>
<a href="/other">Other page</a>
</body></html>`;

let server: http.Server;
let base = '';

beforeAll(async () => {
  server = http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://x');
    if (url.pathname === '/') {
      response.writeHead(200, {
        'content-type': 'text/html',
        'set-cookie': 'seen=1; Max-Age=3600; Path=/',
      });
      response.end(FORM);
    } else if (url.pathname === '/done') {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end(
        `<!doctype html><title>Done</title><p>Thanks, ${(url.searchParams.get('name') ?? '').replace(/[<&]/g, '')}!</p>`,
      );
    } else {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end('<!doctype html><title>Other</title><p>other</p>');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  base = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe.skipIf(!chrome.path)('managed Chrome (real)', () => {
  it('visitor: refs, secret flag, trusted typing and click, and a fresh visitor carries no cookie', async () => {
    const launcher = new ChromeLauncher();
    try {
      const tab = await ManagedTab.open(launcher, 'visitor');
      expect((await tab.act({ kind: 'navigate', url: `${base}/` })).ok).toBe(true);
      const snap = await tab.snapshot();
      const name = snap.elements.find((element) => element.label.includes('Name'));
      const password = snap.elements.find((element) => element.type === 'password');
      const send = snap.elements.find((element) => element.label === 'Send');
      expect(snap.elements.every((element, index) => element.ref === `e${index + 1}`)).toBe(true);
      expect(name?.kind).toBe('fill');
      expect(password?.secret).toBe(true);
      expect(send).toBeDefined();
      expect((await tab.cookies()).map((cookie) => cookie.name)).toContain('seen');

      expect((await tab.act({ kind: 'type', ref: name?.ref ?? 'missing', text: 'Ada' })).ok).toBe(
        true,
      );
      const typed = await tab.snapshot();
      expect(typed.elements.find((element) => element.label.includes('Name'))?.value).toBe('Ada');
      const sendAgain = typed.elements.find((element) => element.label === 'Send');
      const clicked = await tab.act({ kind: 'click', ref: sendAgain?.ref ?? 'missing' });
      expect(clicked.ok).toBe(true);
      const after = await tab.snapshot();
      expect(after.url).toContain('/done?name=Ada');
      expect(after.text).toContain('Thanks, Ada!');
      await tab.close();

      const fresh = await ManagedTab.open(launcher, 'visitor');
      expect(await fresh.cookies()).toEqual([]);
      await fresh.close();
    } finally {
      await launcher.closeAll();
    }
  }, 60_000);

  it('marked screenshot draws the marks only for the capture and removes them', async () => {
    const launcher = new ChromeLauncher();
    try {
      const tab = await ManagedTab.open(launcher, 'visitor');
      await tab.act({ kind: 'navigate', url: `${base}/` });
      const snap = await tab.snapshot();
      const shot = await tab.screenshot({ marks: snap.elements, format: 'jpeg' });
      expect(shot.mimeType).toBe('image/jpeg');
      expect(Buffer.from(shot.data, 'base64').subarray(0, 2).toString('hex')).toBe('ffd8');
      expect(
        await tab.evaluate(`return Boolean(document.getElementById(${JSON.stringify(MARKS_ID)}));`),
      ).toBe(false);
      await tab.close();
    } finally {
      await launcher.closeAll();
    }
  }, 60_000);

  it('agent: the profile is lasting, so a cookie survives a full browser restart', async () => {
    const profileRoot = await mkdtemp(path.join(os.tmpdir(), 'mb-agent-'));
    try {
      const first = new ChromeLauncher({ profileRoot, headed: false });
      const tab = await ManagedTab.open(first, 'agent');
      await tab.act({ kind: 'navigate', url: `${base}/` });
      expect((await tab.cookies()).map((cookie) => cookie.name)).toContain('seen');
      await first.closeAll();

      const second = new ChromeLauncher({ profileRoot, headed: false });
      const again = await ManagedTab.open(second, 'agent');
      await again.act({ kind: 'navigate', url: `${base}/other` });
      expect((await again.cookies()).map((cookie) => cookie.name)).toContain('seen');
      await second.closeAll();
    } finally {
      await rm(profileRoot, { recursive: true, force: true });
    }
  }, 90_000);

  it('offline: no request leaves the browser, loopback included, but a data: page renders', async () => {
    const launcher = new ChromeLauncher();
    try {
      const tab = await ManagedTab.open(launcher, 'offline');
      await tab.act({ kind: 'navigate', url: `${base}/` });
      const blocked = await tab.snapshot();
      expect(blocked.text).not.toContain('Contact us');
      await tab.act({
        kind: 'navigate',
        url: 'data:text/html,<title>Local</title><button>Local button</button>',
      });
      const local = await tab.snapshot();
      expect(local.title).toBe('Local');
      expect(local.elements.map((element) => element.label)).toContain('Local button');
      await tab.close();
    } finally {
      await launcher.closeAll();
    }
  }, 60_000);

  it('the step engine fills and sends a real form with a scripted decide service', async () => {
    const launcher = new ChromeLauncher();
    // Picks offers by what they say, the way a model would; never sees the value itself.
    const judged: DecideMultiInput[] = [];
    const decider: Decider = {
      judge(input) {
        judged.push(input);
        const offers = Object.entries(
          (input.questions['next_action'] as { criteria: Record<string, string> }).criteria,
        );
        const done = input.state.includes('Thanks,');
        const pick = done
          ? 'done'
          : (offers.find(
              ([action]) => action.startsWith('type ') && action.endsWith(' name'),
            )?.[0] ??
            offers.find(([, description]) => description.includes('Send'))?.[0] ??
            'blocked');
        const answers: Record<string, DecideAnswer> = {
          next_action: {
            type: 'choice',
            choice: pick,
            confidence: 0.9,
            probabilities: { [pick]: 0.9 },
          },
          goal_met: { type: 'predicate', probability: done ? 0.95 : 0.05 },
          needs_owner: { type: 'predicate', probability: 0.02 },
          page_ready: { type: 'predicate', probability: 0.98 },
        };
        return Promise.resolve({ success: true as const, answers });
      },
      extract: () => Promise.resolve({ success: true as const, choice: {} }),
      probe: () => Promise.resolve({ available: true, detail: 'scripted' }),
    };
    try {
      const tab = await ManagedTab.open(launcher, 'visitor');
      const result = await runTask(
        { target: tab, decider, saveShot },
        {
          goal: 'Send the contact form with my name',
          startUrl: `${base}/`,
          values: { name: 'Grace' },
        },
      );
      expect(result.status).toBe('done');
      expect(result.url).toContain('/done?name=Grace');
      expect(result.trace.map((step) => step.rung)).toEqual([0, 1, 1, 1]);
      // The model chooses a value by name: before anything is typed, the value is nowhere in its input, and no
      // offer string ever carries it (a typed field's value and the result page are page content, which it may read).
      expect(JSON.stringify(judged[0])).not.toContain('Grace');
      for (const input of judged) {
        const offers = Object.keys(
          (input.questions['next_action'] as { criteria: Record<string, string> }).criteria,
        );
        expect(offers.join('\n')).not.toContain('Grace');
        expect(offers.some((offer) => offer.includes(' pw'))).toBe(false);
      }
      expect(judged[0]?.images?.length).toBe(1);
      await tab.close();
    } finally {
      await launcher.closeAll();
    }
  }, 90_000);
});
