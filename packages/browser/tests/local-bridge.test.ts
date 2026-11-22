/**
 * The bridge socket carried in @marshal/browser (src/user/local-bridge.ts): a raw WebSocket client that sets its own Origin
 * plays the Marley Chrome extension, so every guard is checked at the socket, not only in a helper.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import http from 'node:http';
import { createServer, type AddressInfo, type Socket } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BridgeError } from '../src/user/bridge.js';
import { createLocalBridgeClient, LocalBridge, portHolder } from '../src/user/local-bridge.js';
import { userBrowserStatus } from '../src/user/status.js';

const ORIGIN = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';

/** A free loopback port (bound and released). */
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

interface Client {
  readonly socket: Socket;
  readonly messages: Record<string, unknown>[];
  send(message: Record<string, unknown>): void;
  next(
    predicate: (message: Record<string, unknown>) => boolean,
    timeoutMs?: number,
  ): Promise<Record<string, unknown>>;
  closed: Promise<void>;
}

/** Opens a WebSocket (masked client frames, as a browser sends) with the given Origin; rejects with the HTTP status if refused. */
function connect(
  port: number,
  origin: string | undefined,
  pathName = '/bridge',
  host = '127.0.0.1',
): Promise<Client> {
  return new Promise((resolve, reject) => {
    const request = http.request({
      agent: false,
      host,
      port,
      path: pathName,
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': randomBytes(16).toString('base64'),
        ...(origin ? { Origin: origin } : {}),
      },
    });
    request.on('response', (response) => {
      reject(new Error(`refused ${String(response.statusCode)}`));
      response.resume();
    });
    request.on('error', (error) => reject(error));
    request.on('upgrade', (_response, socket: Socket) => {
      const messages: Record<string, unknown>[] = [];
      const listeners = new Set<() => void>();
      let buffer = Buffer.alloc(0);
      let closedResolve: () => void = () => undefined;
      const closed = new Promise<void>((done) => (closedResolve = done));
      socket.on('close', () => closedResolve());
      socket.on('data', (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk]);
        for (;;) {
          if (buffer.length < 2) return;
          const opcode = (buffer[0] ?? 0) & 0x0f;
          let length = (buffer[1] ?? 0) & 0x7f;
          let offset = 2;
          if (length === 126) {
            if (buffer.length < 4) return;
            length = buffer.readUInt16BE(2);
            offset = 4;
          } else if (length === 127) {
            if (buffer.length < 10) return;
            length = Number(buffer.readBigUInt64BE(2));
            offset = 10;
          }
          if (buffer.length < offset + length) return;
          const payload = buffer.subarray(offset, offset + length);
          buffer = buffer.subarray(offset + length);
          if (opcode === 0x1) {
            messages.push(JSON.parse(payload.toString('utf8')) as Record<string, unknown>);
            for (const listener of listeners) listener();
          }
        }
      });
      const client: Client = {
        socket,
        messages,
        closed,
        send(message) {
          const payload = Buffer.from(JSON.stringify(message));
          const mask = randomBytes(4);
          const header =
            payload.length < 126
              ? Buffer.from([0x81, 0x80 | payload.length])
              : Buffer.from([0x81, 0x80 | 126, payload.length >> 8, payload.length & 0xff]);
          const masked = Buffer.alloc(payload.length);
          for (let i = 0; i < payload.length; i++)
            masked[i] = (payload[i] ?? 0) ^ (mask[i & 3] ?? 0);
          socket.write(Buffer.concat([header, mask, masked]));
        },
        next(predicate, timeoutMs = 3000) {
          return new Promise((done, fail) => {
            const check = (): boolean => {
              const index = messages.findIndex(predicate);
              if (index === -1) return false;
              const [found] = messages.splice(index, 1);
              listeners.delete(listener);
              clearTimeout(timer);
              done(found as Record<string, unknown>);
              return true;
            };
            const listener = (): void => {
              check();
            };
            const timer = setTimeout(() => {
              listeners.delete(listener);
              fail(new Error('no matching message'));
            }, timeoutMs);
            listeners.add(listener);
            check();
          });
        },
      };
      resolve(client);
    });
    request.end();
  });
}

/** Plays the Chrome extension: says hello and answers each request with `answer`. */
async function fakeChrome(
  port: number,
  answer: (method: string, params: Record<string, unknown>) => Record<string, unknown>,
  hello: Record<string, unknown> = {
    extensionVersion: '0.5.0',
    capabilities: ['tabs', 'snapshot'],
  },
): Promise<Client & { requests: { method: string; params: Record<string, unknown> }[] }> {
  const client = await connect(port, ORIGIN);
  const requests: { method: string; params: Record<string, unknown> }[] = [];
  client.socket.on('data', () => {
    for (;;) {
      const index = client.messages.findIndex((message) => message['type'] === 'request');
      if (index === -1) return;
      const [message] = client.messages.splice(index, 1) as [Record<string, unknown>];
      const method = String(message['method']);
      const params = message['params'] as Record<string, unknown>;
      requests.push({ method, params });
      client.send({ type: 'response', id: message['id'], ...answer(method, params) });
    }
  });
  client.send({ type: 'hello', ...hello });
  return Object.assign(client, { requests });
}

const bridges: LocalBridge[] = [];
const extra: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const bridge of bridges.splice(0)) await bridge.stop();
  for (const cleanup of extra.splice(0)) await cleanup();
});

async function started(
  port = 0,
  options: ConstructorParameters<typeof LocalBridge>[1] = {},
): Promise<LocalBridge> {
  const bridge = new LocalBridge(port, options);
  bridges.push(bridge);
  await bridge.start();
  return bridge;
}

async function until(check: () => unknown, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('condition not met');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('carried bridge socket: who may connect', () => {
  it('listens on 127.0.0.1 at /bridge and answers /health as marshal-browser', async () => {
    const bridge = await started();
    const status = bridge.status();
    expect(status).toMatchObject({ listening: true, connected: false });
    expect(status.url).toBe(`ws://127.0.0.1:${String(status.port)}/bridge`);
    expect(await portHolder(status.port)).toBe('marshal-browser');
  });

  it('refuses any Origin that is not chrome-extension:// (a web page, none, a lookalike) with 403', async () => {
    const { port } = (await started()).status();
    for (const origin of [
      'https://evil.example',
      'http://127.0.0.1:3000',
      undefined,
      'null',
      'moz-extension://abc',
      'xchrome-extension://abc',
    ])
      await expect(connect(port, origin), String(origin)).rejects.toThrow(/refused 403/);
    await expect(connect(port, ORIGIN, '/other')).rejects.toThrow(/refused 403/);
  });

  it('is not reachable on another interface', async () => {
    const lan = Object.values(os.networkInterfaces())
      .flat()
      .find((entry) => entry && entry.family === 'IPv4' && !entry.internal);
    if (!lan) return; // no non-loopback interface on this machine
    const { port } = (await started()).status();
    await expect(connect(port, ORIGIN, '/bridge', lan.address)).rejects.toThrow(
      /ECONNREFUSED|EHOSTUNREACH|ENETUNREACH/,
    );
  });

  it('a connected socket counts only after hello; ping gets pong', async () => {
    const bridge = await started();
    const client = await connect(bridge.status().port, ORIGIN);
    await until(() => bridge.status().browser !== null);
    expect(bridge.status().connected).toBe(false);
    client.send({ type: 'ping' });
    expect((await client.next((message) => message['type'] === 'pong'))['type']).toBe('pong');
    client.send({ type: 'hello', extensionVersion: '0.5.0', capabilities: [] });
    await until(() => bridge.status().connected);
    expect(bridge.status().browser).toMatchObject({
      origin: ORIGIN,
      hello: { extensionVersion: '0.5.0' },
    });
    expect((await userBrowserStatus(createLocalBridgeClient(bridge))).reason).toBe('paired');
  });

  it('the newest browser wins: the older connection is closed and its pending request fails as not_connected', async () => {
    const bridge = await started();
    const port = bridge.status().port;
    const first = await connect(port, ORIGIN);
    first.send({ type: 'hello', extensionVersion: 'old' });
    await until(() => bridge.status().connected);
    const pending = bridge.request('tabs.list', {}).catch((error: unknown) => error);
    await first.next((message) => message['type'] === 'request');
    const second = await fakeChrome(port, () => ({ ok: true, result: { tabs: [] } }), {
      extensionVersion: 'new',
    });
    await first.closed;
    expect(await pending).toMatchObject({ code: 'not_connected' });
    await until(() => bridge.status().browser?.hello?.extensionVersion === 'new');
    expect(await bridge.request('tabs.list', {})).toEqual({ tabs: [] });
    expect(second.requests).toHaveLength(1);
  });

  it('drops a browser silent past the idle limit', async () => {
    const bridge = await started(0, { idleTimeoutMs: 200 });
    const client = await connect(bridge.status().port, ORIGIN);
    client.send({ type: 'hello', extensionVersion: '0.5.0' });
    await until(() => bridge.status().connected);
    await client.closed;
    await until(() => !bridge.status().connected);
  });
});

describe('carried bridge client: the browserbridge.* names the user backend calls', () => {
  it('round trip: tabs.open reaches the browser with its params and the answer comes back', async () => {
    const bridge = await started();
    const chrome = await fakeChrome(bridge.status().port, (method, params) => ({
      ok: true,
      result: { method, tab: { id: 7, url: params['url'] } },
    }));
    await until(() => bridge.status().connected);
    const client = createLocalBridgeClient(bridge);
    expect(
      await client.call('browserbridge.tabs.open', {
        url: 'https://example.com/',
        background: true,
      }),
    ).toEqual({
      method: 'tabs.open',
      tab: { id: 7, url: 'https://example.com/' },
    });
    expect(chrome.requests).toEqual([
      { method: 'tabs.open', params: { url: 'https://example.com/', background: true } },
    ]);
  });

  it("the browser's error codes become typed BridgeError codes", async () => {
    const bridge = await started();
    // The codes chrome-extension/background.js sends (codeError) and the bridge's own.
    const codes: Record<string, string> = {
      'stale-ref': 'stale_ref',
      'tab-not-found': 'no_tab',
      'tab-not-in-group': 'no_tab',
      'browser-off': 'not_connected',
      'page-error': 'failed',
      'debugger-refused': 'failed',
    };
    const queue = Object.keys(codes);
    await fakeChrome(bridge.status().port, () => ({
      ok: false,
      error: { code: queue.shift(), message: 'nope' },
    }));
    await until(() => bridge.status().connected);
    const client = createLocalBridgeClient(bridge);
    for (const [bridgeCode, code] of Object.entries(codes)) {
      const error = await client
        .call('browserbridge.click', { tabId: 1, ref: 'e1' })
        .catch((caught: unknown) => caught);
      expect(error, bridgeCode).toBeInstanceOf(BridgeError);
      expect(error, bridgeCode).toMatchObject({ code, bridgeCode });
    }
  });

  it('a screenshot is written to a private 0600 file in a 0700 folder; no image data in the answer', async () => {
    const bridge = await started();
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
    await fakeChrome(bridge.status().port, () => ({
      ok: true,
      result: { data: png.toString('base64'), url: 'https://a/' },
    }));
    await until(() => bridge.status().connected);
    const directory = path.join(mkdtempSync(path.join(os.tmpdir(), 'mb-shots-')), 'user-shots');
    const result = await createLocalBridgeClient(bridge, directory).call<Record<string, unknown>>(
      'browserbridge.screenshot',
      {
        tabId: 3,
      },
    );
    expect(Object.keys(result).sort()).toEqual(['path', 'url']);
    const file = String(result['path']);
    expect(path.dirname(file)).toBe(directory);
    expect(readFileSync(file).equals(png)).toBe(true);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(directory).mode & 0o777).toBe(0o700);
  });

  it('evaluate and any other name are unsupported and never reach the browser', async () => {
    const bridge = await started();
    const chrome = await fakeChrome(bridge.status().port, () => ({ ok: true, result: {} }));
    await until(() => bridge.status().connected);
    const client = createLocalBridgeClient(bridge);
    for (const name of [
      'browserbridge.evaluate',
      'browserbridge.tabs.update',
      'browser.session.evaluate',
    ])
      await expect(client.call(name, { tabId: 1, expression: '1' })).rejects.toMatchObject({
        code: 'unsupported',
      });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(chrome.requests).toEqual([]);
  });

  it('tabs.open / navigate refuse non-http addresses and a non-integer tabId before reaching the browser', async () => {
    const bridge = await started();
    const chrome = await fakeChrome(bridge.status().port, () => ({ ok: true, result: {} }));
    await until(() => bridge.status().connected);
    const client = createLocalBridgeClient(bridge);
    for (const url of [
      'javascript:alert(1)',
      'file:///etc/passwd',
      'chrome://settings',
      'data:text/html,x',
      ' https://a',
    ])
      for (const name of ['browserbridge.tabs.open', 'browserbridge.tabs.navigate'])
        await expect(client.call(name, { tabId: 1, url }), `${name} ${url}`).rejects.toMatchObject({
          code: 'failed',
          bridgeCode: 'invalid-request',
        });
    await expect(
      client.call('browserbridge.click', { tabId: '1; drop', ref: 'e1' }),
    ).rejects.toMatchObject({
      bridgeCode: 'invalid-request',
    });
    await expect(client.call('browserbridge.tabs.open', { url: 'back' })).rejects.toMatchObject({
      bridgeCode: 'invalid-request',
    });
    expect(chrome.requests).toEqual([]);
    await client.call('browserbridge.tabs.navigate', { tabId: 1, url: 'back' });
    await client.call('browserbridge.tabs.navigate', { tabId: 1, url: 'HTTPS://example.com/' });
    await until(() => chrome.requests.length === 2);
  });

  it('with no browser, a call fails as not_connected and status says not_connected with the carried setup', async () => {
    const bridge = await started();
    const client = createLocalBridgeClient(bridge);
    await expect(client.call('browserbridge.tabs.list', {})).rejects.toMatchObject({
      code: 'not_connected',
    });
    const status = await userBrowserStatus(client);
    expect(status.reason).toBe('not_connected');
    expect(status.setup?.chromeExtension.bridgeAddress).toBe(bridge.status().url);
    expect(status.setup?.steps.join('\n')).toContain(bridge.status().url);
    const folder = status.setup?.chromeExtension.folder;
    expect(
      folder && path.isAbsolute(folder) && existsSync(path.join(folder, 'manifest.json')),
    ).toBe(true);
  });
});

describe('carried bridge: when the port is taken there is one typed answer, never a second path', () => {
  it('held by the old @zygstinct/browser-bridge: port_in_use names it and its steps say to remove it', async () => {
    const port = await freePort();
    const old = http.createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: true, service: 'marley-browser-bridge' }));
    });
    await new Promise<void>((resolve) => old.listen(port, '127.0.0.1', resolve));
    extra.push(() => new Promise<void>((resolve) => old.close(() => resolve())));
    const bridge = await started(port);
    expect(bridge.status()).toMatchObject({
      listening: false,
      port,
      bindError: { code: 'port_in_use', holder: 'browser-bridge-extension' },
    });
    const status = await userBrowserStatus(createLocalBridgeClient(bridge));
    expect(status).toMatchObject({ ready: false, reason: 'port_in_use' });
    expect(status.setup?.summary).toContain('Nothing is routed through the other holder');
    expect(status.setup?.steps[0]).toContain('@zygstinct/browser-bridge');
    // Requests fail as not_connected; nothing is sent to the holder.
    await expect(
      createLocalBridgeClient(bridge).call('browserbridge.tabs.list', {}),
    ).rejects.toMatchObject({
      code: 'not_connected',
    });
  });

  it('held by another @marshal/browser: port_in_use with holder marshal-browser', async () => {
    const first = await started();
    const second = await started(first.status().port);
    expect(second.status().bindError).toMatchObject({
      code: 'port_in_use',
      holder: 'marshal-browser',
    });
    expect((await userBrowserStatus(createLocalBridgeClient(second))).setup?.steps[0]).toMatch(
      /Close the other Marshal/,
    );
  });

  it('held by an unknown program: holder other, with the lsof step', async () => {
    const port = await freePort();
    const other = createServer((socket) => socket.destroy());
    await new Promise<void>((resolve) => other.listen(port, '127.0.0.1', resolve));
    extra.push(() => new Promise<void>((resolve) => other.close(() => resolve())));
    const bridge = await started(port);
    expect(bridge.status().bindError).toMatchObject({ code: 'port_in_use', holder: 'other' });
    expect((await userBrowserStatus(createLocalBridgeClient(bridge))).setup?.steps[0]).toContain(
      `lsof -nP -iTCP:${String(port)}`,
    );
  });

  it('takes the port by itself once the holder goes (on the next status), and a browser then pairs', async () => {
    const first = await started();
    const port = first.status().port;
    const second = await started(port, { rebindEveryMs: 0 });
    const client = createLocalBridgeClient(second);
    expect((await userBrowserStatus(client)).reason).toBe('port_in_use');
    await first.stop();
    const status = await userBrowserStatus(client);
    expect(status.reason).toBe('not_connected');
    expect(second.status()).toMatchObject({ listening: true, port });
    expect(second.status().bindError).toBeUndefined();
    await fakeChrome(port, () => ({ ok: true, result: {} }));
    expect((await userBrowserStatus(createLocalBridgeClient(second))).reason).toBe('not_connected');
    await until(() => second.status().connected);
    expect((await userBrowserStatus(client)).reason).toBe('paired');
  });

  it('does not retry the bind more often than the rebind interval', async () => {
    const first = await started();
    const second = await started(first.status().port, { rebindEveryMs: 60_000 });
    await first.stop();
    await second.ensureListening();
    expect(second.status().listening).toBe(false);
  });
});
