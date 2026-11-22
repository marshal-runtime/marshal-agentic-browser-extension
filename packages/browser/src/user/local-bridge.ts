/**
 * The Marshal half of the person's-Chrome backend, carried in this package: the local socket the Marley Chrome extension
 * (developer install, `dist/chrome-extension`) connects to, and a `BridgeClient` over it. Ported from
 * zyg-edge/marley-browser-extension marshal-extension/src/bridge.js and capabilities.js (main 48cf63f), which the
 * separate `@zygstinct/browser-bridge` extension served before. Rules kept from there:
 *   - it listens on 127.0.0.1 only, at `/bridge`, and accepts only the carried extension's own origin
 *     (`chrome-extension://<id from its manifest key>`), never another installed extension;
 *   - the newest browser to connect wins, and one silent for 65 s is dropped (it pings every 20 s);
 *   - tabs.open / tabs.navigate take only http(s) addresses (or back / forward / reload).
 * There is no `evaluate` verb here: the user backend never runs page JavaScript in the person's Chrome.
 *
 * Only one process can hold the port. When it is taken (the old `@zygstinct/browser-bridge` extension, another Marshal
 * with this package, or anything else), the bridge reports `port_in_use` with what holds it and tries to bind again on
 * the next status; it never falls back to the old extension's capabilities, so there is one path to the person's Chrome.
 */
import { mkdirSync, writeFileSync } from 'fs';
import http from 'http';
import os from 'node:os';
import path from 'node:path';
import { BridgeError, codeOf, type BridgeClient, type BridgeStatus } from './bridge.js';
import type { CarriedExtension } from './status.js';
import { EXTENSION_ID } from './extension-id.js';
import { HEALTH_SERVICE, startWsServer, type WsConnection } from './ws-server.js';

export const BRIDGE_PORT = 17373;
const PATH = '/bridge';
const HOST = '127.0.0.1';
const REQUEST_TIMEOUT_MS = 30_000;
const IDLE_TIMEOUT_MS = 65_000;
const REBIND_EVERY_MS = 2_000;

export type BindError = NonNullable<BridgeStatus['bindError']>;
/** What holds the port when this bridge cannot: the old bridge extension, another `@marshal/browser`, or unknown. */
export type PortHolder = NonNullable<BindError['holder']>;

export interface LocalBridgeStatus extends BridgeStatus {
  readonly port: number;
}

interface Hello {
  readonly extensionVersion?: string;
  readonly capabilities?: readonly string[];
}

interface Pending {
  readonly resolve: (value: Record<string, unknown>) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly connection: WsConnection;
}

export class LocalBridge {
  private server: http.Server | null = null;
  private connection: WsConnection | null = null;
  private browser: { origin: string; connectedAt: string; hello: Hello | null } | null = null;
  private readonly pending = new Map<number, Pending>();
  private readonly waiters = new Set<() => void>();
  private nextId = 1;
  private bindError: BindError | undefined;
  private lastBindAt = 0;
  private binding: Promise<void> | null = null;
  private stopped = false;

  constructor(
    readonly port: number = BRIDGE_PORT,
    private readonly options: {
      readonly idleTimeoutMs?: number;
      readonly rebindEveryMs?: number;
      /**
       * The only Chrome extension allowed to connect: the carried Marley extension's fixed id (from its manifest key).
       * Without one, no browser can connect. Any other installed extension would otherwise win as the newest browser
       * and receive every request, typed values included.
       */
      readonly extensionId?: string;
    } = {},
  ) {}

  /** Binds the port; on failure records why (and what holds it) instead of throwing. */
  start(): Promise<void> {
    if (this.server || this.stopped) return Promise.resolve();
    this.binding ??= this.bind().finally(() => {
      this.binding = null;
    });
    return this.binding;
  }

  private async bind(): Promise<void> {
    this.lastBindAt = Date.now();
    try {
      this.server = await startWsServer({
        host: HOST,
        port: this.port,
        path: PATH,
        acceptOrigin: (origin) => {
          const id = this.options.extensionId;
          return id !== undefined && EXTENSION_ID.test(id) && origin === `chrome-extension://${id}`;
        },
        onConnection: (connection) => {
          this.attach(connection);
        },
      });
      this.bindError = undefined;
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      const message = error instanceof Error ? error.message : String(error);
      this.bindError =
        code === 'EADDRINUSE'
          ? { code: 'port_in_use', message, holder: await portHolder(this.port) }
          : { code: 'listen_failed', message };
    }
  }

  /** Tries to bind again (at most every 2 s) when the port was taken, e.g. after the old bridge extension was removed. */
  async ensureListening(): Promise<void> {
    if (this.server || this.stopped) return;
    if (this.binding) return this.binding;
    if (Date.now() - this.lastBindAt < (this.options.rebindEveryMs ?? REBIND_EVERY_MS)) return;
    await this.start();
  }

  private attach(connection: WsConnection): void {
    const previous = this.connection;
    this.connection = connection;
    this.browser = {
      origin: connection.origin,
      connectedAt: new Date().toISOString(),
      hello: null,
    };
    if (previous) previous.close(4000, 'replaced by a newer browser connection');
    const idleTimeoutMs = this.options.idleTimeoutMs ?? IDLE_TIMEOUT_MS;
    connection.socket.setKeepAlive(true, 10_000);
    const idleCheck = setInterval(
      () => {
        if (Date.now() - connection.lastSeen > idleTimeoutMs)
          connection.close(4001, 'no message from the browser');
      },
      Math.min(10_000, Math.max(50, Math.floor(idleTimeoutMs / 4))),
    );
    idleCheck.unref();
    connection.on('message', (text: string) => {
      connection.lastSeen = Date.now();
      this.onMessage(connection, text);
    });
    connection.on('close', () => {
      clearInterval(idleCheck);
      if (this.connection === connection) {
        this.connection = null;
        this.browser = null;
      }
      for (const [id, entry] of this.pending) {
        if (entry.connection !== connection) continue;
        clearTimeout(entry.timer);
        entry.reject(
          new BridgeError(
            'not_connected',
            'The browser disconnected before answering',
            'browser-disconnected',
          ),
        );
        this.pending.delete(id);
      }
    });
  }

  private onMessage(connection: WsConnection, text: string): void {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return;
    }
    if (message['type'] === 'ping') {
      connection.send(JSON.stringify({ type: 'pong', at: Date.now() }));
      return;
    }
    if (message['type'] === 'hello') {
      if (this.connection === connection && this.browser) this.browser.hello = message as Hello;
      for (const resolve of this.waiters) resolve();
      this.waiters.clear();
      return;
    }
    const id = message['id'];
    if (message['type'] !== 'response' || typeof id !== 'number') return;
    const entry = this.pending.get(id);
    if (entry?.connection !== connection) return;
    this.pending.delete(id);
    clearTimeout(entry.timer);
    if (message['ok'] === true) {
      entry.resolve((message['result'] ?? {}) as Record<string, unknown>);
      return;
    }
    const error = (message['error'] ?? {}) as { code?: unknown; message?: unknown };
    const bridgeCode = typeof error.code === 'string' ? error.code : 'browser-error';
    entry.reject(
      new BridgeError(
        codeOf(bridgeCode),
        typeof error.message === 'string' ? error.message : 'Browser error',
        bridgeCode,
      ),
    );
  }

  status(): LocalBridgeStatus {
    const address = this.server?.address();
    const port = address && typeof address === 'object' ? address.port : this.port;
    return {
      listening: this.server !== null,
      url: `ws://${HOST}:${String(port)}${PATH}`,
      port,
      connected: Boolean(this.connection && this.browser?.hello),
      browser: this.browser,
      ...(this.bindError ? { bindError: this.bindError, error: this.bindError.message } : {}),
    };
  }

  /** Waits up to `timeoutMs` for a browser that has said hello. */
  waitForBrowser(timeoutMs: number): Promise<boolean> {
    if (this.connection && this.browser?.hello) return Promise.resolve(true);
    return new Promise((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        this.waiters.delete(done);
        resolve(Boolean(this.connection && this.browser?.hello));
      };
      const timer = setTimeout(done, timeoutMs);
      this.waiters.add(done);
    });
  }

  request(
    method: string,
    params: Record<string, unknown>,
    timeoutMs = REQUEST_TIMEOUT_MS,
  ): Promise<Record<string, unknown>> {
    const connection = this.connection;
    if (!connection || !this.browser?.hello)
      return Promise.reject(
        new BridgeError(
          'not_connected',
          "No browser is connected: the Marley Chrome extension is not loaded, its bridge address is not set, or 'Let Marley use this browser' is off.",
          'browser-not-connected',
        ),
      );
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new BridgeError(
            'failed',
            `${method} did not answer within ${String(timeoutMs)} ms`,
            'browser-timeout',
          ),
        );
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, connection });
      connection.send(JSON.stringify({ type: 'request', id, method, params }));
    });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const resolve of this.waiters) resolve();
    this.waiters.clear();
    if (this.connection) this.connection.close(1001, 'bridge stopping');
    this.connection = null;
    const server = this.server;
    this.server = null;
    if (server)
      await new Promise<void>((resolve) =>
        server.close(() => {
          resolve();
        }),
      );
  }
}

/** Asks the holder of the port its `/health` (the old bridge answers `marley-browser-bridge`, this one `marshal-browser`). */
export function portHolder(port: number, timeoutMs = 1000): Promise<PortHolder> {
  return new Promise((resolve) => {
    const request = http.get(
      { host: HOST, port, path: '/health', timeout: timeoutMs, agent: false },
      (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => {
          if (body.length < 4096) body += chunk;
        });
        response.on('end', () => {
          let service: unknown;
          try {
            service = (JSON.parse(body) as { service?: unknown }).service;
          } catch {
            service = undefined;
          }
          resolve(
            service === 'marley-browser-bridge'
              ? 'browser-bridge-extension'
              : service === HEALTH_SERVICE
                ? 'marshal-browser'
                : 'other',
          );
        });
      },
    );
    request.on('timeout', () => request.destroy());
    request.on('error', () => {
      resolve('other');
    });
  });
}

/** Verb, and its time limit, for each `browserbridge.*` name the user backend calls. No evaluate. */
const VERBS: Readonly<Record<string, { readonly method: string; readonly timeoutMs?: number }>> = {
  'browserbridge.tabs.list': { method: 'tabs.list' },
  'browserbridge.tabs.open': { method: 'tabs.open', timeoutMs: 60_000 },
  'browserbridge.tabs.navigate': { method: 'tabs.navigate', timeoutMs: 60_000 },
  'browserbridge.tabs.focus': { method: 'tabs.focus' },
  'browserbridge.tabs.close': { method: 'tabs.close' },
  'browserbridge.snapshot': { method: 'snapshot' },
  'browserbridge.screenshot': { method: 'screenshot' },
  'browserbridge.click': { method: 'click' },
  'browserbridge.type': { method: 'type' },
  'browserbridge.key': { method: 'key' },
  'browserbridge.scroll': { method: 'scroll' },
  'browserbridge.wait': { method: 'wait', timeoutMs: 65_000 },
};

/**
 * A `BridgeClient` over the carried bridge, answering in the same shapes the old extension's capabilities did, so the
 * user backend (src/user/tab.ts, status.ts) is unchanged. A screenshot is written to a private file and its path returned.
 */
export function createLocalBridgeClient(
  bridge: LocalBridge,
  screenshotDirectory: string = path.join(os.tmpdir(), 'marshal-browser', 'user-shots'),
  carried?: CarriedExtension,
): BridgeClient {
  return {
    ...(carried ? { carried } : {}),
    async call<T>(name: string, input: Record<string, unknown>): Promise<T> {
      if (name === 'browserbridge.status') {
        await bridge.ensureListening();
        const waitMs = input['waitMs'];
        if (typeof waitMs === 'number' && waitMs > 0 && bridge.status().listening)
          await bridge.waitForBrowser(Math.min(waitMs, 30_000));
        return bridge.status() as T;
      }
      const verb = VERBS[name];
      if (!verb)
        throw new BridgeError('unsupported', `${name} is not offered by the carried bridge`);
      if (input['tabId'] !== undefined && !Number.isInteger(input['tabId']))
        throw new BridgeError('failed', `${name}: tabId must be an integer`, 'invalid-request');
      if (verb.method === 'tabs.open' || verb.method === 'tabs.navigate') {
        const url = String(input['url']);
        const history =
          verb.method === 'tabs.navigate' && ['back', 'forward', 'reload'].includes(url);
        if (!history && !/^https?:\/\//i.test(url))
          throw new BridgeError(
            'failed',
            `${name}: url must start with http:// or https://`,
            'invalid-request',
          );
      }
      const result = await bridge.request(verb.method, input, verb.timeoutMs);
      if (verb.method !== 'screenshot') return result as T;
      const { data, ...rest } = result;
      if (typeof data !== 'string') throw new BridgeError('failed', 'screenshot returned no image');
      mkdirSync(screenshotDirectory, { recursive: true, mode: 0o700 });
      const file = path.join(
        screenshotDirectory,
        `tab-${String(input['tabId'])}-${String(Date.now())}-${String(Math.random()).slice(2, 8)}.png`,
      );
      writeFileSync(file, Buffer.from(data, 'base64'), { mode: 0o600 });
      return { ...rest, path: file } as T;
    },
  };
}
