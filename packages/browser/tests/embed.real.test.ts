/**
 * The launcher options an embedding host sets, with a real Chrome: a worker slot's own lasting profile under the
 * host's folder, throwaway profiles under the host's short temp folder, the host's prepareLaunch environment (and
 * headed choice) reaching Chrome, and the sandbox switch. Skipped, with a notice, when no Chrome is installed.
 */
import { existsSync, readdirSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ChromeLauncher, findChrome, TEMP_PREFIX } from '../src/chrome/launcher.js';
import { ManagedTab } from '../src/chrome/tab.js';
import { activateEmbedded } from '../src/extension.js';
import type { CapabilityProvider } from '../src/contracts.js';

const chrome = findChrome();
if (!chrome.path) console.warn(`[embed.real] SKIPPED: ${chrome.reason}`);

const roots: string[] = [];
const launchers: ChromeLauncher[] = [];
afterAll(async () => {
  await Promise.all(launchers.map((launcher) => launcher.closeAll()));
  await Promise.all(
    roots.map((root) => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })),
  );
});

async function root(): Promise<string> {
  const made = await mkdtemp(path.join(os.tmpdir(), 'mbe-'));
  roots.push(made);
  return made;
}

describe.skipIf(!chrome.path)('embedding options with a real Chrome', () => {
  it("a worker slot's lasting profile lives at <profileRoot>/agent-<slot>; no shared agent profile is made", async () => {
    const profiles = await root();
    const launcher = new ChromeLauncher({
      profileRoot: profiles,
      profileSlot: 'wslot000001',
      headed: false,
    });
    launchers.push(launcher);
    const process = await launcher.processFor('agent');
    expect(process.headed).toBe(false);
    expect(existsSync(path.join(profiles, 'agent-wslot000001', 'Default'))).toBe(true);
    expect(existsSync(path.join(profiles, 'agent'))).toBe(false);
    // A second slot runs beside it (Chrome refuses two browsers on one profile).
    const other = new ChromeLauncher({
      profileRoot: profiles,
      profileSlot: 'wslot000002',
      headed: false,
    });
    launchers.push(other);
    const second = await other.processFor('agent');
    expect(second.connection.closed).toBe(false);
    expect(process.connection.closed).toBe(false);
  });

  it('throwaway profiles are made under tempRoot and removed on close', async () => {
    const temp = path.join(await root(), 't');
    const launcher = new ChromeLauncher({ tempRoot: temp });
    const tab = await ManagedTab.open(launcher, 'visitor');
    const made = readdirSync(temp).filter((name) => name.startsWith(TEMP_PREFIX));
    expect(made).toHaveLength(1);
    await tab.close();
    await launcher.closeAll();
    expect(readdirSync(temp).filter((name) => name.startsWith(TEMP_PREFIX))).toHaveLength(0);
  });

  it("prepareLaunch's environment reaches Chrome (DISPLAY/XAUTHORITY only from it) and its headed:false wins", async () => {
    const seen: { kind: string; headed: boolean }[] = [];
    const launcher = new ChromeLauncher(
      { profileRoot: await root(), headed: true },
      ({ kind, headed }) => {
        seen.push({ kind, headed });
        return Promise.resolve({ env: { TZ: 'Pacific/Auckland' }, headed: false });
      },
    );
    launchers.push(launcher);
    const tab = await ManagedTab.open(launcher, 'agent');
    // Chrome's own clock zone shows the environment it got.
    expect(await tab.evaluate('return Intl.DateTimeFormat().resolvedOptions().timeZone')).toBe(
      'Pacific/Auckland',
    );
    expect((await launcher.processFor('agent')).headed).toBe(false);
    expect(seen).toEqual([{ kind: 'lasting', headed: true }]);
    await tab.close();
  });

  it('chromeSandbox:false still starts (the flag is accepted) and an embedded visitor task page loads', async () => {
    const activation = await activateEmbedded({
      decide: () =>
        Promise.resolve({
          success: false,
          code: 'JEV_UNAVAILABLE',
          error: 'no model in this test',
        }),
      configuration: {
        chromeSandbox: false,
        tempRoot: path.join(await root(), 't'),
        artifactDir: await root(),
      },
    });
    const provider = activation.capabilityProviders?.[0] as CapabilityProvider;
    const context = { principal: { id: 'test', kind: 'agent' } };
    const opened = (
      await provider.invoke(
        'browser.session.open',
        { url: 'data:text/html,<title>embedded</title><p>hi</p>' },
        context,
      )
    ).output as Record<string, unknown>;
    expect(opened['ok']).toBe(true);
    const read = (
      await provider.invoke('browser.session.snapshot', { sessionId: opened['sessionId'] }, context)
    ).output as Record<string, unknown>;
    expect(read['title']).toBe('embedded');
    await provider.invoke('browser.session.close', { sessionId: opened['sessionId'] }, context);
    await activation.dispose?.();
  });
});
