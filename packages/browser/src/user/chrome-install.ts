/**
 * browser.chrome.install: loads the carried Marley Chrome extension into the person's own Chrome by itself, in the
 * background (Chrome is never brought to the front and the pointer never moves), so nobody clicks through
 * chrome://extensions.
 *
 * The steps, each through Accessibility (AXPress / AXValue, via marshal-ax-helper's find/press/setValue ops) or a key
 * posted to Chrome's pid (the helper's keys op), never real input:
 *   1. find the person's Chrome: the regular instance, never a headless copy or one this package started for its
 *      agent/visitor profiles; start it with `open -g -n` when none runs;
 *   2. navigate the front tab to chrome://extensions (the address bar's AXValue, then Return posted to the pid). A new
 *      tab is never opened: Cmd+T, the New Tab button, Window > Extensions and Option+Return all made Chrome activate
 *      itself (lsappinfo every 100 ms, 2026-11-24), the value write plus Return did not;
 *   3. turn Developer mode on (a managed policy that blocks it stops here);
 *   4. remove a copy with the carried id that was not loaded from the carried folder (the Marley website's zip), and
 *      confirm Chrome's dialog;
 *   5. press Load unpacked. The macOS open panel takes no background keys (it runs in the Open and Save Panel Service,
 *      and Cmd+Shift+G posted to Chrome or to the service never reaches it), so the panel is pointed at the folder
 *      beforehand through the shared panel default `NSOSPLastRootDirectory` of com.google.Chrome, checked by its
 *      "Where:" value, and Select is pressed; the previous default is put back;
 *   6. wait until the extension connects to the bridge (the folder carries marshal-bridge.json with the address, so
 *      there is no popup step), then press the toolbar's Back button so the person's page comes back.
 * Every step records the frontmost app before and after; the result says whether Chrome ever came to the front.
 */
import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'fs';
import os from 'node:os';
import path from 'node:path';
import type { AxHelperRequest, AxHelperResponse } from '../app/ax-helper-client.js';
import type { CarriedExtension, UserBrowserStatus } from './status.js';

export type InstallStopReason =
  | 'no_carried_folder'
  | 'not_macos'
  | 'chrome_not_found'
  | 'chrome_did_not_start'
  | 'no_window'
  | 'page_did_not_load'
  | 'developer_mode_blocked'
  | 'remove_failed'
  | 'open_panel_failed'
  | 'open_panel_elsewhere'
  | 'not_loaded'
  | 'not_connected'
  | 'helper_failed';

export interface InstallStep {
  readonly step: string;
  readonly ok: boolean;
  readonly detail?: string;
  readonly frontmostBefore: string;
  readonly frontmostAfter: string;
  readonly ms: number;
}

export interface ChromeInstallResult {
  readonly ok: boolean;
  /** installed: loaded now; already_installed: the carried folder was loaded before; planned: dryRun. */
  readonly status: 'installed' | 'already_installed' | 'planned' | 'stopped';
  readonly reason?: InstallStopReason;
  readonly error?: string;
  readonly folder: string | null;
  readonly extensionId?: string;
  readonly chrome?: {
    readonly pid: number;
    readonly launched: boolean;
    readonly userDataDir: string;
    readonly profile: string;
  };
  /** What the profile's preferences said about the carried id before the run. */
  readonly existing?: ExistingInstall;
  readonly steps: readonly InstallStep[];
  /** True when Chrome was the frontmost app after any step while it was not before the run. */
  readonly chromeCameForward: boolean;
  readonly userBrowser?: {
    readonly ready: boolean;
    readonly reason: string;
    readonly detail: string;
  };
}

export interface ExistingInstall {
  readonly present: boolean;
  /** Loaded unpacked from the carried folder. */
  readonly fromCarriedFolder: boolean;
  readonly path?: string;
  readonly location?: number;
  readonly version?: string;
}

export interface ChromeProcess {
  readonly pid: number;
  readonly args: string;
}

export interface InstallDeps {
  readonly helper: (request: AxHelperRequest) => Promise<AxHelperResponse>;
  readonly status: () => Promise<UserBrowserStatus>;
  /** `ps -axo pid=,args=` lines. */
  readonly processes: () => Promise<readonly ChromeProcess[]>;
  /** Starts Chrome without activating it (open -g -n -a <app>). */
  readonly launch: (appPath: string) => Promise<void>;
  readonly readFile: (file: string) => string | undefined;
  /** Gets / sets / restores a data default (base64) of another app's domain; '' when unset. */
  readonly panelDefault: (mode: 'get' | 'set' | 'restore', value: string) => Promise<string>;
  readonly sleep: (ms: number) => Promise<void>;
  readonly now: () => number;
  readonly homeDir: string;
  readonly platform: NodeJS.Platform;
}

export interface InstallInput {
  readonly pid?: number;
  readonly dryRun?: boolean;
  /** Chrome.app to start when none runs (default /Applications/Google Chrome.app). */
  readonly appPath?: string;
  readonly connectTimeoutMs?: number;
}

const CHROME_APP = '/Applications/Google Chrome.app';
const CHROME_BUNDLE = 'com.google.Chrome';
const PANEL_DEFAULT = 'NSOSPLastRootDirectory';
const UNPACKED_LOCATION = 4;
const SKIP_WEB = ['AXWebArea'];
const EXTENSIONS_URL = 'chrome://extensions/';
/** The open panel's file browser and sidebar hold every file of the folder: never walked. */
const SKIP_PANEL_LISTS = ['AXBrowser', 'AXOutline', 'AXScrollArea', 'AXWebArea'];

/** The person's Chrome among `processes`: the app's main binary, not headless, not an automation profile. */
export function personsChrome(
  processes: readonly ChromeProcess[],
  homeDir: string,
  appPath: string = CHROME_APP,
): ChromeProcess | undefined {
  const binary = `${appPath}/Contents/MacOS/`;
  const ours = path.join(homeDir, '.marshal', 'browser');
  return processes.find(({ args }) => {
    if (!args.startsWith(binary) || args.includes(' --type=')) return false;
    if (/\s--headless(=|\s|$)/.test(args) || /\s--remote-debugging-(pipe|port)/.test(args))
      return false;
    const dataDir = userDataDirOf(args);
    if (!dataDir) return true;
    return !dataDir.startsWith(ours) && !path.basename(dataDir).startsWith('marshal-browser-');
  });
}

/** `--user-data-dir=<dir>` of a Chrome command line (the folder may contain spaces: it ends at the next ` --`). */
export function userDataDirOf(args: string): string | undefined {
  const match = /\s--user-data-dir=(.+?)(?=\s--|\s+[a-z]+:\/\/|$)/.exec(args);
  return match?.[1]?.trim();
}

export function defaultUserDataDir(homeDir: string): string {
  return path.join(homeDir, 'Library', 'Application Support', 'Google', 'Chrome');
}

/** The profile chrome://extensions opens in: Local State's last used profile (default "Default"). */
export function lastUsedProfile(userDataDir: string, read: InstallDeps['readFile']): string {
  try {
    const state = JSON.parse(read(path.join(userDataDir, 'Local State')) ?? '{}') as {
      profile?: { last_used?: unknown };
    };
    return typeof state.profile?.last_used === 'string' ? state.profile.last_used : 'Default';
  } catch {
    return 'Default';
  }
}

/** What the profile's (Secure) Preferences say about `extensionId`. Chrome writes them lazily: a hint, not proof. */
export function existingInstall(
  profileDir: string,
  extensionId: string,
  folder: string,
  read: InstallDeps['readFile'],
): ExistingInstall {
  for (const name of ['Secure Preferences', 'Preferences']) {
    try {
      const prefs = JSON.parse(read(path.join(profileDir, name)) ?? '{}') as {
        extensions?: {
          settings?: Record<
            string,
            { path?: unknown; location?: unknown; manifest?: { version?: unknown } }
          >;
        };
      };
      const entry = prefs.extensions?.settings?.[extensionId];
      if (!entry) continue;
      const entryPath = typeof entry.path === 'string' ? entry.path : undefined;
      const location = typeof entry.location === 'number' ? entry.location : undefined;
      return {
        present: true,
        fromCarriedFolder:
          location === UNPACKED_LOCATION &&
          !!entryPath &&
          path.resolve(entryPath) === path.resolve(folder),
        ...(entryPath ? { path: entryPath } : {}),
        ...(location !== undefined ? { location } : {}),
        ...(typeof entry.manifest?.version === 'string' ? { version: entry.manifest.version } : {}),
      };
    } catch {
      // An unreadable file says nothing; the page is checked anyway.
    }
  }
  return { present: false, fromCarriedFolder: false };
}

interface Match {
  readonly nodeId: string;
  readonly query: number;
  readonly role: string;
  readonly title: string;
  readonly description: string;
  readonly domId: string;
  readonly value: string;
  readonly text: string;
}

class Stop extends Error {
  constructor(
    readonly reason: InstallStopReason,
    message: string,
  ) {
    super(message);
  }
}

export async function installChromeExtension(
  carried: CarriedExtension,
  input: InstallInput,
  deps: InstallDeps,
): Promise<ChromeInstallResult> {
  const steps: InstallStep[] = [];
  const folder = carried.folder;
  const base = {
    folder,
    ...(carried.extensionId ? { extensionId: carried.extensionId } : {}),
  };
  let chrome: ChromeInstallResult['chrome'];
  let existing: ExistingInstall | undefined;
  let chromePid = 0;
  let chromeFrontAtStart = false;

  const frontmost = async (): Promise<string> => {
    try {
      const apps = await deps.helper({ op: 'apps' });
      const front = (Array.isArray(apps['apps']) ? apps['apps'] : []).find(
        (app) => (app as Record<string, unknown>)['frontmost'] === true,
      ) as Record<string, unknown> | undefined;
      return front ? `${String(front['bundleId'])}#${String(front['pid'])}` : '';
    } catch {
      return '';
    }
  };
  const chromeCameForward = (): boolean =>
    !chromeFrontAtStart &&
    chromePid > 0 &&
    steps.some((step) => step.frontmostAfter.endsWith(`#${String(chromePid)}`));

  const step = async <T>(
    name: string,
    run: () => Promise<{ value: T; detail?: string }>,
  ): Promise<T> => {
    const started = deps.now();
    const before = await frontmost();
    try {
      const { value, detail } = await run();
      steps.push({
        step: name,
        ok: true,
        ...(detail ? { detail } : {}),
        frontmostBefore: before,
        frontmostAfter: await frontmost(),
        ms: deps.now() - started,
      });
      return value;
    } catch (error) {
      steps.push({
        step: name,
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
        frontmostBefore: before,
        frontmostAfter: await frontmost(),
        ms: deps.now() - started,
      });
      throw error;
    }
  };

  const call = async (request: AxHelperRequest): Promise<AxHelperResponse> => {
    const response = await deps.helper(request);
    if (!response.ok)
      throw new Stop('helper_failed', `${request.op}: ${response.error ?? 'failed'}`);
    return response;
  };
  const find = async (request: Omit<AxHelperRequest, 'op'>): Promise<Match[]> =>
    ((await call({ op: 'find', pid: chromePid, ...request }))['matches'] as Match[] | undefined) ??
    [];
  const press = async (nodeId: string, what: string): Promise<void> => {
    const response = await deps.helper({ op: 'press', pid: chromePid, nodeId });
    if (!response.ok)
      throw new Stop('helper_failed', `press ${what}: ${response.error ?? 'failed'}`);
  };
  const poll = async <T>(
    timeoutMs: number,
    probe: () => Promise<T | undefined>,
  ): Promise<T | undefined> => {
    const until = deps.now() + timeoutMs;
    for (;;) {
      const value = await probe();
      if (value !== undefined) return value;
      if (deps.now() >= until) return undefined;
      await deps.sleep(250);
    }
  };

  const finish = async (
    status: ChromeInstallResult['status'],
    stop?: Stop,
  ): Promise<ChromeInstallResult> => {
    let userBrowser: ChromeInstallResult['userBrowser'];
    try {
      const current = await deps.status();
      userBrowser = { ready: current.ready, reason: current.reason, detail: current.detail };
    } catch {
      userBrowser = undefined;
    }
    return {
      ok: !stop,
      status,
      ...(stop ? { reason: stop.reason, error: stop.message } : {}),
      ...base,
      ...(chrome ? { chrome } : {}),
      ...(existing ? { existing } : {}),
      steps,
      chromeCameForward: chromeCameForward(),
      ...(userBrowser ? { userBrowser } : {}),
    };
  };

  if (deps.platform !== 'darwin')
    return finish(
      'stopped',
      new Stop(
        'not_macos',
        'browser.chrome.install drives Chrome through macOS Accessibility; on this system load the folder by hand (browser.status setup).',
      ),
    );
  if (!folder || !carried.extensionId)
    return finish(
      'stopped',
      new Stop(
        'no_carried_folder',
        'This install of @marshal/browser carries no Chrome extension folder (or its id is unknown).',
      ),
    );

  // Set inside the steps' closures, read in finally.
  const cleanup: { restorePanel?: string; navigated: boolean } = { navigated: false };
  try {
    const appPath = input.appPath ?? CHROME_APP;
    const found = await step('find Chrome', async () => {
      const processes = await deps.processes();
      if (input.pid !== undefined) {
        const given = processes.find((process) => process.pid === input.pid);
        if (!given) throw new Stop('chrome_not_found', `No process with pid ${String(input.pid)}.`);
        return {
          value: { process: given, launched: false },
          detail: `pid ${String(given.pid)} (given)`,
        };
      }
      const running = personsChrome(processes, deps.homeDir, appPath);
      if (running)
        return {
          value: { process: running, launched: false },
          detail: `pid ${String(running.pid)}`,
        };
      if (input.dryRun)
        return { value: undefined, detail: 'not running; would start it in the background' };
      await deps.launch(appPath);
      const started = await poll(15_000, async () =>
        personsChrome(await deps.processes(), deps.homeDir, appPath),
      );
      if (!started) throw new Stop('chrome_did_not_start', `${appPath} did not start.`);
      return {
        value: { process: started, launched: true },
        detail: `started pid ${String(started.pid)} in the background`,
      };
    });

    if (found) {
      chromePid = found.process.pid;
      const userDataDir = userDataDirOf(found.process.args) ?? defaultUserDataDir(deps.homeDir);
      const profile = lastUsedProfile(userDataDir, deps.readFile);
      chrome = { pid: chromePid, launched: found.launched, userDataDir, profile };
      existing = existingInstall(
        path.join(userDataDir, profile),
        carried.extensionId,
        folder,
        deps.readFile,
      );
      chromeFrontAtStart = (await frontmost()).endsWith(`#${String(chromePid)}`);
    }

    if (input.dryRun) {
      steps.push({
        step: 'plan',
        ok: true,
        detail: existing?.fromCarriedFolder
          ? 'The carried folder is already loaded: only wait for it to connect.'
          : `Would navigate Chrome's front tab to chrome://extensions in the background, turn on Developer mode, ${existing?.present ? `remove the copy with the same id at ${existing.path ?? 'another location'}, ` : ''}Load unpacked ${folder}, wait for it to connect, and go Back to the page that was open.`,
        frontmostBefore: '',
        frontmostAfter: '',
        ms: 0,
      });
      return await finish('planned');
    }

    if (existing?.fromCarriedFolder) {
      const ready = await step('wait for connection', async () => {
        const status = await poll(input.connectTimeoutMs ?? 40_000, async () => {
          const current = await deps.status();
          return current.ready ? current : undefined;
        });
        return { value: !!status, detail: status ? status.detail : 'not connected yet' };
      });
      if (ready) return await finish('already_installed');
      // Loaded but not connecting (an old copy of the folder, or the switch is off): reload it on the page below.
    }

    const windowAddressBar = async (): Promise<Match | undefined> =>
      (
        await find({
          queries: [{ role: 'AXTextField', description: 'Address and search bar' }],
          skipRoles: SKIP_WEB,
          maxDepth: 14,
          limit: 1,
        })
      )[0];

    await step('navigate the front tab to chrome://extensions', async () => {
      const bar = await poll(10_000, windowAddressBar);
      if (!bar) throw new Stop('no_window', 'Chrome has no window with an address bar.');
      if (bar.value.startsWith('chrome://extensions'))
        return { value: undefined, detail: 'already on chrome://extensions' };
      // The value alone, no AXFocused write and no Cmd+L: Chrome's omnibox takes it and a Return posted to the pid
      // navigates the tab with Chrome left in the background. AXConfirm answers success and does nothing here.
      // A Return sent the moment the value applied was lost once in a just-started Chrome: settle, check, retry.
      // Committed is when the bar shows the address as Chrome displays a loaded one (no trailing slash); the page's
      // web tree can take seconds longer in a window that was never shown, so it is not waited for here (a retry's
      // Return would reload the page that is still building).
      const committed = async (): Promise<true | undefined> => {
        const now = await windowAddressBar();
        return now?.value.startsWith('chrome://extensions') && now.value !== EXTENSIONS_URL
          ? true
          : undefined;
      };
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        const current = (await windowAddressBar()) ?? bar;
        await call({
          op: 'setValue',
          pid: chromePid,
          nodeId: current.nodeId,
          text: EXTENSIONS_URL,
        });
        const set = await poll(1_500, async () => {
          const read = await call({ op: 'read', nodeId: current.nodeId });
          return String(read['value']).startsWith('chrome://extensions') ? true : undefined;
        });
        if (!set) continue;
        await deps.sleep(300);
        await call({ op: 'keys', pid: chromePid, keys: [{ name: 'return' }] });
        cleanup.navigated = true;
        if (await poll(3_000, committed)) {
          const from = bar.value ? `from ${bar.value}` : 'from an empty tab';
          return {
            value: undefined,
            detail: attempt > 1 ? `${from}, attempt ${String(attempt)}` : from,
          };
        }
      }
      throw new Stop('page_did_not_load', 'The address bar did not take chrome://extensions.');
    });

    const page = await step('load chrome://extensions', async () => {
      const area = await poll(30_000, async () => {
        const areas = await find({
          queries: [{ role: 'AXWebArea', title: 'Extensions' }],
          skipRoles: SKIP_WEB,
          maxDepth: 14,
          limit: 1,
        });
        if (!areas[0]) return undefined;
        const ready = await find({
          within: areas[0].nodeId,
          queries: [{ domId: 'devMode' }],
          maxDepth: 24,
          limit: 1,
        });
        return ready[0] ? areas[0] : undefined;
      });
      if (!area)
        throw new Stop(
          'page_did_not_load',
          "chrome://extensions did not load in Chrome's front tab.",
        );
      return { value: area };
    });

    await step('Developer mode', async () => {
      const toggle = (
        await find({ within: page.nodeId, queries: [{ domId: 'devMode' }], maxDepth: 24, limit: 1 })
      )[0];
      if (!toggle) throw new Stop('page_did_not_load', 'No Developer mode switch on the page.');
      if (toggle.value === '1') return { value: undefined, detail: 'already on' };
      await press(toggle.nodeId, 'Developer mode');
      const on = await poll(4_000, async () => {
        const read = await call({ op: 'read', nodeId: toggle.nodeId });
        return read['value'] === '1' ? true : undefined;
      });
      if (!on)
        throw new Stop(
          'developer_mode_blocked',
          'Developer mode did not turn on: a policy for this Chrome profile (DeveloperToolsAvailability / ExtensionDeveloperModeSettings) may block it.',
        );
      return { value: undefined, detail: 'turned on' };
    });

    const cards = async (): Promise<{ id: string; remove?: string; reload?: string }[]> => {
      const matches = await find({
        within: page.nodeId,
        queries: [
          { domId: 'extension-id' },
          { domId: 'removeButton' },
          { domId: 'dev-reload-button' },
        ],
        maxDepth: 30,
      });
      const out: { id: string; remove?: string; reload?: string }[] = [];
      for (const match of matches) {
        if (match.query === 0) out.push({ id: /[a-p]{32}/.exec(match.text)?.[0] ?? '' });
        else if (out.length > 0) {
          const last = out[out.length - 1];
          if (last && match.query === 1 && !last.remove) last.remove = match.nodeId;
          if (last && match.query === 2 && !last.reload) last.reload = match.nodeId;
        }
      }
      return out;
    };

    if (existing?.fromCarriedFolder) {
      await step('reload the loaded copy', async () => {
        const card = (await cards()).find((entry) => entry.id === carried.extensionId);
        if (!card?.reload) return { value: undefined, detail: 'no Reload button on its card' };
        await press(card.reload, 'Reload');
        return { value: undefined };
      });
    } else {
      const sameId = (await cards()).find((entry) => entry.id === carried.extensionId);
      if (sameId) {
        await step('remove the other copy with the same id', async () => {
          if (!sameId.remove) throw new Stop('remove_failed', 'Its card has no Remove button.');
          await press(sameId.remove, 'Remove');
          const confirm = await poll(
            5_000,
            async () =>
              (
                await find({
                  queries: [{ role: 'AXButton', title: 'Remove' }],
                  skipRoles: SKIP_WEB,
                  maxDepth: 12,
                  limit: 1,
                })
              )[0],
          );
          if (!confirm) throw new Stop('remove_failed', "Chrome's Remove dialog did not appear.");
          await press(confirm.nodeId, 'Remove (dialog)');
          const gone = await poll(5_000, async () =>
            (await cards()).some((entry) => entry.id === carried.extensionId) ? undefined : true,
          );
          if (!gone)
            throw new Stop('remove_failed', 'The other copy is still listed after Remove.');
          return { value: undefined, detail: existing?.path ? `was ${existing.path}` : undefined };
        });
      }

      const sheet = await step('open Load unpacked at the carried folder', async () => {
        cleanup.restorePanel = await deps.panelDefault('get', '');
        await deps.panelDefault('set', folder);
        const button = (
          await find({
            within: page.nodeId,
            queries: [{ domId: 'loadUnpacked' }],
            maxDepth: 24,
            limit: 1,
          })
        )[0];
        if (!button)
          throw new Stop('open_panel_failed', 'No Load unpacked button (Developer mode off?).');
        await press(button.nodeId, 'Load unpacked');
        const panel = await poll(8_000, async () => {
          const found = await find({
            queries: [{ role: 'AXSheet' }],
            skipRoles: SKIP_WEB,
            maxDepth: 2,
            limit: 1,
          });
          if (!found[0]) return undefined;
          const controls = await find({
            within: found[0].nodeId,
            queries: [
              { role: 'AXPopUpButton', title: 'Where:' },
              { role: 'AXButton', title: 'Select' },
            ],
            skipRoles: SKIP_PANEL_LISTS,
            maxDepth: 4,
          });
          const where = controls.find((match) => match.query === 0);
          const select = controls.find((match) => match.query === 1);
          return where && select ? { where, select } : undefined;
        });
        if (!panel) throw new Stop('open_panel_failed', 'The folder panel did not open.');
        if (panel.where.value !== path.basename(folder)) {
          const cancel = (
            await find({
              queries: [{ role: 'AXButton', title: 'Cancel' }],
              skipRoles: SKIP_PANEL_LISTS,
              maxDepth: 4,
              limit: 1,
            })
          )[0];
          if (cancel) await press(cancel.nodeId, 'Cancel');
          throw new Stop(
            'open_panel_elsewhere',
            `The folder panel opened at "${panel.where.value}", not ${folder}.`,
          );
        }
        return { value: panel, detail: `Where: ${panel.where.value}` };
      });

      await step('Select', async () => {
        await press(sheet.select.nodeId, 'Select');
        const loaded = await poll(10_000, async () =>
          (await cards()).some((entry) => entry.id === carried.extensionId) ? true : undefined,
        );
        if (!loaded)
          throw new Stop(
            'not_loaded',
            'chrome://extensions does not list the extension after Load unpacked (a load error dialog may be open in Chrome).',
          );
        return { value: undefined, detail: `listed as ${String(carried.extensionId)}` };
      });
    }

    await step('wait for connection', async () => {
      const status = await poll(input.connectTimeoutMs ?? 40_000, async () => {
        const current = await deps.status();
        return current.ready ? current : undefined;
      });
      if (!status)
        throw new Stop(
          'not_connected',
          'The extension is loaded but has not reached this Marshal yet (its switch "Let Marley use this browser" may be off).',
        );
      return { value: status, detail: status.detail };
    });
    return await finish(existing?.fromCarriedFolder ? 'already_installed' : 'installed');
  } catch (error) {
    if (error instanceof Stop) return await finish('stopped', error);
    return await finish(
      'stopped',
      new Stop('helper_failed', error instanceof Error ? error.message : String(error)),
    );
  } finally {
    if (cleanup.restorePanel !== undefined)
      await deps.panelDefault('restore', cleanup.restorePanel).catch(() => '');
    if (cleanup.navigated && chromePid > 0) await goBack(deps, chromePid).catch(() => undefined);
  }
}

/**
 * Presses the toolbar's Back button (AXPress, Chrome stays in the background), only while the front tab is still on
 * chrome://extensions: the person's page comes back. Cmd+W is not used, it would close their tab.
 */
async function goBack(deps: InstallDeps, pid: number): Promise<void> {
  const response = await deps.helper({
    op: 'find',
    pid,
    queries: [
      { role: 'AXTextField', description: 'Address and search bar' },
      { role: 'AXButton', title: 'Back' },
    ],
    skipRoles: SKIP_WEB,
    maxDepth: 14,
    limit: 4,
  });
  const matches = (response['matches'] as Match[] | undefined) ?? [];
  const bar = matches.find((match) => match.query === 0);
  const back = matches.find((match) => match.query === 1);
  if (bar?.value.startsWith('chrome://extensions') && back)
    await deps.helper({ op: 'press', pid, nodeId: back.nodeId });
}

// ---------- real dependencies ----------

const run = (file: string, args: readonly string[]): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile(
      file,
      [...args],
      { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
      (error, stdout) => {
        if (error) reject(new Error(`${file}: ${error.message}`));
        else resolve(stdout);
      },
    );
  });

/** A JXA script: reads, sets (as a bookmark of a folder) or restores a data default of another app's domain. */
const PANEL_SCRIPT = `ObjC.import('Foundation');
function run(argv) {
  const [mode, domain, key, arg] = argv;
  const defaults = $.NSUserDefaults.alloc.initWithSuiteName(domain);
  if (mode === 'get') { const data = defaults.dataForKey(key); return data.isNil() ? '' : ObjC.unwrap(data.base64EncodedStringWithOptions(0)); }
  if (mode === 'restore') {
    if (arg) defaults.setObjectForKey($.NSData.alloc.initWithBase64EncodedStringOptions(arg, 0), key);
    else defaults.removeObjectForKey(key);
    defaults.synchronize;
    return 'ok';
  }
  const data = $.NSURL.fileURLWithPathIsDirectory(arg, true).bookmarkDataWithOptionsIncludingResourceValuesForKeysRelativeToURLError(0, $(), $(), $());
  if (data.isNil()) throw new Error('no bookmark for ' + arg);
  defaults.setObjectForKey(data, key);
  defaults.synchronize;
  return 'ok';
}`;

export function realInstallDeps(
  helper: InstallDeps['helper'],
  status: InstallDeps['status'],
): InstallDeps {
  return {
    helper,
    status,
    processes: async () =>
      (await run('/bin/ps', ['-axww', '-o', 'pid=,args=']))
        .split('\n')
        .map((line) => /^\s*(\d+)\s+(.*)$/.exec(line))
        .filter((match): match is RegExpExecArray => match !== null)
        .map((match) => ({ pid: Number(match[1]), args: match[2] ?? '' })),
    launch: async (appPath) => {
      await run('/usr/bin/open', ['-g', '-n', '-a', appPath]);
    },
    readFile: (file) => (existsSync(file) ? readFileSync(file, 'utf8') : undefined),
    panelDefault: async (mode, value) =>
      (
        await run('/usr/bin/osascript', [
          '-l',
          'JavaScript',
          '-e',
          PANEL_SCRIPT,
          mode,
          CHROME_BUNDLE,
          PANEL_DEFAULT,
          value,
        ])
      ).trim(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
    homeDir: os.homedir(),
    platform: process.platform,
  };
}
