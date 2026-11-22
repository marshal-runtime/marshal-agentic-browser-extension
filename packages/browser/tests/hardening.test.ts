/**
 * Regressions for the review-G hardening (H1-H3, M1-M7, L1-L6). Each test fails when its fix is reverted; the
 * mutation run that checked this is in the PR description.
 */
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  existsSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BrowserService, engineSettings } from '../src/capabilities.js';
import {
  chromeArgs,
  cleanupOnExit,
  EPHEMERAL_PREFERENCES,
  prepareAgentDir,
  sweepStaleProfiles,
} from '../src/chrome/launcher.js';
import { DESCRIPTORS } from '../src/descriptors.js';
import type { Decider } from '../src/engine/decider.js';
import {
  actionGuard,
  formNeedsOwner,
  isSubmitControl,
  leftHome,
  privateHost,
} from '../src/engine/guards.js';
import { maskValues, unmaskValues } from '../src/engine/offers.js';
import { runTask } from '../src/engine/task.js';
import { bridgeToSnapshot } from '../src/user/snapshot.js';
import { el, FakeDecider, FakeTarget, page, saveShot } from './helpers.js';

const HOME = 'https://shop.example.com/products';
const noSleep = (): Promise<void> => Promise.resolve();
const run = (
  target: FakeTarget,
  decider: FakeDecider,
  input: Parameters<typeof runTask>[1],
): ReturnType<typeof runTask> => runTask({ target, decider, saveShot, sleep: noSleep }, input);
const field = (ref: string, extra = {}): ReturnType<typeof el> =>
  el(ref, { kind: 'fill', tag: 'input', type: 'email', role: 'textbox', label: 'Email', ...extra });
const offered = (decider: FakeDecider, index = 0): string[] =>
  Object.keys(
    (decider.judged[index]?.questions['next_action'] as { criteria: Record<string, string> })
      .criteria,
  );

describe('H1: typing, sending, choosing and returning data happen only on the home site', () => {
  it('a script that moved the tab to another site gets no typed value (needs_owner left_site)', async () => {
    // The task opened HOME; the page then redirected itself to a look-alike.
    const target = new FakeTarget([page('https://evil.example.net/login', [field('e1')])]);
    const result = await run(target, new FakeDecider([{ choice: 'type e1 email' }]), {
      goal: 'enter my email',
      startUrl: HOME,
      values: { email: 'person@example.org' },
    });
    expect(result).toMatchObject({
      status: 'needs_owner',
      reason: 'left_site',
      element: { ref: 'e1' },
    });
    // Only the start navigation ran; nothing was typed.
    expect(target.actions).toEqual([{ kind: 'navigate', url: HOME }]);
  });

  it('a select on another site stops too; an allowed site and a subdomain of home do not', async () => {
    const select = el('e1', {
      kind: 'select',
      tag: 'select',
      role: 'combobox',
      options: [
        { value: 'a', label: 'A' },
        { value: 'b', label: 'B' },
      ],
    });
    const off = new FakeTarget([page('https://evil.example.net/', [select])]);
    const stopped = await run(off, new FakeDecider([{ choice: 'select e1 o2' }]), {
      goal: 'choose B',
      startUrl: HOME,
    });
    expect(stopped).toMatchObject({ status: 'needs_owner', reason: 'left_site' });
    for (const [url, allowedSites] of [
      ['https://cdn.partner.org/form', ['partner.org']],
      ['https://www.shop.example.com/form', []],
    ] as const) {
      const target = new FakeTarget([page(url, [field('e1')])]);
      const result = await run(
        target,
        new FakeDecider([{ choice: 'type e1 email' }, { choice: 'done', goalMet: 0.95 }]),
        {
          goal: 'enter my email',
          startUrl: HOME,
          values: { email: 'person@example.org' },
          allowedSites,
        },
      );
      expect(result.status, url).toBe('done');
      expect(target.actions[1], url).toEqual({
        kind: 'type',
        ref: 'e1',
        text: 'person@example.org',
      });
    }
  });

  it('data is not extracted from a page off the home site', async () => {
    const target = new FakeTarget([page('https://evil.example.net/answer', [el('e1')])]);
    const decider = new FakeDecider([{ choice: 'done', goalMet: 0.95 }]);
    const result = await run(target, decider, {
      goal: 'get the price',
      startUrl: HOME,
      want: { data: { type: 'object' } },
    });
    expect(result).toMatchObject({ status: 'needs_owner', reason: 'left_site' });
    expect(result.data).toBeUndefined();
    expect(decider.extracted).toHaveLength(0);
  });

  it('without a startUrl, home is the first page the task saw', async () => {
    const target = new FakeTarget([
      page(HOME, [el('e1')]),
      page('https://evil.example.net/', [field('e1')]),
    ]);
    const result = await run(
      target,
      new FakeDecider([{ choice: 'click e1' }, { choice: 'type e1 email' }]),
      { goal: 'enter my email', values: { email: 'person@example.org' } },
    );
    expect(result).toMatchObject({ status: 'needs_owner', reason: 'left_site' });
    expect(target.actions).toEqual([{ kind: 'click', ref: 'e1' }]);
  });

  it('leftHome: parent and child hosts are home, siblings and other sites are not', () => {
    expect(leftHome('shop.example.com', 'https://www.shop.example.com/', [])).toBe(false);
    expect(leftHome('www.shop.example.com', 'https://shop.example.com/', [])).toBe(false);
    expect(leftHome('shop.example.com', 'https://blog.example.com/', [])).toBe(true);
    expect(leftHome(null, 'https://anything.test/', [])).toBe(false);
  });
});

describe('H2: a form is checked by where it sends', () => {
  const offsite = 'https://collect.evil.example.net/steal';
  it('Enter in a field of a form that sends off-site stops (form_leaves_site), with the target address', async () => {
    const target = new FakeTarget([
      page(HOME, [field('e1', { formAction: offsite })]),
      page(HOME, [field('e1', { value: 'person@example.org', formAction: offsite })]),
    ]);
    const result = await run(
      target,
      new FakeDecider([{ choice: 'type e1 email' }, { choice: 'submit e1' }]),
      { goal: 'subscribe', startUrl: HOME, values: { email: 'person@example.org' } },
    );
    expect(result).toMatchObject({
      status: 'needs_owner',
      reason: 'form_leaves_site',
      element: { ref: 'e1', href: offsite },
    });
    expect(target.actions).toEqual([
      { kind: 'navigate', url: HOME },
      { kind: 'type', ref: 'e1', text: 'person@example.org' },
    ]);
  });

  it('a click on the submit button of such a form stops too; a plain button does not', async () => {
    const submit = el('e2', {
      tag: 'button',
      type: 'submit',
      label: 'Subscribe',
      formAction: offsite,
    });
    const target = new FakeTarget([page(HOME, [submit])]);
    const result = await run(target, new FakeDecider([{ choice: 'click e2' }]), {
      goal: 'subscribe',
    });
    expect(result).toMatchObject({ status: 'needs_owner', reason: 'form_leaves_site' });
    expect(target.actions).toEqual([]);
    const plain = el('e2', { tag: 'button', type: 'button', label: 'Menu', formAction: offsite });
    const ok = new FakeTarget([page(HOME, [plain])]);
    await run(ok, new FakeDecider([{ choice: 'click e2' }, { choice: 'done', goalMet: 0.95 }]), {
      goal: 'open the menu',
    });
    expect(ok.actions).toEqual([{ kind: 'click', ref: 'e2' }]);
  });

  it('a same-site form is sent', async () => {
    const submit = el('e2', {
      tag: 'button',
      type: 'submit',
      label: 'Search',
      formAction: `${HOME}/search`,
    });
    const target = new FakeTarget([page(HOME, [submit])]);
    await run(
      target,
      new FakeDecider([{ choice: 'click e2' }, { choice: 'done', goalMet: 0.95 }]),
      {
        goal: 'search',
      },
    );
    expect(target.actions).toEqual([{ kind: 'click', ref: 'e2' }]);
  });

  it('the user backend (form targets unknown) does not send a form once a caller value is on the page', async () => {
    const unknown = {
      ...page(HOME, [field('e1'), el('e2', { label: 'Send' })]),
      formActionsKnown: undefined,
    };
    const target = new FakeTarget([unknown]);
    const result = await run(
      target,
      new FakeDecider([{ choice: 'type e1 email' }, { choice: 'click e2' }]),
      { goal: 'send my email', values: { email: 'person@example.org' } },
    );
    expect(result).toMatchObject({ status: 'needs_owner', reason: 'form_target_unknown' });
    expect(target.actions).toEqual([{ kind: 'type', ref: 'e1', text: 'person@example.org' }]);
    // With no value typed or shown, a search button still works there.
    const search = new FakeTarget([
      { ...page(HOME, [el('e2', { label: 'Search' })]), formActionsKnown: undefined },
    ]);
    await run(
      search,
      new FakeDecider([{ choice: 'click e2' }, { choice: 'done', goalMet: 0.95 }]),
      {
        goal: 'search',
      },
    );
    expect(search.actions).toEqual([{ kind: 'click', ref: 'e2' }]);
  });

  it('an app window has no web forms: Enter after typing is not a form send there', async () => {
    class AppTarget extends FakeTarget {
      override readonly backend = 'app' as const;
    }
    // The app snapshot carries no form targets.
    const app = (url: string, elements: ReturnType<typeof el>[]): ReturnType<typeof page> => ({
      ...page(url, elements),
      formActionsKnown: undefined,
    });
    const target = new AppTarget([
      app('app://com.apple.TextEdit/Find', [field('e1', { tag: 'AXTextField', type: '' })]),
      app('app://com.apple.TextEdit/Find', [
        field('e1', { tag: 'AXTextField', type: '', value: 'needle text' }),
      ]),
      app('app://com.apple.TextEdit/Found', []),
    ]);
    const result = await run(
      target,
      new FakeDecider([
        { choice: 'type e1 query' },
        { choice: 'submit e1' },
        { choice: 'done', goalMet: 0.95 },
      ]),
      { goal: 'find the text', values: { query: 'needle text' } },
    );
    expect(result.status).toBe('done');
    expect(target.actions.map((action) => action.kind)).toEqual(['type', 'submit']);
  });

  it('formNeedsOwner and isSubmitControl', () => {
    const known = { url: HOME, formActionsKnown: true };
    const unknown = { url: HOME };
    expect(formNeedsOwner(el('e1', { formAction: offsite }), known, [], false)).toBe(
      'form_leaves_site',
    );
    expect(formNeedsOwner(el('e1', { formAction: `${HOME}/pay/now` }), known, [], false)).toBe(
      'form_leaves_site',
    );
    expect(formNeedsOwner(el('e1', { formAction: 'mailto:x@y.z' }), known, [], false)).toBe(
      'form_leaves_site',
    );
    expect(
      formNeedsOwner(el('e1', { formAction: offsite }), known, ['evil.example.net'], false),
    ).toBeNull();
    expect(formNeedsOwner(el('e1', { formAction: `${HOME}?q=1` }), known, [], true)).toBeNull();
    expect(formNeedsOwner(el('e1'), known, [], true)).toBeNull();
    expect(formNeedsOwner(el('e1'), unknown, [], true)).toBe('form_target_unknown');
    expect(formNeedsOwner(el('e1'), unknown, [], false)).toBeNull();
    expect(isSubmitControl(el('e1', { tag: 'button', type: '' }))).toBe(true);
    expect(isSubmitControl(el('e1', { tag: 'button', type: 'submit' }))).toBe(true);
    expect(isSubmitControl(el('e1', { tag: 'button', type: 'button' }))).toBe(false);
    expect(isSubmitControl(el('e1', { tag: 'input', type: 'image' }))).toBe(true);
    expect(isSubmitControl(el('e1', { tag: 'input', type: 'text' }))).toBe(false);
  });
});

describe('H3 / L2 / L1: the Chrome command line and the agent folder', () => {
  const has = (args: string[], flag: string): boolean => args.includes(flag);
  it('ephemeral: no UDP outside the proxy (real check in chrome.real.test.ts), no component updates, no background networking', () => {
    expect(EPHEMERAL_PREFERENCES.webrtc.ip_handling_policy).toBe('disable_non_proxied_udp');
    const args = chromeArgs('ephemeral', '/tmp/x', false, 'darwin');
    expect(has(args, '--disable-component-update')).toBe(true);
    expect(has(args, '--disable-background-networking')).toBe(true);
    expect(has(args, '--use-mock-keychain')).toBe(true);
  });

  it('lasting on macOS uses the real keychain; on Linux it keeps the basic store', () => {
    const mac = chromeArgs('lasting', '/tmp/x', true, 'darwin');
    expect(has(mac, '--use-mock-keychain')).toBe(false);
    expect(has(mac, '--password-store=basic')).toBe(false);
    expect(has(chromeArgs('lasting', '/tmp/x', true, 'linux'), '--password-store=basic')).toBe(
      true,
    );
  });

  it('prepareAgentDir creates the profile folder 0700 and makes an existing one 0700', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'mb-l1-'));
    try {
      const fresh = path.join(root, 'agent');
      await prepareAgentDir(fresh);
      expect(statSync(fresh).mode & 0o777).toBe(0o700);
      const old = path.join(root, 'old');
      mkdirSync(old, { mode: 0o755 });
      await prepareAgentDir(old);
      expect(statSync(old).mode & 0o777).toBe(0o700);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('M6: temporary profiles do not outlive their host', () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });
  const tempRoot = (): string => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'mb-m6-'));
    roots.push(root);
    return root;
  };
  const profile = (root: string, name: string, pid?: number, ageMs = 0): string => {
    const dir = path.join(root, name);
    mkdirSync(dir);
    if (pid !== undefined)
      symlinkSync(`host.local-${String(pid)}`, path.join(dir, 'SingletonLock'));
    const when = (Date.now() - ageMs) / 1000;
    utimesSync(dir, when, when);
    return dir;
  };

  it('removes a profile whose Chrome is gone and an old unlocked one; keeps live, young and foreign folders', () => {
    const root = tempRoot();
    const dead = profile(root, 'marshal-browser-aaaaaa', 111);
    const live = profile(root, 'marshal-browser-bbbbbb', 222);
    const oldUnlocked = profile(root, 'marshal-browser-cccccc', undefined, 30 * 60_000);
    const youngUnlocked = profile(root, 'marshal-browser-dddddd');
    const other = profile(root, 'something-else', 111);
    const removed = sweepStaleProfiles(root, (pid) => pid === 222);
    expect(removed.sort()).toEqual([dead, oldUnlocked].sort());
    expect(existsSync(dead)).toBe(false);
    expect(existsSync(oldUnlocked)).toBe(false);
    for (const kept of [live, youngUnlocked, other]) expect(existsSync(kept), kept).toBe(true);
  });

  it('a managed launcher registers its temporary profile for the exit hook', async () => {
    const { ChromeLauncher, findChrome, liveTempDirs } = await import('../src/chrome/launcher.js');
    if (!findChrome().path) return;
    const launcher = new ChromeLauncher();
    try {
      const { ManagedTab } = await import('../src/chrome/tab.js');
      const tab = await ManagedTab.open(launcher, 'visitor');
      const dirs = liveTempDirs();
      expect(dirs).toHaveLength(1);
      expect(existsSync(dirs[0] ?? '')).toBe(true);
      // What process exit runs: Chrome is killed and the folder removed, synchronously.
      cleanupOnExit();
      expect(existsSync(dirs[0] ?? '')).toBe(false);
      await tab.close().catch(() => undefined);
    } finally {
      await launcher.closeAll();
    }
  }, 60_000);
});

describe('M1: caller values are masked in what the model reads', () => {
  const values = { query: 'asyncio tasks', email: 'person@example.org', pin: '42' };
  it('page text, labels and the goal show ⟨value name⟩; extracted data gets the value back', async () => {
    const target = new FakeTarget([
      page(
        HOME,
        [
          el('e1', {
            tag: 'a',
            role: 'link',
            label: 'Results for asyncio tasks',
            href: `${HOME}?q=asyncio tasks`,
          }),
        ],
        'Showing 3 results for asyncio tasks. Sent to person@example.org.',
      ),
    ]);
    const decider = new FakeDecider([{ choice: 'done', goalMet: 0.95 }], undefined, {
      heading: 'Results for ⟨value query⟩',
    });
    const result = await run(target, decider, {
      goal: 'search for asyncio tasks',
      startUrl: HOME,
      values,
      want: { data: { type: 'object' } },
    });
    const sent = JSON.stringify([decider.judged, decider.extracted]);
    expect(sent).not.toContain('asyncio tasks');
    expect(sent).not.toContain('person@example.org');
    expect(sent).toContain('⟨value query⟩');
    expect(sent).toContain('⟨value email⟩');
    expect(result.data).toEqual({ heading: 'Results for asyncio tasks' });
  });

  it('values shorter than 3 characters are not masked; the longest value wins', () => {
    expect(maskValues('pin 42 and ab', { pin: '42', two: 'ab' })).toBe('pin 42 and ab');
    expect(maskValues('a big cat', { long: 'big cat', short: 'big' })).toBe('a ⟨value long⟩');
    expect(unmaskValues({ a: ['⟨value long⟩'] }, { long: 'big cat' })).toEqual({ a: ['big cat'] });
  });

  it('done chosen twice at 0.75 or more ends the task; twice at 0.6 is low_confidence', async () => {
    const twice = await run(
      new FakeTarget([page(HOME, [el('e1')])]),
      new FakeDecider([{ choice: 'done', confidence: 0.8, goalMet: 0.3 }]),
      { goal: 'look' },
    );
    expect(twice.status).toBe('done');
    expect(twice.trace.at(-1)?.note).toBe('done chosen twice with high confidence');
    const weak = await run(
      new FakeTarget([page(HOME, [el('e1')])]),
      new FakeDecider([{ choice: 'done', confidence: 0.6, goalMet: 0.3 }]),
      { goal: 'look' },
    );
    expect(weak).toMatchObject({ status: 'low_confidence', reason: 'done_not_confirmed' });
  });

  it('the values descriptor and the guidance say what the model reads', () => {
    const task = DESCRIPTORS.find((descriptor) => descriptor.name === 'browser.task');
    const text = JSON.stringify(task?.inputSchema);
    expect(text).toContain('⟨value <name>⟩');
    expect(text).not.toContain('never the values');
  });
});

describe('M2 / M3 / R4: stop threshold, top-2 agreement and the goal_met rule', () => {
  it('need_value or blocked at 0.3 is re-decided; at 0.5 it is taken', async () => {
    for (const stop of ['need_value', 'blocked']) {
      const low = new FakeTarget([page(HOME, [el('e1')])]);
      const lowResult = await run(
        low,
        new FakeDecider([
          { choice: stop, confidence: 0.3 },
          { choice: 'click e1' },
          { choice: 'done', goalMet: 0.95 },
        ]),
        { goal: 'x y z' },
      );
      expect(lowResult.status, stop).toBe('done');
      const sure = await run(
        new FakeTarget([page(HOME, [el('e1')])]),
        new FakeDecider([{ choice: stop, confidence: 0.5 }]),
        { goal: 'x y z' },
      );
      expect(sure.status, stop).toBe(stop === 'need_value' ? 'needs_input' : 'blocked');
    }
  });

  it("a retry that picks the first decision's runner-up acts; one outside its top two does not", async () => {
    const split = { 'click e1': 0.11, 'click e2': 0.1, wait: 0.02 };
    const both = page(HOME, [el('e1'), el('e2')]);
    const target = new FakeTarget([both, both, page(`${HOME}?2`, [el('e1')])]);
    const result = await run(
      target,
      new FakeDecider([
        { choice: 'click e1', confidence: 0.11, probabilities: split },
        { choice: 'click e2', confidence: 0.12, probabilities: { 'click e2': 0.12 } },
        { choice: 'done', goalMet: 0.95 },
      ]),
      { goal: 'pick one' },
    );
    expect(result.status).toBe('done');
    expect(target.actions).toEqual([{ kind: 'click', ref: 'e2' }]);
    const outside = new FakeTarget([page(HOME, [el('e1'), el('e2'), el('e3')])]);
    const refused = await run(
      outside,
      new FakeDecider([
        { choice: 'click e1', confidence: 0.11, probabilities: split },
        { choice: 'click e3', confidence: 0.12, probabilities: { 'click e3': 0.12 } },
      ]),
      { goal: 'pick one' },
    );
    expect(refused.status).toBe('low_confidence');
    expect(outside.actions).toEqual([]);
  });

  it('a confident page action is taken even when goal_met is high; wait or a weak pick with goal_met high stops', async () => {
    // Bench smoke: `submit` at 0.85 with goal_met 0.97 ended the task without sending.
    const target = new FakeTarget([
      page(HOME, [el('e1', { label: 'Send' })]),
      page(`${HOME}/sent`, []),
    ]);
    await run(
      target,
      new FakeDecider([
        { choice: 'click e1', confidence: 0.85, goalMet: 0.97 },
        { choice: 'done', goalMet: 0.97 },
      ]),
      { goal: 'send it' },
    );
    expect(target.actions).toEqual([{ kind: 'click', ref: 'e1' }]);
    for (const turn of [
      { choice: 'wait', goalMet: 0.9 },
      { choice: 'click e1', confidence: 0.1, goalMet: 0.9 },
    ]) {
      const stopped = new FakeTarget([page(HOME, [el('e1')])]);
      const result = await run(stopped, new FakeDecider([turn]), { goal: 'look' });
      expect(result.status, turn.choice).toBe('done');
      expect(stopped.actions, turn.choice).toEqual([]);
    }
  });
});

describe('M4: permissions say what each capability reaches', () => {
  const of = (name: string): { risk: string; reason: string }[] =>
    (
      DESCRIPTORS.find((descriptor) => descriptor.name === name) as unknown as {
        permissions?: { risk: string; reason: string }[];
      }
    ).permissions ?? [];
  it('browser.ask asks a medium permission; open and task say the agent and user profiles are high risk', () => {
    expect(of('browser.ask')).toEqual([
      expect.objectContaining({ permission: 'marshal.tool.invoke:browser.ask', risk: 'medium' }),
    ]);
    expect(of('browser.session.open')[0]?.risk).toBe('medium');
    for (const name of ['browser.ask', 'browser.session.open', 'browser.task'])
      expect(of(name)[0]?.reason, name).toMatch(/High risk with profile "agent".*on "user"/);
  });
});

describe('M5: a task that cannot decide opens nothing', () => {
  const down: Decider = {
    judge: () => Promise.reject(new Error('must not be called')),
    extract: () => Promise.reject(new Error('must not be called')),
    probe: () =>
      Promise.resolve({ available: false, detail: 'marshal.models.decide is not installed' }),
  };
  it('browser.task and browser.ask return decisions_unavailable before any Chrome starts', async () => {
    const service = new BrowserService(() => down, {
      chromePath: '/nonexistent/chrome',
      artifactDir: '/tmp/marshal-browser-test',
    });
    try {
      const task = (
        await service.invoke('browser.task', {
          goal: 'read the page',
          startUrl: HOME,
          on: 'managed',
        })
      ).output as Record<string, unknown>;
      expect(task).toMatchObject({
        ok: true,
        status: 'decisions_unavailable',
        reason: 'marshal.models.decide is not installed',
      });
      const ask = (
        await service.invoke('browser.ask', { url: HOME, questions: { kind: 'what is it?' } })
      ).output as Record<string, unknown>;
      expect(ask).toMatchObject({ ok: false, status: 'decisions_unavailable' });
    } finally {
      await service.dispose();
    }
  });
});

describe('L3: a public task does not follow the page into a private address', () => {
  it('stops with private_address; a task that starts on a private host is allowed there', async () => {
    const target = new FakeTarget([page('http://169.254.169.254/computeMetadata/v1/', [el('e1')])]);
    const result = await run(target, new FakeDecider([{ choice: 'click e1' }]), {
      goal: 'look',
      startUrl: HOME,
    });
    expect(result).toMatchObject({ status: 'needs_owner', reason: 'private_address' });
    const local = new FakeTarget([page('http://127.0.0.1:8080/', [el('e1')])]);
    const ok = await run(local, new FakeDecider([{ choice: 'done', goalMet: 0.95 }]), {
      goal: 'look',
      startUrl: 'http://127.0.0.1:8080/',
    });
    expect(ok.status).toBe('done');
  });

  it('privateHost', () => {
    for (const host of [
      'localhost',
      'printer.local',
      'metadata.google.internal',
      '10.1.2.3',
      '127.0.0.1',
      '169.254.169.254',
      '172.20.0.1',
      '192.168.1.1',
      '100.64.0.1',
      '[::1]',
      '[fd00::1]',
      '[fe80::1]',
      '[::ffff:7f00:1]',
      '::ffff:10.0.0.1',
    ])
      expect(privateHost(host), host).toBe(true);
    for (const host of ['example.com', '8.8.8.8', '172.32.0.1', '[2001:db8::1]', null])
      expect(privateHost(host), String(host)).toBe(false);
  });
});

describe('L5 / L6', () => {
  it('a missing next_action is asked once more; twice is blocked decision_missing', async () => {
    const target = new FakeTarget([page(HOME, [el('e1')]), page(`${HOME}?2`, [el('e1')])]);
    const result = await run(
      target,
      new FakeDecider([
        { choice: 'x', missing: true },
        { choice: 'click e1' },
        { choice: 'done', goalMet: 0.95 },
      ]),
      { goal: 'x y z' },
    );
    expect(result.status).toBe('done');
    expect(target.actions).toEqual([{ kind: 'click', ref: 'e1' }]);
    const twice = await run(
      new FakeTarget([page(HOME, [el('e1')])]),
      new FakeDecider([{ choice: 'x', missing: true }]),
      { goal: 'x y z' },
    );
    expect(twice).toMatchObject({ status: 'blocked', reason: 'decision_missing' });
  });

  it('minConfidence 0 is a setting, not "unset"', () => {
    expect(engineSettings({ minConfidence: 0 })).toMatchObject({ minConfidence: 0 });
    expect(engineSettings({})).not.toHaveProperty('minConfidence');
  });
});

describe('the offers still never carry a value', () => {
  it('a typed field is described by its value name in every offer', async () => {
    const decider = new FakeDecider([{ choice: 'blocked', confidence: 0.9 }]);
    await run(
      new FakeTarget([page(HOME, [field('e1', { value: 'person@example.org' })])]),
      decider,
      {
        goal: 'x y z',
        values: { email: 'person@example.org' },
      },
    );
    expect(offered(decider).join('\n')).not.toContain('person@example.org');
  });
});

describe("H2 on the person's Chrome: the bridge snapshot", () => {
  const raw = (extra: Record<string, unknown> = {}): Parameters<typeof bridgeToSnapshot>[0] => ({
    url: HOME,
    title: 'Shop',
    text: 'hello',
    elements: [
      { ref: 'e1', tag: 'button', role: 'button', name: 'Send', x: 10, y: 10, w: 40, h: 20 },
    ],
    ...extra,
  });
  it("today's bridge reports no form targets, so the engine treats them as unknown", () => {
    const snap = bridgeToSnapshot(raw());
    expect(snap.formActionsKnown).toBeUndefined();
    expect(formNeedsOwner(snap.elements[0] as ReturnType<typeof el>, snap, [], true)).toBe(
      'form_target_unknown',
    );
  });
  it('a bridge that reports them is trusted for them', () => {
    const snap = bridgeToSnapshot(
      raw({
        formActions: true,
        elements: [
          {
            ref: 'e1',
            tag: 'button',
            role: 'button',
            name: 'Send',
            x: 10,
            y: 10,
            w: 40,
            h: 20,
            formAction: 'https://evil.example.net/x',
          },
        ],
      }),
    );
    expect(snap.formActionsKnown).toBe(true);
    expect(formNeedsOwner(snap.elements[0] as ReturnType<typeof el>, snap, [], false)).toBe(
      'form_leaves_site',
    );
  });
});

describe('actionGuard: every per-action check in one call (a multi-action plan calls it for each action)', () => {
  const at = { url: HOME, formActionsKnown: true };
  const ctx = {
    home: 'shop.example.com',
    allowedSites: [],
    backend: 'managed' as const,
    holdsValue: true,
  };
  it('names the first rule an action breaks, or null', () => {
    expect(
      actionGuard({ kind: 'type', element: field('e1', { secret: true }) }, at, ctx)?.reason,
    ).toBe('secret_field');
    expect(
      actionGuard({ kind: 'type', element: field('e1') }, { url: 'https://evil.example.net/' }, ctx)
        ?.reason,
    ).toBe('left_site');
    expect(
      actionGuard(
        { kind: 'submit', element: field('e1', { formAction: 'https://evil.example.net/x' }) },
        at,
        ctx,
      ),
    ).toMatchObject({
      reason: 'form_leaves_site',
      element: { href: 'https://evil.example.net/x' },
    });
    expect(
      actionGuard({ kind: 'click', element: el('e2', { label: 'Send' }) }, { url: HOME }, ctx)
        ?.reason,
    ).toBe('form_target_unknown');
    expect(
      actionGuard(
        {
          kind: 'click',
          element: el('e3', { tag: 'a', role: 'link', href: 'https://evil.example.net/' }),
        },
        at,
        ctx,
      )?.reason,
    ).toBe('owner_must_decide');
    expect(
      actionGuard({ kind: 'click', element: el('e4', { ownerSignal: 'AXCloseButton' }) }, at, ctx)
        ?.reason,
    ).toBe('owner_must_decide');
    expect(actionGuard({ kind: 'type', element: field('e1') }, at, ctx)).toBeNull();
    expect(actionGuard({ kind: 'scroll_down' }, at, ctx)).toBeNull();
  });

  it('an app window: no site or form check (no address, no web forms), owner signals and secrets still stop', () => {
    const app = { url: 'app://com.apple.TextEdit/Untitled' };
    const appCtx = { ...ctx, home: null, backend: 'app' as const };
    expect(
      actionGuard({ kind: 'submit', element: field('e1', { tag: 'AXTextField' }) }, app, appCtx),
    ).toBeNull();
    expect(
      actionGuard({ kind: 'type', element: field('e1', { tag: 'AXTextField' }) }, app, appCtx),
    ).toBeNull();
    expect(
      actionGuard(
        { kind: 'click', element: el('e2', { ownerSignal: 'AXDefaultButton' }) },
        app,
        appCtx,
      )?.reason,
    ).toBe('owner_must_decide');
    expect(
      actionGuard(
        { kind: 'type', element: field('e3', { tag: 'AXSecureTextField', secret: true }) },
        app,
        appCtx,
      )?.reason,
    ).toBe('secret_field');
  });
});

describe('the app backend runs the same masking and stop threshold', () => {
  class AppTarget extends FakeTarget {
    override readonly backend = 'app' as const;
  }
  const app = (
    title: string,
    elements: ReturnType<typeof el>[],
    text = 'window text',
  ): ReturnType<typeof page> => ({
    ...page(`app://com.apple.Notes/${title}`, elements, text),
    formActionsKnown: undefined,
  });
  it('a caller value shown in the window is masked; a window whose title changes is not "another site"', async () => {
    const target = new AppTarget([
      app('Note', [field('e1', { tag: 'AXTextField', label: 'Search notes' })]),
      app(
        'Results for alpha-secret',
        [field('e1', { tag: 'AXTextField', value: 'alpha-secret' })],
        'Results for alpha-secret',
      ),
    ]);
    const decider = new FakeDecider([
      { choice: 'type e1 query' },
      { choice: 'submit e1' },
      { choice: 'done', goalMet: 0.95 },
    ]);
    const result = await run(target, decider, {
      goal: 'search my notes',
      values: { query: 'alpha-secret' },
    });
    expect(result.status).toBe('done');
    expect(target.actions.map((action) => action.kind)).toEqual(['type', 'submit']);
    expect(JSON.stringify(decider.judged)).not.toContain('alpha-secret');
    expect(JSON.stringify(decider.judged)).toContain('⟨value query⟩');
  });

  it('need_value at 0.3 is re-decided on an app window too', async () => {
    const target = new AppTarget([app('Note', [el('e1', { tag: 'AXButton' })])]);
    const result = await run(
      target,
      new FakeDecider([
        { choice: 'need_value', confidence: 0.3 },
        { choice: 'click e1' },
        { choice: 'done', goalMet: 0.95 },
      ]),
      { goal: 'press it' },
    );
    expect(result.status).toBe('done');
    expect(target.actions).toEqual([{ kind: 'click', ref: 'e1' }]);
  });
});
