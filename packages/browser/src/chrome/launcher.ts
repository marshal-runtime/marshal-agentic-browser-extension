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
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
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
}

export const DEAD_PROXY = 'http://127.0.0.1:9';

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
  const fromEnv = env['MARSHAL_BROWSER_CHROME'];
  if (fromEnv && existsSync(fromEnv)) return { path: fromEnv, source: 'env' };
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

  constructor(private readonly options: LauncherOptions = {}) {}

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
    const headed = kind === 'lasting' && isHeaded(this.options);
    let userDataDir: string;
    let temporary = false;
    if (kind === 'lasting') {
      userDataDir = path.join(
        this.options.profileRoot ?? path.join(os.homedir(), '.marshal', 'browser', 'profiles'),
        'agent',
      );
      await mkdir(userDataDir, { recursive: true });
    } else {
      userDataDir = await mkdtemp(path.join(os.tmpdir(), 'marshal-browser-'));
      temporary = true;
    }
    const args = [
      '--remote-debugging-pipe',
      `--user-data-dir=${userDataDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-sync',
      '--disable-features=Translate,MediaRouter,OptimizationHints',
      '--password-store=basic',
      '--use-mock-keychain',
      '--window-size=1280,800',
      ...(headed ? [] : ['--headless=new', '--hide-scrollbars', '--mute-audio']),
      'about:blank',
    ];
    const child = spawn(found.path, args, { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-4000);
    });
    const exited = new Promise<number | null>((resolve) => {
      child.once('exit', (code) => {
        resolve(code);
      });
    });
    const connection = new CdpConnection(child.stdio[3] as Writable, child.stdio[4] as Readable);
    const close = async (): Promise<void> => {
      await shutdown(child, connection, exited);
      if (temporary) await rm(userDataDir, { recursive: true, force: true }).catch(() => undefined);
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
