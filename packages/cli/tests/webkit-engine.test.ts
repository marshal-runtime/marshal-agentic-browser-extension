/**
 * Live integration test for the webkit engine: drives the built CLI
 * end-to-end (setup → navigate → screenshot → guards → shutdown) against
 * a real Playwright WebKit.
 *
 * Skipped automatically when the CLI dist or the WebKit browser build is
 * missing (e.g. bare CI checkout). Run `npm run build:cli` and
 * `npx playwright install webkit` to enable.
 */

import { describe, it, expect, afterAll } from 'vitest';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const CLI = join(here, '..', 'dist', 'index.js');
const PORT = '9455';

let webkitAvailable = false;
try {
  const { webkit } = await import('playwright');
  webkitAvailable = existsSync(webkit.executablePath());
} catch {
  webkitAvailable = false;
}

const runnable = existsSync(CLI) && webkitAvailable;
const workDir = mkdtempSync(join(tmpdir(), 'ab-webkit-test-'));

interface CliResult {
  success: boolean;
  [key: string]: unknown;
}

function cli(args: string[], cwd?: string): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [CLI, ...args],
      {
        cwd: cwd ?? here,
        timeout: 90_000,
        // Isolate CLI state so tests never touch ~/.agentic-browser
        env: { ...process.env, AGENTIC_BROWSER_CONFIG_DIR: join(workDir, 'config') },
      },
      (_error, stdout) => {
        try {
          resolve(JSON.parse(stdout) as CliResult);
        } catch {
          reject(new Error(`CLI produced no JSON: ${stdout}`));
        }
      },
    );
  });
}

describe.skipIf(!runnable)('webkit engine (live)', () => {
  afterAll(async () => {
    await cli(['shutdown', '--port', PORT]).catch(() => undefined);
    rmSync(workDir, { recursive: true, force: true });
  });

  it('runs the core loop: setup → navigate → screenshot → shutdown', async () => {
    const setup = await cli(['setup', '--browser', 'safari', '--headless', '--port', PORT]);
    expect(setup.success).toBe(true);
    expect(setup['engine']).toBe('webkit');
    expect(String(setup['note'])).toMatch(/NOT your installed Safari/);

    const nav = await cli(['navigate', 'https://example.com', '--port', PORT]);
    expect(nav.success).toBe(true);
    expect(nav['title']).toBe('Example Domain');

    const shot = await cli(['screenshot', '--output', 'webkit-test.png', '--port', PORT], workDir);
    expect(shot.success).toBe(true);
    expect(existsSync(join(workDir, 'webkit-test.png'))).toBe(true);

    const exec = await cli(['execute', 'navigator.userAgent', '--port', PORT]);
    expect(exec.success).toBe(true);
    expect(String(exec['result'])).toContain('AppleWebKit');
  }, 120_000);

  it('fails CDP-only surface area with clear errors', async () => {
    const targets = await cli(['list-targets', '--port', PORT]);
    expect(targets.success).toBe(false);
    expect(String(targets['error'])).toMatch(/not supported on the webkit engine/);

    const withTarget = await cli(['execute', '1+1', '--target', 'ABC123', '--port', PORT]);
    expect(withTarget.success).toBe(false);
    expect(String(withTarget['error'])).toMatch(/--target/);

    const expose = await cli(['setup', '--browser', 'webkit', '--expose', '--port', PORT]);
    expect(expose.success).toBe(false);
    expect(String(expose['error'])).toMatch(/--expose/);
  }, 60_000);

  it('shuts down cleanly and reports disconnected status', async () => {
    const down = await cli(['shutdown', '--port', PORT]);
    expect(down.success).toBe(true);

    // Daemon exit is asynchronous; poll briefly
    let connected = true;
    for (let i = 0; i < 20 && connected; i++) {
      await new Promise((r) => setTimeout(r, 250));
      const status = await cli(['status', '--port', PORT]);
      connected = status['connected'] === true;
    }
    expect(connected).toBe(false);
  }, 30_000);
});

describe.skipIf(runnable)('webkit engine (live) — environment missing', () => {
  it('is skipped: build the CLI and run `npx playwright install webkit`', () => {
    expect(runnable).toBe(false);
  });
});
