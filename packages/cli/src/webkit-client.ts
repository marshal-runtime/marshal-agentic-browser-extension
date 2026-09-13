/**
 * Client side of the webkit engine: launches the daemon (see webkit-daemon.ts)
 * and forwards CLI commands to it over localhost HTTP.
 */

import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, openSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { saveConfig, getConfigDir } from './config.js';
import { shutdownBrowser } from './launcher.js';
import {
  WEBKIT_UNSUPPORTED,
  WEBKIT_TARGET_FLAG_ERROR,
  WEBKIT_EXPOSE_ERROR,
  WEBKIT_HOST_ERROR,
} from './engine.js';

interface CmdResult {
  success: boolean;
  [key: string]: unknown;
}

const fail = (error: string): CmdResult => ({ success: false, error });

// ---------------------------------------------------------------------------
// Daemon discovery / lifecycle
// ---------------------------------------------------------------------------

interface DaemonStatus {
  success: boolean;
  engine?: string;
  ready?: boolean;
  browserVersion?: string;
  headless?: boolean;
  pages?: number;
  pid?: number;
}

async function getDaemonStatus(port: number): Promise<DaemonStatus | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${String(port)}/status`);
    if (!res.ok) return null;
    const status = (await res.json()) as DaemonStatus;
    return status.engine === 'webkit' ? status : null;
  } catch {
    return null;
  }
}

async function isPortOccupied(port: number): Promise<boolean> {
  try {
    await fetch(`http://127.0.0.1:${String(port)}/status`);
    return true;
  } catch {
    return false;
  }
}

/** Ensure the Playwright WebKit browser build is downloaded. */
async function ensureWebkitInstalled(): Promise<void> {
  // Lazy import keeps playwright out of the hot path for cdp users.
  const { webkit } = await import('playwright');
  const executable = webkit.executablePath();
  if (existsSync(executable)) return;
  process.stderr.write('Playwright WebKit build not found — downloading (one-time, ~80 MB)...\n');
  execFileSync('npx', ['playwright', 'install', 'webkit'], {
    stdio: ['ignore', 2, 2],
    timeout: 600_000,
  });
}

export interface WebkitLaunchOptions {
  port: number;
  headless: boolean;
}

export async function launchWebkitDaemon(options: WebkitLaunchOptions): Promise<CmdResult> {
  const { port, headless } = options;

  // Reuse a daemon already running on this port; refuse a foreign occupant.
  const existing = await getDaemonStatus(port);
  if (existing) {
    saveConfig({ port, host: '127.0.0.1', browser: 'webkit', engine: 'webkit' });
    return {
      success: true,
      browser: 'webkit',
      engine: 'webkit',
      port,
      browserVersion: existing.browserVersion,
      profile: 'ephemeral',
      message: `WebKit engine already running on port ${String(port)}, reusing it`,
      note: 'Playwright WebKit — NOT your installed Safari. Fresh profile: no Safari cookies, logins, or extensions.',
    };
  }
  if (await isPortOccupied(port)) {
    return fail(
      `Port ${String(port)} is in use by something that is not the WebKit engine (possibly a CDP browser). ` +
        'Shut it down first or pick another port with --port.',
    );
  }

  await ensureWebkitInstalled();

  const logDir = getConfigDir();
  mkdirSync(logDir, { recursive: true });
  const logFile = join(logDir, 'webkit-daemon.log');
  const logFd = openSync(logFile, 'a');

  const daemonPath = join(dirname(fileURLToPath(import.meta.url)), 'webkit-daemon.js');
  const args = [daemonPath, '--port', String(port)];
  if (headless) args.push('--headless');

  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: ['ignore', logFd, logFd],
  });
  child.unref();

  // Wait for the daemon to come up (WebKit cold start can take a few seconds)
  const maxWait = 30_000;
  const start = Date.now();
  while (Date.now() - start < maxWait) {
    const status = await getDaemonStatus(port);
    if (status?.ready) {
      saveConfig({ port, host: '127.0.0.1', browser: 'webkit', engine: 'webkit' });
      return {
        success: true,
        browser: 'webkit',
        engine: 'webkit',
        port,
        headless,
        browserVersion: status.browserVersion,
        profile: 'ephemeral',
        message: `WebKit is ready on port ${String(port)}`,
        note: 'Playwright WebKit — NOT your installed Safari. Fresh profile: no Safari cookies, logins, or extensions.',
      };
    }
    await new Promise((r) => setTimeout(r, 250));
  }

  return fail(`WebKit engine did not start within ${String(maxWait)}ms. See log: ${logFile}`);
}

// ---------------------------------------------------------------------------
// Command forwarding
// ---------------------------------------------------------------------------

export interface WebkitCommandInput {
  port: number;
  host: string;
  values: Record<string, string | boolean | undefined>;
  positionals: string[];
}

export async function runWebkitCommand(
  command: string,
  input: WebkitCommandInput,
): Promise<CmdResult> {
  const { port, host, values, positionals } = input;

  // Honest guards for CDP-only surface area
  if (host !== '127.0.0.1' && host !== 'localhost') return fail(WEBKIT_HOST_ERROR);
  if (values['expose'] === true) return fail(WEBKIT_EXPOSE_ERROR);
  if (typeof values['target'] === 'string') return fail(WEBKIT_TARGET_FLAG_ERROR);
  const unsupported = WEBKIT_UNSUPPORTED[command];
  if (unsupported) return fail(unsupported);

  switch (command) {
    case 'setup': {
      if (typeof values['profile'] === 'string') {
        return fail(
          '--profile is not supported on the webkit engine: it always uses a fresh ephemeral profile (Playwright WebKit has no access to your Safari or Chrome profiles).',
        );
      }
      return launchWebkitDaemon({ port, headless: values['headless'] === true });
    }

    case 'status': {
      const status = await getDaemonStatus(port);
      if (status) {
        return {
          success: true,
          connected: true,
          engine: 'webkit',
          host: '127.0.0.1',
          port,
          browserVersion: status.browserVersion,
          headless: status.headless,
          pages: status.pages,
        };
      }
      return {
        success: true,
        connected: false,
        message: `No WebKit engine at 127.0.0.1:${String(port)}`,
      };
    }

    case 'shutdown': {
      try {
        await fetch(`http://127.0.0.1:${String(port)}/shutdown`, { method: 'POST' });
      } catch {
        // Daemon may already be gone or unresponsive — fall through to port kill
        shutdownBrowser(port);
      }
      return { success: true, message: 'WebKit engine stopped' };
    }

    default: {
      const status = await getDaemonStatus(port);
      if (!status) {
        return fail(
          `No WebKit engine on port ${String(port)}. Run \`agentic-browser setup --browser webkit\` first.`,
        );
      }
      try {
        const res = await fetch(`http://127.0.0.1:${String(port)}/command`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ command, values, positionals, cwd: process.cwd() }),
        });
        return (await res.json()) as CmdResult;
      } catch (error: unknown) {
        return fail(
          `WebKit engine request failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }
}
