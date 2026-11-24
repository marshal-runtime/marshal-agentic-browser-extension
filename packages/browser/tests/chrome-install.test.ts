import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AxHelperRequest, AxHelperResponse } from '../src/app/ax-helper-client.js';
import {
  existingInstall,
  installChromeExtension,
  personsChrome,
  userDataDirOf,
  type InstallDeps,
} from '../src/user/chrome-install.js';
import type { UserBrowserStatus } from '../src/user/status.js';

const HOME = '/Users/me';
const ID = 'hoeikcjhdgpjcbdjjkkfngdencimlnok';
const FOLDER = `${HOME}/.marshal/browser/chrome-extension`;
const APP = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const carried = { folder: FOLDER, extensionId: ID, version: '0.5.1' };

describe('personsChrome', () => {
  const processes = [
    {
      pid: 10,
      args: `${APP} --remote-debugging-pipe --user-data-dir=${HOME}/.marshal/browser/profiles/agent --headless=new about:blank`,
    },
    {
      pid: 11,
      args: `${APP} --remote-debugging-pipe --user-data-dir=/var/folders/x/T/marshal-browser-ab12 --headless=new`,
    },
    {
      pid: 12,
      args: `/Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Framework.framework/Helpers/Google Chrome Helper --type=gpu-process`,
    },
    { pid: 13, args: `${APP} --type=renderer` },
    { pid: 22, args: `${APP} --profile-directory=Profile 1 chrome://extensions/?id=x` },
  ];

  it('picks the regular instance, never a headless or automation copy', () => {
    expect(personsChrome(processes, HOME)?.pid).toBe(22);
    expect(personsChrome(processes.slice(0, 4), HOME)).toBeUndefined();
  });

  it('reads --user-data-dir up to the next flag', () => {
    expect(userDataDirOf(`${APP} --user-data-dir=/tmp/a b/c --no-first-run`)).toBe('/tmp/a b/c');
    expect(userDataDirOf(`${APP} --profile-directory=Default`)).toBeUndefined();
  });
});

describe('existingInstall', () => {
  const prefs = (entry: unknown) => (file: string) =>
    file.endsWith('Secure Preferences')
      ? JSON.stringify({ extensions: { settings: { [ID]: entry } } })
      : undefined;

  it('tells the carried folder from another copy', () => {
    expect(existingInstall('/p', ID, FOLDER, prefs({ path: FOLDER, location: 4 }))).toMatchObject({
      present: true,
      fromCarriedFolder: true,
    });
    expect(
      existingInstall('/p', ID, FOLDER, prefs({ path: `${ID}/0.4.0_0`, location: 1 })),
    ).toMatchObject({ present: true, fromCarriedFolder: false });
    expect(existingInstall('/p', ID, FOLDER, () => undefined)).toEqual({
      present: false,
      fromCarriedFolder: false,
    });
  });
});

interface FakeState {
  devMode: boolean;
  otherCopy: boolean;
  loaded: boolean;
  page: boolean;
  dialog: boolean;
  panel: boolean;
  panelDefault: string;
  wentBack: boolean;
  typed: string;
  keys: string[];
  calls: string[];
}

interface FakeNode {
  nodeId: string;
  query: number;
  role: string;
  subrole: string;
  title: string;
  description: string;
  domId: string;
  value: string;
  text: string;
}

/** A fake chrome://extensions page and open panel behind the helper's find/press/read/setValue/keys ops. */
function fakeChrome(
  options: {
    devMode?: boolean;
    devModeBlocked?: boolean;
    otherCopy?: boolean;
    panelOpensAt?: string;
    connects?: boolean;
    frontmost?: () => string;
  } = {},
): { state: FakeState; deps: InstallDeps } {
  const state: FakeState = {
    devMode: options.devMode ?? false,
    otherCopy: options.otherCopy ?? false,
    loaded: false,
    page: false,
    dialog: false,
    panel: false,
    panelDefault: 'ORIGINAL',
    wentBack: false,
    typed: '',
    keys: [],
    calls: [],
  };
  const nodes = new Map<string, () => void>();
  const readers = new Map<string, () => string>();
  let next = 0;
  const node = (fields: Record<string, string>, onPress?: () => void): FakeNode => {
    const nodeId = `n${String((next += 1))}`;
    if (onPress) nodes.set(nodeId, onPress);
    return {
      nodeId,
      query: 0,
      role: '',
      subrole: '',
      title: '',
      description: '',
      domId: '',
      value: '',
      text: '',
      ...fields,
    };
  };
  const cards = (): FakeNode[] => [
    ...(state.otherCopy || state.loaded
      ? [
          { ...node({ domId: 'extension-id', text: `ID: ${ID}` }), query: 0 },
          {
            ...node({ domId: 'removeButton' }, () => {
              state.dialog = true;
            }),
            query: 1,
          },
        ]
      : []),
    { ...node({ domId: 'extension-id', text: 'ID: ghbmnnjooekpmoecnnnilnnbdlolhkhi' }), query: 0 },
    {
      ...node({ domId: 'removeButton' }, () => {
        throw new Error('removed the wrong extension');
      }),
      query: 1,
    },
  ];
  const helper = async (request: AxHelperRequest): Promise<AxHelperResponse> => {
    state.calls.push(request.op);
    const queries = (request['queries'] as Record<string, string>[] | undefined) ?? [];
    const first = queries[0] ?? {};
    switch (request.op) {
      case 'apps':
        return {
          ok: true,
          apps: [
            {
              bundleId: 'com.github.Electron',
              pid: 1,
              frontmost: (options.frontmost?.() ?? 'electron') === 'electron',
            },
            {
              bundleId: 'com.google.Chrome',
              pid: 22,
              frontmost: options.frontmost?.() === 'chrome',
            },
          ],
        };
      case 'keys': {
        const key = (request['keys'] as { name: string; modifiers?: string[] }[])[0];
        state.keys.push([...(key?.modifiers ?? []), key?.name ?? ''].join('+'));
        if (key?.name === 'return' && state.typed.startsWith('chrome://extensions'))
          state.page = true;
        return { ok: true };
      }
      case 'setValue':
        state.typed = String(request['text']);
        return { ok: true };
      case 'read':
        return {
          ok: true,
          value: readers.get(String(request['nodeId']))?.() ?? (state.devMode ? '1' : '0'),
        };
      case 'press': {
        const press = nodes.get(String(request['nodeId']));
        if (!press) return { ok: false, error: 'unknown element' };
        press();
        return { ok: true };
      }
      case 'find': {
        if (first.description === 'Address and search bar') {
          const bar = node({
            role: 'AXTextField',
            value: state.page && !state.wentBack ? 'chrome://extensions' : 'https://example.com/',
          });
          readers.set(bar.nodeId, () => state.typed);
          const back =
            queries[1]?.title === 'Back'
              ? [
                  {
                    ...node({ role: 'AXButton', title: 'Back' }, () => {
                      state.wentBack = true;
                    }),
                    query: 1,
                  },
                ]
              : [];
          return { ok: true, matches: [bar, ...back] };
        }
        if (first.role === 'AXWebArea')
          return { ok: true, matches: state.page ? [node({ role: 'AXWebArea' })] : [] };
        if (first.domId === 'devMode')
          return {
            ok: true,
            matches: [
              node({ domId: 'devMode', value: state.devMode ? '1' : '0' }, () => {
                if (!options.devModeBlocked) state.devMode = true;
              }),
            ],
          };
        if (first.domId === 'extension-id') return { ok: true, matches: cards() };
        if (first.domId === 'loadUnpacked')
          return {
            ok: true,
            matches: state.devMode
              ? [
                  node({ domId: 'loadUnpacked' }, () => {
                    state.panel = true;
                  }),
                ]
              : [],
          };
        if (first.role === 'AXButton' && first.title === 'Remove')
          return {
            ok: true,
            matches: state.dialog
              ? [
                  node({ title: 'Remove' }, () => {
                    state.dialog = false;
                    state.otherCopy = false;
                  }),
                ]
              : [],
          };
        if (first.role === 'AXSheet')
          return { ok: true, matches: state.panel ? [node({ role: 'AXSheet' })] : [] };
        if (first.role === 'AXPopUpButton') {
          const where =
            options.panelOpensAt ??
            (state.panelDefault === FOLDER ? 'chrome-extension' : 'Downloads');
          return {
            ok: true,
            matches: [
              { ...node({ title: 'Where:', value: where }), query: 0 },
              {
                ...node({ title: 'Select' }, () => {
                  state.panel = false;
                  state.loaded = true;
                }),
                query: 1,
              },
            ],
          };
        }
        if (first.title === 'Cancel')
          return {
            ok: true,
            matches: [
              node({ title: 'Cancel' }, () => {
                state.panel = false;
              }),
            ],
          };
        return { ok: true, matches: [] };
      }
      default:
        return { ok: false, error: `unexpected op ${request.op}` };
    }
  };
  let clock = 0;
  const deps: InstallDeps = {
    helper,
    status: async (): Promise<UserBrowserStatus> =>
      state.loaded && options.connects !== false
        ? { name: 'user', ready: true, reason: 'paired', detail: 'connected' }
        : { name: 'user', ready: false, reason: 'not_connected', detail: 'not connected' },
    processes: async () => [{ pid: 22, args: `${APP} --profile-directory=Default` }],
    launch: async () => undefined,
    readFile: () => undefined,
    panelDefault: async (mode, value) => {
      if (mode === 'get') return state.panelDefault;
      state.panelDefault = value;
      return 'ok';
    },
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => clock,
    homeDir: HOME,
    platform: 'darwin',
  };
  return { state, deps };
}

describe('installChromeExtension', () => {
  it('turns on Developer mode, loads the carried folder through the panel, waits for the connection, cleans up', async () => {
    const { state, deps } = fakeChrome();
    const result = await installChromeExtension(carried, {}, deps);
    expect(result).toMatchObject({
      ok: true,
      status: 'installed',
      chromeCameForward: false,
      chrome: { pid: 22, profile: 'Default' },
    });
    expect(result.steps.map((step) => step.step)).toEqual([
      'find Chrome',
      'navigate the front tab to chrome://extensions',
      'load chrome://extensions',
      'Developer mode',
      'open Load unpacked at the carried folder',
      'Select',
      'wait for connection',
    ]);
    expect(
      result.steps.every(
        (step) =>
          step.frontmostBefore === 'com.github.Electron#1' &&
          step.frontmostAfter === 'com.github.Electron#1',
      ),
    ).toBe(true);
    expect(state.panelDefault).toBe('ORIGINAL');
    expect(state.wentBack).toBe(true);
    expect(state.keys).toEqual(['return']);
    expect(state.calls).not.toContain('focus');
    expect(state.calls).not.toContain('clickAt');
    expect(state.calls).not.toContain('typeText');
  });

  it('removes another copy with the same id first, and never another extension', async () => {
    const { deps } = fakeChrome({ devMode: true, otherCopy: true });
    const result = await installChromeExtension(carried, {}, deps);
    expect(result.status).toBe('installed');
    expect(result.steps.map((step) => step.step)).toContain(
      'remove the other copy with the same id',
    );
  });

  it('stops when a policy keeps Developer mode off', async () => {
    const { state, deps } = fakeChrome({ devModeBlocked: true });
    const result = await installChromeExtension(carried, {}, deps);
    expect(result).toMatchObject({
      ok: false,
      status: 'stopped',
      reason: 'developer_mode_blocked',
    });
    expect(state.wentBack).toBe(true);
  });

  it('cancels the panel when it opens somewhere else, and puts the panel default back', async () => {
    const { state, deps } = fakeChrome({ devMode: true, panelOpensAt: 'Downloads' });
    const result = await installChromeExtension(carried, {}, deps);
    expect(result).toMatchObject({ ok: false, reason: 'open_panel_elsewhere' });
    expect(state.panel).toBe(false);
    expect(state.loaded).toBe(false);
    expect(state.panelDefault).toBe('ORIGINAL');
  });

  it('reports not_connected when the extension loads but never reaches Marshal', async () => {
    const { deps } = fakeChrome({ devMode: true, connects: false });
    const result = await installChromeExtension(carried, { connectTimeoutMs: 2000 }, deps);
    expect(result).toMatchObject({ ok: false, reason: 'not_connected' });
  });

  it('says when Chrome came to the front', async () => {
    let calls = 0;
    const { deps } = fakeChrome({ frontmost: () => ((calls += 1) > 6 ? 'chrome' : 'electron') });
    const result = await installChromeExtension(carried, {}, deps);
    expect(result.chromeCameForward).toBe(true);
  });

  it('dryRun only plans', async () => {
    const { state, deps } = fakeChrome();
    const result = await installChromeExtension(carried, { dryRun: true }, deps);
    expect(result.status).toBe('planned');
    expect(state.calls.filter((op) => op !== 'apps')).toEqual([]);
  });

  it('stops off macOS and without a carried folder', async () => {
    const { deps } = fakeChrome();
    expect((await installChromeExtension(carried, {}, { ...deps, platform: 'linux' })).reason).toBe(
      'not_macos',
    );
    expect((await installChromeExtension({ folder: null }, {}, deps)).reason).toBe(
      'no_carried_folder',
    );
  });

  it('waits only, when the carried folder is already loaded and connects', async () => {
    const { state, deps } = fakeChrome();
    state.loaded = true;
    const read = (file: string): string | undefined =>
      file ===
      path.join(HOME, 'Library/Application Support/Google/Chrome/Default/Secure Preferences')
        ? JSON.stringify({ extensions: { settings: { [ID]: { path: FOLDER, location: 4 } } } })
        : undefined;
    const result = await installChromeExtension(carried, {}, { ...deps, readFile: read });
    expect(result.status).toBe('already_installed');
    expect(state.calls).not.toContain('keys');
  });
});
