/**
 * The `app` backend through the real capability provider (BrowserService.invoke), the real AxHelperClient and a real
 * child process speaking the helper protocol (tests/fixtures/fake-ax-helper.mts). The fake follows the Swift helper's
 * rules, so these tests pin down what the TypeScript side sends: always this app's pid, allowRealInput only when the
 * caller set it, no request at all for secret fields or owner-signalled controls, typed text only from `values`.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { AxHelperClient } from '../src/app/ax-helper-client.js';
import { APP_SETTINGS_LINKS } from '../src/app/service.js';
import { BrowserService } from '../src/capabilities.js';
import { DecideError } from '../src/engine/decider.js';
import { FakeDecider, type Turn } from './helpers.js';

const FAKE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'fake-ax-helper.mts',
);
const PID = 4242;

interface Scenario {
  permissions?: Record<string, boolean>;
  apps?: { name: string; bundleId: string; pid: number }[];
  launch?: Record<string, unknown>;
  start?: string;
  windows?: Record<string, unknown>;
  scroll?: string;
}

const button = (
  id: string,
  label: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> => ({
  id,
  role: 'AXButton',
  label,
  x: 110,
  y: 150,
  w: 40,
  h: 30,
  enabled: true,
  editable: false,
  where: 'center',
  ...extra,
});

const calculator = (overrides: Record<string, unknown> = {}): Record<string, unknown> => {
  const elements = [
    button('n1', '7', { next: 'seven' }),
    button('n2', 'Close window', { subrole: 'AXCloseButton', ownerSignal: 'window_control' }),
    { ...button('n3', 'Name'), role: 'AXTextField', editable: true, value: '' },
    {
      ...button('n4', 'Password'),
      role: 'AXTextField',
      subrole: 'AXSecureTextField',
      editable: true,
      secure: true,
    },
    button('n5', 'Clear', { press: 'real' }),
    button('n6', 'Replace', { ownerSignal: 'dialog_default' }),
    button('n7', 'Disabled', { enabled: false }),
  ];
  const window = { title: 'Calc', x: 100, y: 100, w: 230, h: 400 };
  return {
    main: { window, text: '0', elements, ...overrides },
    seven: { window, text: '7', elements },
  };
};

const launchedCalc = (extra: Scenario = {}): Scenario => ({
  apps: [{ name: 'Notes', bundleId: 'com.apple.Notes', pid: 77 }],
  launch: {
    found: true,
    alreadyRunning: false,
    pid: PID,
    bundleId: 'com.example.calc',
    name: 'Calc',
  },
  windows: calculator(),
  ...extra,
});

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const run of cleanup.splice(0)) await run();
});

interface Harness {
  invoke: (name: string, input: Record<string, unknown>) => Promise<Record<string, unknown>>;
  decider: FakeDecider;
  requests: () => Record<string, unknown>[];
}

function harness(
  scenario: Scenario,
  turns: Turn[] = [{ choice: 'done', goalMet: 0.95 }],
  fail?: Error,
): Harness {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'mb-app-test-'));
  const logPath = path.join(dir, 'requests.jsonl');
  const client = new AxHelperClient({
    binaryPath: 'marshal-ax-helper',
    spawnFn: ((_cmd: string, _args: readonly string[], options: Record<string, unknown>) =>
      spawn(process.execPath, ['--experimental-strip-types', '--no-warnings', FAKE], {
        ...options,
        env: { ...process.env, FAKE_AX: JSON.stringify(scenario), FAKE_AX_LOG: logPath },
      })) as unknown as typeof spawn,
  });
  const decider = new FakeDecider(turns, fail);
  const service = new BrowserService(
    () => decider,
    { artifactDir: path.join(dir, 'artifacts') },
    undefined,
    {
      ax: client,
      ocr: null,
      sleep: () => Promise.resolve(),
    },
  );
  cleanup.push(async () => {
    await service.dispose();
    rmSync(dir, { recursive: true, force: true });
  });
  const requests = (): Record<string, unknown>[] =>
    existsSync(logPath)
      ? readFileSync(logPath, 'utf8')
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line) as Record<string, unknown>)
      : [];
  const invoke = async (
    name: string,
    input: Record<string, unknown>,
  ): Promise<Record<string, unknown>> =>
    (await service.invoke(name, input)).output as Record<string, unknown>;
  return { invoke, decider, requests };
}

const ACTION_OPS = new Set(['press', 'setValue', 'confirm', 'scroll', 'clickAt', 'focus']);

describe('browser.status: the app backend', () => {
  it('reports both permissions granted, the lock state and the running apps', async () => {
    const { invoke } = harness(launchedCalc());
    const status = await invoke('browser.status', {});
    const app = (status['backends'] as Record<string, unknown>[]).find(
      (b) => b['name'] === 'app',
    ) as Record<string, unknown>;
    if (process.platform !== 'darwin') {
      expect(app['reason']).toBe('not_macos');
      return;
    }
    expect(app['ready']).toBe(true);
    expect(app['permissions']).toEqual({
      accessibility: { granted: true },
      screenRecording: { granted: true },
    });
    expect(app['screenLocked']).toBe(false);
    expect(app['runningApps']).toEqual([{ name: 'Notes', bundleId: 'com.apple.Notes', pid: 77 }]);
  });

  it.runIf(process.platform === 'darwin')(
    'names a missing permission with its reason and the System Settings link',
    async () => {
      const { invoke } = harness(
        launchedCalc({ permissions: { accessibility: false, screenRecording: false } }),
      );
      const status = await invoke('browser.status', {});
      const app = (status['backends'] as Record<string, unknown>[]).find(
        (b) => b['name'] === 'app',
      ) as {
        ready: boolean;
        reason: string;
        permissions: Record<string, { granted: boolean; reason: string; settingsUrl: string }>;
      };
      expect(app.ready).toBe(false);
      expect(app.reason).toBe('accessibility_not_granted');
      expect(app.permissions['accessibility']?.settingsUrl).toBe(APP_SETTINGS_LINKS.accessibility);
      expect(app.permissions['accessibility']?.reason).toMatch(/Accessibility/);
      expect(app.permissions['screenRecording']?.settingsUrl).toBe(
        APP_SETTINGS_LINKS.screenRecording,
      );
      expect(app.permissions['screenRecording']?.reason).toMatch(/Screen Recording/);
    },
  );

  it.runIf(process.platform === 'darwin')(
    'Screen Recording alone missing leaves it ready (text-only decisions); a locked screen does not',
    async () => {
      const noShots = harness(launchedCalc({ permissions: { screenRecording: false } }));
      const a = (
        (await noShots.invoke('browser.status', {}))['backends'] as Record<string, unknown>[]
      ).find((b) => b['name'] === 'app');
      expect(a?.['ready']).toBe(true);
      const locked = harness(launchedCalc({ permissions: { screenLocked: true } }));
      const b = (
        (await locked.invoke('browser.status', {}))['backends'] as Record<string, unknown>[]
      ).find((entry) => entry['name'] === 'app');
      expect(b?.['ready']).toBe(false);
      expect(b?.['reason']).toBe('screen_locked');
      const task = await locked.invoke('browser.task', {
        goal: 'press seven',
        on: 'app',
        app: 'Calc',
      });
      expect(task).toMatchObject({ ok: false, status: 'blocked', reason: 'screen_locked' });
    },
  );
});

describe.runIf(process.platform === 'darwin')('browser.task on:"app"', () => {
  it('launches the app in the background, decides with the marked window screenshot, presses through AX, quits it', async () => {
    const { invoke, decider, requests } = harness(launchedCalc(), [
      { choice: 'click e1' },
      { choice: 'done', goalMet: 0.95 },
    ]);
    const out = await invoke('browser.task', {
      goal: 'press seven',
      on: 'app',
      app: 'com.example.calc',
    });
    expect(out).toMatchObject({ ok: true, status: 'done', backend: 'app' });
    const log = requests();
    expect(log.find((r) => r['op'] === 'launch')).toMatchObject({ bundleId: 'com.example.calc' });
    expect(log.find((r) => r['op'] === 'press')).toMatchObject({
      nodeId: 'n1',
      pid: PID,
      allowRealInput: false,
    });
    // the decision carried the window image, drawn with the refs it offered
    expect(decider.judged[0]?.images?.length).toBe(1);
    const shot = log.find((r) => r['op'] === 'screenshot' && Array.isArray(r['marks']));
    expect((shot?.['marks'] as { ref: string }[]).map((m) => m.ref)).toContain('e1');
    expect(shot).toMatchObject({ format: 'jpeg', width: 768, quality: 70 });
    // app wording, not page wording
    expect(decider.judged[0]?.questions['next_action']?.instructions).toMatch(/macOS app window/);
    expect(decider.judged[0]?.state).toContain('app://com.example.calc/Calc');
    // the app this backend started is quit at the end
    expect(log.at(-1)).toMatchObject({ op: 'quit', pid: PID });
  });

  it('every helper request names this app, and menus (which open on screen) are not read by default', async () => {
    const { invoke, requests } = harness(launchedCalc(), [
      { choice: 'click e1' },
      { choice: 'done', goalMet: 0.95 },
    ]);
    await invoke('browser.task', { goal: 'press seven', on: 'app', app: 'Calc' });
    for (const request of requests()) {
      if (['permissions', 'apps', 'launch'].includes(String(request['op']))) continue;
      expect(request['pid']).toBe(PID);
    }
    expect(
      requests()
        .filter((r) => r['op'] === 'snapshot')
        .every((r) => r['menus'] === false),
    ).toBe(true);
  });

  it('never quits an app that was already running', async () => {
    const { invoke, requests } = harness(
      launchedCalc({ apps: [{ name: 'Calc', bundleId: 'com.example.calc', pid: PID }] }),
      [{ choice: 'done', goalMet: 0.95 }],
    );
    const out = await invoke('browser.task', { goal: 'read the display', on: 'app', app: 'Calc' });
    expect(out['status']).toBe('done');
    expect(requests().some((r) => r['op'] === 'launch' || r['op'] === 'quit')).toBe(false);
  });

  it('no real input by default: a control AX cannot press stops with needs_input real_input_required', async () => {
    const { invoke, requests } = harness(launchedCalc(), [{ choice: 'click e5' }]);
    const out = await invoke('browser.task', { goal: 'clear the display', on: 'app', app: 'Calc' });
    expect(out).toMatchObject({
      status: 'needs_input',
      reason: 'real_input_required',
      element: { ref: 'e5' },
    });
    expect(requests().some((r) => r['allowRealInput'] === true)).toBe(false);
    expect(requests().some((r) => r['op'] === 'focus' || r['op'] === 'clickAt')).toBe(false);
  });

  it('with allowRealInput the same step runs and the trace says real input was used', async () => {
    const { invoke, requests } = harness(launchedCalc(), [
      { choice: 'click e5' },
      { choice: 'done', goalMet: 0.95 },
    ]);
    const out = await invoke('browser.task', {
      goal: 'clear the display',
      on: 'app',
      app: 'Calc',
      allowRealInput: true,
    });
    expect(out['status']).toBe('done');
    const trace = out['trace'] as { action: string; note?: string }[];
    expect(trace.find((step) => step.action === 'click e5')?.note).toMatch(
      /real keyboard\/mouse input/,
    );
    expect(requests().find((r) => r['op'] === 'press')).toMatchObject({ allowRealInput: true });
  });

  it('never offers a password field, and session.act refuses it without asking the helper', async () => {
    const { invoke, decider, requests } = harness(launchedCalc(), [
      { choice: 'done', goalMet: 0.95 },
    ]);
    await invoke('browser.task', {
      goal: 'fill the form',
      on: 'app',
      app: 'Calc',
      values: { name: 'Omer', secret: 'hunter2' },
    });
    const offered = Object.keys(
      decider.judged[0]?.questions['next_action']?.type === 'choice'
        ? (decider.judged[0].questions['next_action'] as { criteria: Record<string, string> })
            .criteria
        : {},
    );
    expect(offered).toContain('type e3 name');
    expect(offered.some((action) => action.split(' ')[1] === 'e4')).toBe(false);
    const opened = await invoke('browser.session.open', { on: 'app', app: 'Calc' });
    const snap = await invoke('browser.session.snapshot', { sessionId: opened['sessionId'] });
    expect((snap['elements'] as { ref: string }[]).map((e) => e.ref)).not.toContain('e4');
    const typed = await invoke('browser.session.act', {
      sessionId: opened['sessionId'],
      action: { kind: 'type', ref: 'e4', text: 'hunter2' },
    });
    expect(typed).toMatchObject({ ok: false, error: 'a password field is never touched' });
    expect(requests().some((r) => r['nodeId'] === 'n4')).toBe(false);
    await invoke('browser.session.close', { sessionId: opened['sessionId'] });
  });

  it('types only a supplied value, by name to the model', async () => {
    const { invoke, decider, requests } = harness(launchedCalc(), [
      { choice: 'type e3 name' },
      { choice: 'done', goalMet: 0.95 },
    ]);
    await invoke('browser.task', {
      goal: 'enter the name',
      on: 'app',
      app: 'Calc',
      values: { name: 'Omer Q' },
    });
    expect(requests().find((r) => r['op'] === 'setValue')).toMatchObject({
      nodeId: 'n3',
      text: 'Omer Q',
    });
    // The model chose a NAME; the text itself never reached the decision that chose it. (Once typed, the field's
    // contents are part of the window, as on the managed backend, so later decisions may see them.)
    expect(JSON.stringify(decider.judged[0])).not.toContain('Omer Q');
  });

  it('a typed owner signal (window control, dialog default button) stops with needs_owner and presses nothing', async () => {
    for (const ref of ['e2', 'e6']) {
      const { invoke, requests } = harness(launchedCalc(), [{ choice: `click ${ref}` }]);
      const out = await invoke('browser.task', { goal: 'finish up', on: 'app', app: 'Calc' });
      expect(out).toMatchObject({
        status: 'needs_owner',
        reason: 'owner_must_decide',
        element: { ref },
      });
      expect(requests().some((r) => ACTION_OPS.has(String(r['op'])))).toBe(false);
    }
  });

  it('disabled controls are not offered', async () => {
    const { invoke, decider } = harness(launchedCalc(), [{ choice: 'done', goalMet: 0.95 }]);
    await invoke('browser.task', { goal: 'look', on: 'app', app: 'Calc' });
    const criteria = (
      decider.judged[0]?.questions['next_action'] as { criteria: Record<string, string> }
    ).criteria;
    expect(Object.values(criteria).some((text) => text.includes('Disabled'))).toBe(false);
  });

  it('stops: app_not_running with launch:false, app_not_found, decisions_unavailable, needs_owner on ask_owner', async () => {
    const notRunning = harness(launchedCalc());
    expect(
      await notRunning.invoke('browser.task', {
        goal: 'press seven',
        on: 'app',
        app: 'Calc',
        launch: false,
      }),
    ).toMatchObject({ status: 'blocked', reason: 'app_not_running' });
    const missing = harness(launchedCalc({ launch: { found: false } }));
    expect(
      await missing.invoke('browser.task', { goal: 'press seven', on: 'app', app: 'Nope' }),
    ).toMatchObject({
      status: 'blocked',
      reason: 'app_not_found',
    });
    const down = harness(launchedCalc(), [], new DecideError('JEV_NOT_CONNECTED', 'down'));
    expect(
      await down.invoke('browser.task', { goal: 'press seven', on: 'app', app: 'Calc' }),
    ).toMatchObject({
      status: 'decisions_unavailable',
    });
    const owner = harness(launchedCalc(), [{ choice: 'ask_owner' }]);
    expect(
      await owner.invoke('browser.task', { goal: 'send it', on: 'app', app: 'Calc' }),
    ).toMatchObject({
      status: 'needs_owner',
    });
    const noApp = harness(launchedCalc());
    expect(await noApp.invoke('browser.task', { goal: 'press seven', on: 'app' })).toMatchObject({
      status: 'blocked',
      reason: 'app_required',
    });
  });

  it('scroll goes through AX; a window only a real wheel can scroll stops with needs_input', async () => {
    const windows = calculator({ canScrollDown: true });
    const ok = harness(launchedCalc({ windows }), [
      { choice: 'scroll_down' },
      { choice: 'done', goalMet: 0.95 },
    ]);
    expect(
      (await ok.invoke('browser.task', { goal: 'see more', on: 'app', app: 'Calc' }))['status'],
    ).toBe('done');
    expect(ok.requests().find((r) => r['op'] === 'scroll')).toMatchObject({
      direction: 'down',
      allowRealInput: false,
    });
    const real = harness(launchedCalc({ windows, scroll: 'real' }), [{ choice: 'scroll_down' }]);
    expect(
      await real.invoke('browser.task', { goal: 'see more', on: 'app', app: 'Calc' }),
    ).toMatchObject({
      status: 'needs_input',
      reason: 'real_input_required',
    });
  });

  it('browser.ask answers about the window from its screenshot and text in one decision', async () => {
    const { invoke, decider, requests } = harness(launchedCalc());
    const out = await invoke('browser.ask', {
      on: 'app',
      app: 'Calc',
      questions: { zero: { type: 'predicate', instructions: 'Does the display show 0?' } },
    });
    expect(out).toMatchObject({ ok: true, backend: 'app' });
    expect(decider.judged[0]?.images?.length).toBe(1);
    expect(decider.judged[0]?.state).toContain('Window text');
    expect(requests().some((r) => ACTION_OPS.has(String(r['op'])))).toBe(false);
  });
});
