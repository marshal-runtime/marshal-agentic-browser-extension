// A throwaway Chrome for Testing profile that loads the Chrome extension carried in this package, and the person's
// one setup step done the way they do it: open the extension's popup and enter the bridge address in "Developer:
// Marshal bridge". Only a Chrome for Testing binary is accepted, never the person's own Chrome, and the profile is a
// fresh temporary folder that is deleted on close. Used by tests/user.real.test.ts and scripts/prove-user-carried.mjs.
import { Buffer } from 'node:buffer';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { setTimeout } from 'node:timers';

const TESTING = /Chrome for Testing|chrome-linux/;

/** MB_CHROME_FOR_TESTING, else a Playwright-cached Chrome for Testing; never a Chrome the person uses. */
export function chromeForTesting() {
  const given = process.env['MB_CHROME_FOR_TESTING'];
  const candidates = given ? [given] : [];
  const cache = path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright');
  if (existsSync(cache))
    for (const entry of readdirSync(cache)
      .filter((name) => /^chromium-\d+$/.test(name))
      .sort()
      .reverse())
      for (const platform of ['chrome-mac-arm64', 'chrome-mac'])
        candidates.push(
          path.join(
            cache,
            entry,
            platform,
            'Google Chrome for Testing.app',
            'Contents',
            'MacOS',
            'Google Chrome for Testing',
          ),
        );
  return candidates.find((candidate) => existsSync(candidate) && TESTING.test(candidate));
}

/** Chrome's id for an extension whose manifest has a `key`: sha256 of the key, first 32 hex digits as a-p. */
export function extensionId(folder) {
  const { key } = JSON.parse(readFileSync(path.join(folder, 'manifest.json'), 'utf8'));
  return createHash('sha256')
    .update(Buffer.from(key, 'base64'))
    .digest('hex')
    .slice(0, 32)
    .replace(/[0-9a-f]/g, (digit) => String.fromCharCode(97 + parseInt(digit, 16)));
}

function openCdp(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const pending = new Map();
    let nextId = 1;
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id === undefined) return;
      const entry = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) entry?.reject(new Error(message.error.message));
      else entry?.resolve(message.result);
    });
    socket.addEventListener('open', () => {
      resolve({
        send(method, params = {}, sessionId) {
          const id = nextId++;
          return new Promise((done, fail) => {
            pending.set(id, { resolve: done, reject: fail });
            socket.send(
              JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }),
            );
          });
        },
        close() {
          socket.close();
        },
      });
    });
    socket.addEventListener('error', () => {
      reject(new Error(`cannot reach ${url}`));
    });
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Starts Chrome for Testing, headless, in a new temporary profile with `folder` loaded unpacked (and nothing else). */
export async function launchThrowawayChrome(binary, folder) {
  if (!TESTING.test(binary)) throw new Error(`${binary} is not Chrome for Testing`);
  const profile = mkdtempSync(path.join(os.tmpdir(), 'mb-cft-profile-'));
  const child = spawn(
    binary,
    [
      '--headless=new',
      `--user-data-dir=${profile}`,
      '--remote-debugging-port=0',
      `--load-extension=${folder}`,
      `--disable-extensions-except=${folder}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--use-mock-keychain',
      '--password-store=basic',
      'about:blank',
    ],
    { stdio: 'ignore' },
  );
  const portFile = path.join(profile, 'DevToolsActivePort');
  const deadline = Date.now() + 20_000;
  while (!existsSync(portFile) || readFileSync(portFile, 'utf8').split('\n').length < 2) {
    if (Date.now() > deadline || child.exitCode !== null)
      throw new Error('Chrome for Testing did not start');
    await sleep(100);
  }
  const [port, browserPath] = readFileSync(portFile, 'utf8').split('\n');
  const cdp = await openCdp(`ws://127.0.0.1:${port}${browserPath}`);
  const id = extensionId(folder);
  return {
    process: child,
    profile,
    extensionId: id,
    /** The ids Chrome itself assigned to running extension service workers ({id, url}), read from Chrome, not computed. */
    async loadedExtensionIds() {
      const until = Date.now() + 10_000;
      for (;;) {
        const { targetInfos } = await cdp.send('Target.getTargets');
        const ids = [
          ...new Map(
            targetInfos
              .filter(
                (target) =>
                  target.type === 'service_worker' && target.url.startsWith('chrome-extension://'),
              )
              .map((target) => [target.url, { id: new URL(target.url).host, url: target.url }]),
          ).values(),
        ];
        if (ids.length || Date.now() > until) return ids;
        await sleep(100);
      }
    },
    /** What the person does in the popup: enter the address in "Developer: Marshal bridge" (an input `change`). */
    async setBridgeAddress(address) {
      const { targetId } = await cdp.send('Target.createTarget', {
        url: `chrome-extension://${id}/popup.html`,
        background: true,
      });
      const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
      const evaluate = async (expression) =>
        (
          await cdp.send(
            'Runtime.evaluate',
            { expression, awaitPromise: true, returnByValue: true },
            sessionId,
          )
        ).result.value;
      const until = Date.now() + 10_000;
      while ((await evaluate('Boolean(document.getElementById("bridgeUrl"))')) !== true) {
        if (Date.now() > until) throw new Error('the popup did not load');
        await sleep(100);
      }
      await evaluate(
        `(() => { const input = document.getElementById("bridgeUrl"); input.focus(); input.value = ${JSON.stringify(address)}; input.dispatchEvent(new Event("change")); input.blur(); })()`,
      );
      while (
        (await evaluate('chrome.storage.local.get("bridgeUrl").then((s) => s.bridgeUrl)')) !==
        address
      ) {
        if (Date.now() > until) throw new Error('the popup did not store the address');
        await sleep(100);
      }
      await cdp.send('Target.closeTarget', { targetId });
    },
    async close() {
      cdp.close();
      child.kill();
      if (child.exitCode === null) await new Promise((resolve) => child.once('exit', resolve));
      rmSync(profile, { recursive: true, force: true });
    },
  };
}
