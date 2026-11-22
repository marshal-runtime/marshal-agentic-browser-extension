/**
 * The one launcher for every Chrome this extension starts. Two processes at most, started on first use:
 *   - `lasting`: the `agent` profile's own user-data-dir (cookies and logins persist between sessions). Headless unless
 *     `headed` is configured or, on Linux, a DISPLAY exists (a brand VM's per-chat Xvfb). On a Mac it never pops a
 *     window in front of the person unless asked.
 *   - `ephemeral`: a throwaway user-data-dir, always headless, holding one isolated browser context per session:
 *       `visitor`: a fresh context (no cookies, no storage, no extensions), and nothing intercepts its requests: this
 *                  code never enables Fetch or request interception (zygstinct rule SB21);
 *       `offline`: a fresh context whose every request, loopback included, goes to a dead proxy, for pages we render.
 * Chrome is driven over --remote-debugging-pipe (cdp.ts): no debugging port is opened.
 *
 * Hardening (review G, 2026-11-22):
 *   - ephemeral: WebRTC may not use UDP outside the proxy (profile preference `webrtc.ip_handling_policy`), so an offline page cannot reach a
 *     STUN server and a visitor page cannot learn the machine's public address; no component updates and no background
 *     networking (they grew a throwaway profile to 122 MB);
 *   - lasting: the agent's user-data-dir is 0700, and on macOS its cookies are encrypted with the system keychain
 *     (the mock keychain's fixed key let anyone who could read the folder use the agent's logins);
 *   - a temporary user-data-dir is removed on close, on process exit (`exit` hook), and, when a host died before either,
 *     by the next launcher (`sweepStaleProfiles`: a `marshal-browser-XXXXXX` folder whose Chrome is gone).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, readdirSync, readlinkSync, rmSync, statSync } from 'fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { CdpConnection } from './cdp.js';
import type { ManagedProfile } from '../target.js';

export interface LauncherOptions {
  /** Absolute path of a Chrome or Chromium binary; found automatically when absent. */
  readonly chromePath?: string;
  /** Where the lasting `agent` profile lives; default ~/.marshal/browser/profiles. */
  readonly profileRoot?: string;
  /** Show the `agent` browser's window. */
  readonly headed?: boolean;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly platform?: NodeJS.Platform;
  /** The process's user id (tests); default `process.getuid()`. */
  readonly uid?: number;
  /**
   * A worker slot's own lasting profile: `<profileRoot>/agent-<slot>` instead of `<profileRoot>/agent` (Chrome refuses a
   * second browser on one profile, so concurrent workers of one host each name their slot). Letters, digits, `_`, `-`.
   */
  readonly profileSlot?: string;
  /** Parent folder of the throwaway (visitor / offline) profiles; default os.tmpdir(). Keep it short: Chrome's sockets live there. */
  readonly tempRoot?: string;
  /** Chrome's own sandbox (default true). False adds --no-sandbox, for a host whose service limits forbid it. */
  readonly chromeSandbox?: boolean;
}

/**
 * An embedding host's hook before each Chrome start (an embedded host only; never from configuration): it may start a
 * display and return the environment Chrome gets (DISPLAY and XAUTHORITY are taken only from here, never inherited) and
 * whether the lasting browser shows its window.
 */
export type PrepareLaunch = (start: {
  readonly kind: 'lasting' | 'ephemeral';
  readonly headed: boolean;
}) => Promise<
  | {
      readonly env?: Readonly<Record<string, string>>;
      readonly headed?: boolean;
    }
  | null
  | undefined
>;

const SLOT = /^[A-Za-z0-9_-]{1,64}$/;

/** The lasting profile's folder for these options; throws on a slot that is not a plain name. */
export function agentProfileDir(options: LauncherOptions): string {
  const root = options.profileRoot ?? path.join(os.homedir(), '.marshal', 'browser', 'profiles');
  if (options.profileSlot === undefined) return path.join(root, 'agent');
  if (!SLOT.test(options.profileSlot))
    throw new Error('BROWSER_BAD_CONFIGURATION: profileSlot must be 1-64 letters, digits, _ or -');
  return path.join(root, `agent-${options.profileSlot}`);
}

export const DEAD_PROXY = 'http://127.0.0.1:9';

/** mkdtemp's prefix; the sweep only ever touches `<prefix><6 characters>`. */
export const TEMP_PREFIX = 'marshal-browser-';
const TEMP_NAME = /^marshal-browser-[A-Za-z0-9]{6}$/;
/** A temporary profile with no Chrome lock is left alone this long (another launcher may be starting into it). */
const STALE_UNLOCKED_MS = 10 * 60_000;

/** Chrome's command line for one process kind (pure, so tests read the exact flags). */
export function chromeArgs(
  kind: 'lasting' | 'ephemeral',
  userDataDir: string,
  headed: boolean,
  platform: NodeJS.Platform = process.platform,
  uid: number | undefined = process.getuid?.(),
  sandbox = true,
): string[] {
  return [
    '--remote-debugging-pipe',
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-sync',
    '--disable-features=Translate,MediaRouter,OptimizationHints',
    // The agent's logins are kept by the system keychain on macOS. A throwaway profile, and Linux hosts (a brand VM
    // has no keyring daemon), keep the basic store.
    ...(kind === 'lasting' && platform === 'darwin'
      ? []
      : ['--password-store=basic', '--use-mock-keychain']),
    ...(kind === 'ephemeral'
      ? ['--disable-component-update', '--disable-background-networking']
      : []),
    '--window-size=1280,800',
    // Linux containers (Page Studio's Coder builds) give /dev/shm 64 MB, and Chrome died mid-capture there; and Chrome
    // refuses to start as root without --no-sandbox. Same rule as Page Studio's old launcher (main 833836a,
    // src/extension/browser.ts:27-29): Linux only, and --no-sandbox only for root.
    ...(platform === 'linux' ? ['--disable-dev-shm-usage'] : []),
    ...((platform === 'linux' && uid === 0) || !sandbox ? ['--no-sandbox'] : []),
    // --disable-gpu-compositing: a GPU-composited capture taller than 16,384 device px (Chrome's largest texture) repeats
    // the top of the page past that row. Software compositing keeps hardware WebGL, which --disable-gpu would remove.
    ...(headed
      ? []
      : ['--headless=new', '--hide-scrollbars', '--mute-audio', '--disable-gpu-compositing']),
    'about:blank',
  ];
}

/**
 * Profile preferences of a throwaway Chrome, written before it starts. WebRTC sends no UDP that bypasses the proxy:
 * Chrome 158 ignores the old --force-webrtc-ip-handling-policy switch (a STUN server still saw the machine's public
 * address), and the browser contexts of visitor and offline sessions inherit this profile's preferences.
 */
export const EPHEMERAL_PREFERENCES = {
  webrtc: {
    ip_handling_policy: 'disable_non_proxied_udp',
    multiple_routes_enabled: false,
    nonproxied_udp_enabled: false,
  },
} as const;

async function writeEphemeralPreferences(userDataDir: string): Promise<void> {
  await mkdir(path.join(userDataDir, 'Default'), { recursive: true, mode: 0o700 });
  await writeFile(
    path.join(userDataDir, 'Default', 'Preferences'),
    JSON.stringify(EPHEMERAL_PREFERENCES),
    { mode: 0o600 },
  );
}

/** Creates the agent profile folder private to this user, and makes an existing one private. */
export async function prepareAgentDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  if ((statSync(dir).mode & 0o777) !== 0o700) chmodSync(dir, 0o700);
}

/** Pid of the Chrome that holds a user-data-dir (its `SingletonLock` link reads `<host>-<pid>`), or null. */
function lockPid(dir: string): number | null {
  try {
    const target = readlinkSync(path.join(dir, 'SingletonLock'));
    const pid = Number(target.slice(target.lastIndexOf('-') + 1));
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

const pidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
};

/** Temporary profiles this process owns, removed synchronously if it exits before closing them. */
const LIVE_TEMP_DIRS = new Set<string>();
const LIVE_CHILDREN = new Set<ChildProcess>();
let exitHookInstalled = false;

/**
 * Removes temporary profiles a dead host left behind: `marshal-browser-XXXXXX` folders owned by this user whose Chrome
 * lock names a process that is gone, or that have no lock and were not touched for 10 minutes. Returns what it removed.
 */
export function sweepStaleProfiles(
  root: string = os.tmpdir(),
  alive: (pid: number) => boolean = pidAlive,
  now: number = Date.now(),
): string[] {
  const removed: string[] = [];
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return removed;
  }
  for (const name of names) {
    if (!TEMP_NAME.test(name)) continue;
    const dir = path.join(root, name);
    if (LIVE_TEMP_DIRS.has(dir)) continue;
    try {
      const info = lstatSync(dir);
      if (!info.isDirectory() || (process.getuid && info.uid !== process.getuid())) continue;
      const pid = lockPid(dir);
      const stale = pid === null ? now - info.mtimeMs > STALE_UNLOCKED_MS : !alive(pid);
      if (!stale) continue;
      rmSync(dir, { recursive: true, force: true });
      removed.push(dir);
    } catch {
      // gone already, or not ours to remove
    }
  }
  return removed;
}

/** What the `exit` hook does: kill this process's Chromes and remove its temporary profiles (exported for tests). */
export function cleanupOnExit(): void {
  for (const child of LIVE_CHILDREN) {
    try {
      if (child.exitCode === null) child.kill('SIGKILL');
    } catch {
      // already gone
    }
  }
  // Chrome's helper processes outlive the killed browser by a moment and can write into the folder while it is being
  // removed, so try again (synchronously, at most ~1 s in all) until it is gone. The next start's sweep is the backstop.
  const pause = new Int32Array(new SharedArrayBuffer(4));
  for (const dir of LIVE_TEMP_DIRS) {
    for (let attempt = 0; attempt < 10 && existsSync(dir); attempt += 1) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // retried below
      }
      if (existsSync(dir)) Atomics.wait(pause, 0, 0, 100);
    }
  }
}

/** The temporary profiles the exit hook would remove now (for tests). */
export const liveTempDirs = (): readonly string[] => [...LIVE_TEMP_DIRS];

function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.once('exit', cleanupOnExit);
}

const CANDIDATES: Readonly<Record<string, readonly string[]>> = {
  darwin: [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
  ],
  linux: [
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome',
    '/opt/google/chrome/chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ],
};

export interface ChromeFound {
  readonly path: string | null;
  readonly source: 'config' | 'env' | 'search' | 'none';
  readonly reason?: string;
}

export function findChrome(options: LauncherOptions = {}): ChromeFound {
  if (options.chromePath) {
    return existsSync(options.chromePath)
      ? { path: options.chromePath, source: 'config' }
      : {
          path: null,
          source: 'none',
          reason: `configured chromePath ${options.chromePath} does not exist`,
        };
  }
  const env = options.env ?? process.env;
  // MARSHAL_SDK_CHROME is the Chrome a marshal-sdk host found for its own "browser" port.
  for (const name of ['MARSHAL_BROWSER_CHROME', 'MARSHAL_SDK_CHROME']) {
    const fromEnv = env[name];
    if (fromEnv && existsSync(fromEnv)) return { path: fromEnv, source: 'env' };
  }
  for (const candidate of CANDIDATES[options.platform ?? process.platform] ?? []) {
    if (existsSync(candidate)) return { path: candidate, source: 'search' };
  }
  return {
    path: null,
    source: 'none',
    reason:
      'no Chrome or Chromium found; install Google Chrome or set the chromePath configuration',
  };
}

export function isHeaded(options: LauncherOptions): boolean {
  if (options.headed !== undefined) return options.headed;
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  return platform === 'linux' && Boolean(env['DISPLAY']);
}

export interface ChromeProcess {
  readonly kind: 'lasting' | 'ephemeral';
  readonly connection: CdpConnection;
  readonly userAgent: string;
  readonly version: string;
  readonly headed: boolean;
  close(): Promise<void>;
}

export class ChromeLauncher {
  private lasting: Promise<ChromeProcess> | null = null;
  private ephemeral: Promise<ChromeProcess> | null = null;

  constructor(
    private readonly options: LauncherOptions = {},
    private readonly prepare?: PrepareLaunch,
  ) {}

  /** The process that serves `profile`, started on first use and restarted if it died. */
  async processFor(profile: ManagedProfile): Promise<ChromeProcess> {
    const slot = profile === 'agent' ? 'lasting' : 'ephemeral';
    const current = this[slot];
    // Set synchronously, so two first calls at once share one start instead of racing two Chromes.
    if (!current) return (this[slot] = this.start(slot));
    if (await this.alive(current)) return current;
    if (this[slot] === current) this[slot] = this.start(slot);
    return this[slot] as Promise<ChromeProcess>;
  }

  async closeAll(): Promise<void> {
    const all = [this.lasting, this.ephemeral];
    this.lasting = null;
    this.ephemeral = null;
    await Promise.all(
      all.map(async (process) => {
        if (!process) return;
        try {
          await (await process).close();
        } catch {
          // a process that never started has nothing to close
        }
      }),
    );
  }

  private async alive(process: Promise<ChromeProcess> | null): Promise<boolean> {
    if (!process) return false;
    try {
      return !(await process).connection.closed;
    } catch {
      return false;
    }
  }

  private async start(kind: 'lasting' | 'ephemeral'): Promise<ChromeProcess> {
    const found = findChrome(this.options);
    if (!found.path) throw new Error(`BROWSER_UNAVAILABLE: ${found.reason ?? 'no Chrome'}`);
    let headed = kind === 'lasting' && isHeaded(this.options);
    let childEnv: NodeJS.ProcessEnv | undefined;
    if (this.prepare) {
      const prepared = await this.prepare({ kind, headed });
      // The host owns the display: an inherited DISPLAY may name an X server that died with the host's last stop.
      childEnv = { ...process.env };
      delete childEnv['DISPLAY'];
      delete childEnv['XAUTHORITY'];
      Object.assign(childEnv, prepared?.env ?? {});
      if (kind === 'lasting' && prepared?.headed !== undefined) headed = prepared.headed;
      if (headed && !childEnv['DISPLAY'] && (this.options.platform ?? process.platform) === 'linux')
        headed = false;
    }
    let userDataDir: string;
    let temporary = false;
    if (kind === 'lasting') {
      userDataDir = agentProfileDir(this.options);
      await prepareAgentDir(userDataDir);
    } else {
      const tempRoot = this.options.tempRoot ?? os.tmpdir();
      if (this.options.tempRoot !== undefined) {
        if (!path.isAbsolute(tempRoot))
          throw new Error('BROWSER_BAD_CONFIGURATION: tempRoot must be an absolute path');
        await mkdir(tempRoot, { recursive: true, mode: 0o700 });
      }
      sweepStaleProfiles(tempRoot);
      userDataDir = await mkdtemp(path.join(tempRoot, TEMP_PREFIX));
      temporary = true;
      LIVE_TEMP_DIRS.add(userDataDir);
      await writeEphemeralPreferences(userDataDir);
    }
    installExitHook();
    const args = chromeArgs(
      kind,
      userDataDir,
      headed,
      this.options.platform,
      this.options.uid ?? process.getuid?.(),
      this.options.chromeSandbox !== false,
    );
    const child = spawn(found.path, args, {
      stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'],
      ...(childEnv ? { env: childEnv } : {}),
    });
    LIVE_CHILDREN.add(child);
    let stderr = '';
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-4000);
    });
    const exited = new Promise<number | null>((resolve) => {
      child.once('exit', (code) => {
        LIVE_CHILDREN.delete(child);
        resolve(code);
      });
    });
    const connection = new CdpConnection(child.stdio[3] as Writable, child.stdio[4] as Readable);
    const close = async (): Promise<void> => {
      await shutdown(child, connection, exited);
      if (temporary) {
        await rm(userDataDir, { recursive: true, force: true }).catch(() => undefined);
        LIVE_TEMP_DIRS.delete(userDataDir);
      }
    };
    try {
      const version = await Promise.race([
        connection.send('Browser.getVersion', {}, undefined, 20_000),
        exited.then((code) => {
          throw new Error(`Chrome exited during start-up (code ${String(code)})`);
        }),
      ]);
      return {
        kind,
        connection,
        headed,
        userAgent: typeof version['userAgent'] === 'string' ? version['userAgent'] : '',
        version: typeof version['product'] === 'string' ? version['product'] : '',
        close,
      };
    } catch (error) {
      await close();
      const why = error instanceof Error ? error.message : String(error);
      const inUse =
        kind === 'lasting' && /exited/.test(why)
          ? ' (is another Chrome using the agent profile?)'
          : '';
      throw new Error(
        `BROWSER_START_FAILED: ${why}${inUse}${stderr ? `; stderr: ${stderr.slice(-600)}` : ''}`,
      );
    }
  }
}

async function shutdown(
  child: ChildProcess,
  connection: CdpConnection,
  exited: Promise<number | null>,
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (!connection.closed)
    await connection.send('Browser.close', {}, undefined, 3_000).catch(() => undefined);
  const done = await Promise.race([exited.then(() => true), sleep(3_000).then(() => false)]);
  if (!done) {
    child.kill('SIGKILL');
    await Promise.race([exited, sleep(2_000)]);
  }
}

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));
