// Proof that one install of @marshal/browser connects the person's Chrome: a clean marshal-sdk host with ONLY this
// package (no @zygstinct/browser-bridge, no other extension), and a throwaway Chrome for Testing profile that loads the
// folder browser.status names in its setup. The person's one step is done as they do it (the address in the popup).
// Then browser.status user is ready, and one on:"user" session opens a local page, snapshots it and closes.
// Never the person's own Chrome or profile; the bridge uses a free port unless --port is given.
//
//   node scripts/prove-user-carried.mjs --sdk <marshal-sdk dist/src/index.js> --package <symlink-free copy> --out <dir>
//   node scripts/prove-user-carried.mjs ... --port-in-use 17373   # also: a second host on a port the old bridge holds
import { log } from 'node:console';
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import http from 'node:http';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { setTimeout } from 'node:timers';
import { pathToFileURL } from 'node:url';
import { chromeForTesting, launchThrowawayChrome } from './carried-chrome.mjs';

function argument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function links(dir) {
  const found = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    const stat = lstatSync(full);
    if (stat.isSymbolicLink()) found.push(full);
    else if (stat.isDirectory()) found.push(...links(full));
  }
  return found;
}

async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

const sdk = argument('--sdk');
const packageRoot = realpathSync(path.resolve(argument('--package') ?? '.'));
const out = path.resolve(
  argument('--out') ?? mkdtempSync(path.join(os.tmpdir(), 'mb-prove-user-')),
);
const portInUse = argument('--port-in-use');
if (!sdk) throw new Error('--sdk <marshal-sdk dist/src/index.js> is required');
const chromeBinary = chromeForTesting();
if (!chromeBinary) throw new Error('no Chrome for Testing (set MB_CHROME_FOR_TESTING)');
const packageLinks = links(packageRoot).filter(
  (entry) => !entry.includes(`${path.sep}node_modules${path.sep}`),
);
if (packageLinks.length) throw new Error(`the package has links: ${packageLinks.join(', ')}`);
mkdirSync(out, { recursive: true });

const page = http.createServer((_request, response) => {
  response.writeHead(200, { 'content-type': 'text/html' });
  response.end(
    '<!doctype html><title>Carried bridge proof</title><h1>Hello from the fixture</h1><button>Continue</button>',
  );
});
await new Promise((resolve) => page.listen(0, '127.0.0.1', resolve));
const fixture = `http://127.0.0.1:${String(page.address().port)}/`;

const { createMarshalHost } = await import(pathToFileURL(path.resolve(sdk)).href);
const scratch = mkdtempSync(path.join(os.tmpdir(), 'mb-prove-host-'));
const hosts = [];
async function host(bridgePort) {
  const root = mkdtempSync(path.join(scratch, 'host-'));
  mkdirSync(path.join(root, 'ws'));
  const created = await createMarshalHost({
    workspacePath: path.join(root, 'ws'),
    stateRoot: path.join(root, 'state'),
    browser: false,
    repoRules: false,
    env: { PATH: process.env.PATH, HOME: process.env.HOME },
    extensions: [
      {
        packageRoot,
        configuration: {
          bridgePort,
          artifactDir: path.join(out, 'artifacts'),
          chromeExtensionDir: path.join(root, 'stable', 'chrome-extension'),
        },
      },
    ],
    log: () => undefined,
  });
  hosts.push(created);
  return created;
}
const userOf = (status) => status.backends.find((backend) => backend.name === 'user');

const record = { sdk, packageRoot, chrome: chromeBinary, fixture, steps: [] };
const step = (name, value) => {
  record.steps.push({ name, at: new Date().toISOString(), value });
  log(`${name}: ${JSON.stringify(value).slice(0, 400)}`);
};

let chrome;
try {
  const port = Number(argument('--port') ?? (await freePort()));
  const marshal = await host(port);
  // The host is given exactly one extension package: this one.
  step('extensions given to the host', [
    JSON.parse(readFileSync(path.join(packageRoot, 'runtime-extension.json'), 'utf8')).identity,
  ]);
  const before = userOf(await marshal.invoke('browser.status', {}));
  step('browser.status user before', before);
  if (before.reason !== 'not_connected')
    throw new Error(`expected not_connected, got ${before.reason}`);
  const folder = before.setup.chromeExtension.folder;
  // The folder setup names is the stable copy (it outlives the host's per-install folder), checked against the lock.
  if (
    !folder ||
    !path.isAbsolute(folder) ||
    !folder.endsWith(`${path.sep}stable${path.sep}chrome-extension`)
  )
    throw new Error(`setup folder ${String(folder)} is not the stable copy`);
  step(
    'stable folder matches the lock',
    JSON.parse(readFileSync(path.join(packageRoot, 'dist', 'chrome-extension.lock.json'), 'utf8'))
      .treeSha256,
  );

  chrome = await launchThrowawayChrome(chromeBinary, folder);
  step('throwaway Chrome for Testing', {
    profile: chrome.profile,
    extensionId: chrome.extensionId,
    folder,
  });
  await chrome.setBridgeAddress(before.setup.chromeExtension.bridgeAddress);
  step('popup: Developer: Marshal bridge set to', before.setup.chromeExtension.bridgeAddress);

  let after = userOf(await marshal.invoke('browser.status', { waitMs: 20_000 }));
  const deadline = Date.now() + 20_000;
  while (!after.ready && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    after = userOf(await marshal.invoke('browser.status', {}));
  }
  step('browser.status user after', after);
  if (!after.ready) throw new Error('the throwaway Chrome never paired');

  const opened = await marshal.invoke('browser.session.open', { on: 'user', url: fixture });
  step('browser.session.open on:user', opened);
  const snapshot = await marshal.invoke('browser.session.snapshot', {
    sessionId: opened.sessionId,
  });
  step('browser.session.snapshot', {
    title: snapshot.title,
    url: snapshot.url,
    elements: snapshot.elements,
    text: snapshot.text,
  });
  if (!String(snapshot.text ?? '').includes('Hello from the fixture'))
    throw new Error('the snapshot does not show the page');
  const closed = await marshal.invoke('browser.session.close', { sessionId: opened.sessionId });
  step('browser.session.close', closed);
  if (closed.closed !== true) throw new Error('the session did not close');

  if (portInUse) {
    const second = await host(Number(portInUse));
    step(
      `second host on port ${portInUse}: browser.status user`,
      userOf(await second.invoke('browser.status', {})),
    );
  }
  record.result = 'passed';
} catch (error) {
  record.result = 'failed';
  record.error = error instanceof Error ? error.stack : String(error);
  process.exitCode = 1;
} finally {
  for (const created of hosts) await created.dispose().catch(() => undefined);
  await chrome?.close();
  await new Promise((resolve) => page.close(resolve));
  rmSync(scratch, { recursive: true, force: true });
  writeFileSync(path.join(out, 'proof.json'), `${JSON.stringify(record, null, 2)}\n`);
  log(`${record.result}: ${path.join(out, 'proof.json')}`);
}
