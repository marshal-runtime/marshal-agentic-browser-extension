import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RemoteAdapter } from '../../../src/adapters/remote-adapter.js';
import { ErrorCode } from '@agentic-browser/shared';
import type { Logger } from '../../../src/infrastructure/logger.js';

/** Minimal mock Logger. */
function createMockLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as unknown as Logger;
}

/** Tracks registered listeners and simulates WebSocket behaviour. */
class MockWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;

  readyState = MockWebSocket.CONNECTING;
  onopen: ((ev: Event) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;

  readonly url: string;
  readonly protocol: string;
  readonly sentMessages: string[] = [];

  constructor(url: string, protocols?: string | string[]) {
    this.url = url;
    this.protocol = Array.isArray(protocols) ? (protocols[0] ?? '') : (protocols ?? '');
  }

  send(data: string): void {
    this.sentMessages.push(data);
  }

  close(_code?: number, _reason?: string): void {
    this.readyState = MockWebSocket.CLOSED;
  }

  /** Simulate the server accepting the connection. */
  simulateOpen(): void {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.(new Event('open'));
  }

  /** Simulate a server message. */
  simulateMessage(data: unknown): void {
    const event = { data: JSON.stringify(data) } as MessageEvent;
    this.onmessage?.(event);
  }

  /** Simulate connection error. */
  simulateError(): void {
    this.onerror?.(new Event('error'));
  }

  /** Simulate close. */
  simulateClose(code = 1000, reason = ''): void {
    this.readyState = MockWebSocket.CLOSED;
    const event = { code, reason, wasClean: code === 1000 } as CloseEvent;
    this.onclose?.(event);
  }
}

let capturedWs: MockWebSocket | null = null;

function installMockWebSocket(): void {
  (globalThis as Record<string, unknown>).WebSocket = class extends MockWebSocket {
    constructor(url: string, protocols?: string | string[]) {
      super(url, protocols);
      capturedWs = this;
    }
  } as unknown as typeof WebSocket;
}

function removeMockWebSocket(): void {
  delete (globalThis as Record<string, unknown>).WebSocket;
  capturedWs = null;
}

describe('RemoteAdapter', () => {
  let logger: Logger;
  let adapter: RemoteAdapter;

  beforeEach(() => {
    vi.useFakeTimers();
    installMockWebSocket();
    logger = createMockLogger();
    adapter = new RemoteAdapter(logger);
  });

  afterEach(() => {
    vi.useRealTimers();
    removeMockWebSocket();
  });

  // -- Connection lifecycle --------------------------------------------------

  describe('connectRemote', () => {
    it('should connect successfully via wss:// URL', async () => {
      const connectPromise = adapter.connectRemote('wss://remote.example.com/devtools');

      // Let the constructor run and set up the WS
      await vi.advanceTimersByTimeAsync(0);
      expect(capturedWs).not.toBeNull();
      capturedWs!.simulateOpen();

      const result = await connectPromise;

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.connected).toBe(true);
        expect(result.value.wsUrl).toBe('wss://remote.example.com/devtools');
        expect(result.value.browserName).toBe('Remote CDP');
      }
    });

    it('should connect successfully via ws://localhost', async () => {
      const connectPromise = adapter.connectRemote('ws://localhost:9222/devtools');

      await vi.advanceTimersByTimeAsync(0);
      capturedWs!.simulateOpen();

      const result = await connectPromise;
      expect(result.ok).toBe(true);
    });

    it('should reject invalid WebSocket URL', async () => {
      const result = await adapter.connectRemote('http://example.com');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCode.REMOTE_CONNECTION_FAILED);
        expect(result.error.message).toContain('Invalid WebSocket URL');
      }
    });

    it('should reject ws:// for non-localhost', async () => {
      const result = await adapter.connectRemote('ws://remote.example.com/devtools');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCode.REMOTE_CONNECTION_FAILED);
        expect(result.error.message).toContain('WSS is required');
      }
    });

    it('should reject double connection', async () => {
      const connectPromise = adapter.connectRemote('wss://remote.example.com/devtools');
      await vi.advanceTimersByTimeAsync(0);
      capturedWs!.simulateOpen();
      await connectPromise;

      const result = await adapter.connectRemote('wss://other.example.com/devtools');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('Already connected');
      }
    });

    it('should handle connection error', async () => {
      const connectPromise = adapter.connectRemote('wss://remote.example.com/devtools');

      await vi.advanceTimersByTimeAsync(0);
      capturedWs!.simulateError();

      const result = await connectPromise;
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCode.REMOTE_CONNECTION_FAILED);
      }
    });

    it('should handle connection timeout', async () => {
      const connectPromise = adapter.connectRemote('wss://remote.example.com/devtools', {
        timeout: 5000,
      });

      await vi.advanceTimersByTimeAsync(0);
      // Don't open - let it time out
      await vi.advanceTimersByTimeAsync(5001);

      const result = await connectPromise;
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCode.REMOTE_CONNECTION_FAILED);
        expect(result.error.message).toContain('timed out');
      }
    });

    it('should pass bearer token as sub-protocol', async () => {
      const connectPromise = adapter.connectRemote('wss://remote.example.com/devtools', {
        bearerToken: 'my-secret-token',
      });

      await vi.advanceTimersByTimeAsync(0);
      expect(capturedWs).not.toBeNull();
      expect(capturedWs!.protocol).toBe('bearer-my-secret-token');
      capturedWs!.simulateOpen();
      await connectPromise;
    });
  });

  describe('disconnectRemote', () => {
    it('should disconnect gracefully', async () => {
      const connectPromise = adapter.connectRemote('wss://remote.example.com/devtools');
      await vi.advanceTimersByTimeAsync(0);
      capturedWs!.simulateOpen();
      await connectPromise;

      expect(adapter.isConnected()).toBe(true);

      const result = await adapter.disconnectRemote();
      expect(result.ok).toBe(true);
      expect(adapter.isConnected()).toBe(false);
    });

    it('should succeed when not connected', async () => {
      const result = await adapter.disconnectRemote();
      expect(result.ok).toBe(true);
    });
  });

  // -- IBrowserAdapter lifecycle ---------------------------------------------

  describe('connect / disconnect (IBrowserAdapter)', () => {
    it('should return error if no wsUrl configured', async () => {
      const result = await adapter.connect();
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCode.REMOTE_CONNECTION_FAILED);
        expect(result.error.message).toContain('No WebSocket URL');
      }
    });

    it('should return already-connected status', async () => {
      const connectPromise = adapter.connectRemote('wss://remote.example.com/devtools');
      await vi.advanceTimersByTimeAsync(0);
      capturedWs!.simulateOpen();
      await connectPromise;

      const result = await adapter.connect();
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.connected).toBe(true);
      }
    });

    it('should disconnect via IBrowserAdapter.disconnect()', async () => {
      const connectPromise = adapter.connectRemote('wss://remote.example.com/devtools');
      await vi.advanceTimersByTimeAsync(0);
      capturedWs!.simulateOpen();
      await connectPromise;

      const result = await adapter.disconnect();
      expect(result.ok).toBe(true);
      expect(adapter.isConnected()).toBe(false);
    });
  });

  // -- Helper: connect adapter for operation tests ---------------------------

  async function connectAdapter(): Promise<MockWebSocket> {
    const connectPromise = adapter.connectRemote('wss://remote.example.com/devtools');
    await vi.advanceTimersByTimeAsync(0);
    const ws = capturedWs!;
    ws.simulateOpen();
    await connectPromise;
    return ws;
  }

  async function respondToCommand(
    ws: MockWebSocket,
    method: string,
    result: unknown,
    inspect?: (message: Record<string, unknown>) => void,
  ): Promise<void> {
    await vi.advanceTimersByTimeAsync(0);
    const message = JSON.parse(ws.sentMessages[ws.sentMessages.length - 1]!) as Record<
      string,
      unknown
    >;
    expect(message['method']).toBe(method);
    inspect?.(message);
    ws.simulateMessage({ id: message['id'], result });
    await vi.advanceTimersByTimeAsync(0);
  }

  describe('isolated browser contexts', () => {
    it('routes two sessions through distinct CDP contexts and target sessions, then disposes one', async () => {
      const ws = await connectAdapter();
      expect(adapter.isolationCapabilities).toEqual({
        resource: 'cdp-browser-context',
        concurrentContexts: true,
        cookieIsolation: true,
        webStorageIsolation: true,
      });

      const firstPromise = adapter.createIsolatedBrowserContext('browser-a');
      await respondToCommand(ws, 'Target.createBrowserContext', { browserContextId: 'context-a' });
      await respondToCommand(
        ws,
        'Target.createTarget',
        { targetId: 'target-a' },
        (message) =>
          expect(message['params']).toEqual({
            url: 'about:blank',
            browserContextId: 'context-a',
          }),
      );
      const first = await firstPromise;

      const secondPromise = adapter.createIsolatedBrowserContext('browser-b');
      await respondToCommand(ws, 'Target.createBrowserContext', { browserContextId: 'context-b' });
      await respondToCommand(
        ws,
        'Target.createTarget',
        { targetId: 'target-b' },
        (message) =>
          expect(message['params']).toEqual({
            url: 'about:blank',
            browserContextId: 'context-b',
          }),
      );
      const second = await secondPromise;

      expect(first.ok).toBe(true);
      expect(second.ok).toBe(true);
      if (!first.ok || !second.ok) return;
      expect(first.value.browserContextId).not.toBe(second.value.browserContextId);
      expect(first.value.windowId).not.toBe(second.value.windowId);
      expect(first.value.initialTab.tabId).not.toBe(second.value.initialTab.tabId);

      const activateFirst = adapter.activateIsolatedBrowserTab(
        first.value.browserContextId,
        first.value.initialTab.tabId,
      );
      await respondToCommand(ws, 'Target.getTargetInfo', {
        targetInfo: { targetId: 'target-a', browserContextId: 'context-a' },
      });
      await respondToCommand(ws, 'Target.activateTarget', {});
      await respondToCommand(ws, 'Target.attachToTarget', { sessionId: 'target-session-a' });
      await expect(activateFirst).resolves.toEqual({ ok: true, value: undefined });

      const firstCookies = adapter.getCookies();
      await respondToCommand(ws, 'Network.getCookies', { cookies: [] }, (message) =>
        expect(message['sessionId']).toBe('target-session-a'),
      );
      await expect(firstCookies).resolves.toEqual({ ok: true, value: [] });

      const activateSecond = adapter.activateIsolatedBrowserTab(
        second.value.browserContextId,
        second.value.initialTab.tabId,
      );
      await respondToCommand(ws, 'Target.getTargetInfo', {
        targetInfo: { targetId: 'target-b', browserContextId: 'context-b' },
      });
      await respondToCommand(ws, 'Target.activateTarget', {});
      await respondToCommand(ws, 'Target.attachToTarget', { sessionId: 'target-session-b' });
      await expect(activateSecond).resolves.toEqual({ ok: true, value: undefined });

      const secondCookies = adapter.getCookies();
      await respondToCommand(ws, 'Network.getCookies', { cookies: [] }, (message) =>
        expect(message['sessionId']).toBe('target-session-b'),
      );
      await expect(secondCookies).resolves.toEqual({ ok: true, value: [] });

      const closeFirst = adapter.closeIsolatedBrowserContext(first.value.browserContextId);
      await respondToCommand(
        ws,
        'Target.disposeBrowserContext',
        {},
        (message) =>
          expect(message['params']).toEqual({
            browserContextId: first.value.browserContextId,
          }),
      );
      await expect(closeFirst).resolves.toEqual({ ok: true, value: undefined });
      expect(adapter.listSandboxSessions()).toEqual([
        expect.objectContaining({ browserContextId: second.value.browserContextId }),
      ]);
    });
  });

  // -- Navigation ------------------------------------------------------------

  describe('navigate', () => {
    it('should navigate to a URL successfully', async () => {
      const ws = await connectAdapter();

      const navPromise = adapter.navigate({ url: 'https://example.com' });

      // The adapter sends Page.enable, respond to it
      await vi.advanceTimersByTimeAsync(0);
      const enableMsg = JSON.parse(ws.sentMessages[ws.sentMessages.length - 1]!);
      ws.simulateMessage({ id: enableMsg.id, result: {} });

      await vi.advanceTimersByTimeAsync(0);

      // Page.navigate command
      const navMsg = JSON.parse(ws.sentMessages[ws.sentMessages.length - 1]!);
      ws.simulateMessage({ id: navMsg.id, result: { frameId: 'frame1' } });

      // Simulate page load event
      ws.simulateMessage({ method: 'Page.loadEventFired', params: {} });

      await vi.advanceTimersByTimeAsync(0);

      // Runtime.evaluate for current URL
      const evalMsg = JSON.parse(ws.sentMessages[ws.sentMessages.length - 1]!);
      ws.simulateMessage({
        id: evalMsg.id,
        result: { result: { type: 'string', value: 'https://example.com' } },
      });

      const result = await navPromise;
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe('https://example.com');
      }
    });

    it('should return error for invalid URL', async () => {
      await connectAdapter();

      const result = await adapter.navigate({ url: 'not-a-url' });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCode.NAVIGATION_FAILED);
        expect(result.error.message).toContain('Invalid URL');
      }
    });
  });

  // -- Screenshot ------------------------------------------------------------

  describe('captureScreenshot', () => {
    it('should capture a screenshot', async () => {
      const ws = await connectAdapter();

      const screenshotPromise = adapter.captureScreenshot({ format: 'png' });

      await vi.advanceTimersByTimeAsync(0);

      const msg = JSON.parse(ws.sentMessages[ws.sentMessages.length - 1]!);
      expect(msg.method).toBe('Page.captureScreenshot');
      ws.simulateMessage({
        id: msg.id,
        result: { data: 'iVBORw0KGgoAAAANSUhEUg==' },
      });

      const result = await screenshotPromise;
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.data).toBe('iVBORw0KGgoAAAANSUhEUg==');
        expect(result.value.mimeType).toBe('image/png');
      }
    });

    it('should capture JPEG screenshot with quality', async () => {
      const ws = await connectAdapter();

      const screenshotPromise = adapter.captureScreenshot({ format: 'jpeg', quality: 75 });

      await vi.advanceTimersByTimeAsync(0);

      const msg = JSON.parse(ws.sentMessages[ws.sentMessages.length - 1]!);
      expect(msg.params.format).toBe('jpeg');
      expect(msg.params.quality).toBe(75);

      ws.simulateMessage({
        id: msg.id,
        result: { data: '/9j/4AAQ==' },
      });

      const result = await screenshotPromise;
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.mimeType).toBe('image/jpeg');
      }
    });

    it('should handle screenshot error', async () => {
      const ws = await connectAdapter();

      const screenshotPromise = adapter.captureScreenshot();

      await vi.advanceTimersByTimeAsync(0);

      const msg = JSON.parse(ws.sentMessages[ws.sentMessages.length - 1]!);
      ws.simulateMessage({
        id: msg.id,
        error: { code: -32000, message: 'Page not found' },
      });

      const result = await screenshotPromise;
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCode.SCREENSHOT_FAILED);
      }
    });
  });

  // -- Error cases -----------------------------------------------------------

  describe('error cases', () => {
    it('should return error when sending CDP command while disconnected', async () => {
      const result = await adapter.sendCdpCommand({ method: 'Page.enable' });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCode.NOT_CONNECTED);
      }
    });

    it('should handle CDP command timeout', async () => {
      const ws = await connectAdapter();

      const cmdPromise = adapter.sendCdpCommand({ method: 'Page.enable' });

      await vi.advanceTimersByTimeAsync(0);
      // Don't respond - let it time out (CDP_RESPONSE_TIMEOUT_MS = 10_000)
      await vi.advanceTimersByTimeAsync(10_001);

      const result = await cmdPromise;
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCode.CDP_ERROR);
        expect(result.error.message).toContain('timed out');
      }
    });

    it('should handle CDP error response', async () => {
      const ws = await connectAdapter();

      const cmdPromise = adapter.sendCdpCommand({ method: 'DOM.getDocument' });

      await vi.advanceTimersByTimeAsync(0);

      const msg = JSON.parse(ws.sentMessages[ws.sentMessages.length - 1]!);
      ws.simulateMessage({
        id: msg.id,
        error: { code: -32601, message: 'Method not found' },
      });

      const result = await cmdPromise;
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCode.CDP_ERROR);
        expect(result.error.message).toContain('Method not found');
      }
    });

    it('should reject pending commands on disconnect', async () => {
      const ws = await connectAdapter();

      const cmdPromise = adapter.sendCdpCommand({ method: 'Page.enable' });
      await vi.advanceTimersByTimeAsync(0);

      await adapter.disconnectRemote();

      const result = await cmdPromise;
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCode.CDP_ERROR);
        expect(result.error.message).toContain('Connection closed');
      }
    });

    it('should handle unexpected WebSocket close during operation', async () => {
      const ws = await connectAdapter();

      expect(adapter.isConnected()).toBe(true);

      // Simulate unexpected close
      ws.simulateClose(1006, 'Abnormal closure');

      expect(adapter.isConnected()).toBe(false);
    });

    it('should handle non-JSON messages gracefully', async () => {
      const ws = await connectAdapter();

      // Send non-JSON message
      const event = { data: 'not-json-content' } as MessageEvent;
      ws.onmessage?.(event);

      // Should not crash - adapter stays connected
      expect(adapter.isConnected()).toBe(true);
      expect(logger.warn).toHaveBeenCalledWith('Received non-JSON WebSocket message');
    });
  });

  // -- isConnected -----------------------------------------------------------

  describe('isConnected', () => {
    it('should return false initially', () => {
      expect(adapter.isConnected()).toBe(false);
    });

    it('should return true after connection', async () => {
      await connectAdapter();
      expect(adapter.isConnected()).toBe(true);
    });

    it('should return false after disconnect', async () => {
      await connectAdapter();
      await adapter.disconnectRemote();
      expect(adapter.isConnected()).toBe(false);
    });
  });

  // -- Tab management --------------------------------------------------------

  describe('listTabs', () => {
    it('should list open tabs', async () => {
      const ws = await connectAdapter();

      const tabsPromise = adapter.listTabs();

      await vi.advanceTimersByTimeAsync(0);

      const msg = JSON.parse(ws.sentMessages[ws.sentMessages.length - 1]!);
      expect(msg.method).toBe('Target.getTargets');

      ws.simulateMessage({
        id: msg.id,
        result: {
          targetInfos: [
            { targetId: 't1', type: 'page', title: 'Tab 1', url: 'https://a.com', attached: true },
            { targetId: 't2', type: 'page', title: 'Tab 2', url: 'https://b.com', attached: false },
            { targetId: 't3', type: 'worker', title: 'Worker', url: '', attached: false },
          ],
        },
      });

      const result = await tabsPromise;
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toHaveLength(2);
        expect(result.value[0]!.title).toBe('Tab 1');
        expect(result.value[1]!.title).toBe('Tab 2');
      }
    });
  });

  // -- Dialog handling -------------------------------------------------------

  describe('handleDialog', () => {
    it('should handle dialog accept', async () => {
      const ws = await connectAdapter();

      const dialogPromise = adapter.handleDialog({ accept: true });

      await vi.advanceTimersByTimeAsync(0);

      const msg = JSON.parse(ws.sentMessages[ws.sentMessages.length - 1]!);
      expect(msg.method).toBe('Page.handleJavaScriptDialog');
      expect(msg.params.accept).toBe(true);

      ws.simulateMessage({ id: msg.id, result: {} });

      const result = await dialogPromise;
      expect(result.ok).toBe(true);
    });
  });

  // -- Attach/detach debugger ------------------------------------------------

  describe('attachDebugger / detachDebugger', () => {
    it('should no-op for attach and detach', async () => {
      await connectAdapter();

      const attachResult = await adapter.attachDebugger(1);
      expect(attachResult.ok).toBe(true);

      const detachResult = await adapter.detachDebugger(1);
      expect(detachResult.ok).toBe(true);
    });
  });

  // -- Sandbox sessions (FR-038) ---------------------------------------------

  describe('createSandboxSession', () => {
    it('should create an isolated browser context', async () => {
      const ws = await connectAdapter();

      const sandboxPromise = adapter.createSandboxSession({ name: 'test-sandbox' });

      await vi.advanceTimersByTimeAsync(0);

      const msg = JSON.parse(ws.sentMessages[ws.sentMessages.length - 1]!);
      expect(msg.method).toBe('Target.createBrowserContext');
      expect(msg.params.disposeOnDetach).toBe(true);

      ws.simulateMessage({
        id: msg.id,
        result: { browserContextId: 'ctx-123' },
      });

      const result = await sandboxPromise;
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.browserContextId).toBe('ctx-123');
        expect(result.value.name).toBe('test-sandbox');
        expect(result.value.sessionId).toContain('sandbox-');
        expect(result.value.createdAt).toBeGreaterThan(0);
      }
    });

    it('should create session with default name when none provided', async () => {
      const ws = await connectAdapter();

      const sandboxPromise = adapter.createSandboxSession();

      await vi.advanceTimersByTimeAsync(0);

      const msg = JSON.parse(ws.sentMessages[ws.sentMessages.length - 1]!);
      ws.simulateMessage({
        id: msg.id,
        result: { browserContextId: 'ctx-456' },
      });

      const result = await sandboxPromise;
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.name).toBe(result.value.sessionId);
      }
    });

    it('should pass proxy settings to browser context', async () => {
      const ws = await connectAdapter();

      const sandboxPromise = adapter.createSandboxSession({
        proxyServer: 'socks5://proxy.local:1080',
        proxyBypassList: 'localhost,127.0.0.1',
      });

      await vi.advanceTimersByTimeAsync(0);

      const msg = JSON.parse(ws.sentMessages[ws.sentMessages.length - 1]!);
      expect(msg.params.proxyServer).toBe('socks5://proxy.local:1080');
      expect(msg.params.proxyBypassList).toBe('localhost,127.0.0.1');

      ws.simulateMessage({
        id: msg.id,
        result: { browserContextId: 'ctx-proxy' },
      });

      const result = await sandboxPromise;
      expect(result.ok).toBe(true);
    });

    it('should return error when not connected', async () => {
      const result = await adapter.createSandboxSession();
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCode.NOT_CONNECTED);
      }
    });

    it('should support multiple concurrent sandbox sessions', async () => {
      const ws = await connectAdapter();

      const promise1 = adapter.createSandboxSession({ name: 'sandbox-a' });
      await vi.advanceTimersByTimeAsync(0);
      const msg1 = JSON.parse(ws.sentMessages[ws.sentMessages.length - 1]!);
      ws.simulateMessage({ id: msg1.id, result: { browserContextId: 'ctx-a' } });
      const result1 = await promise1;

      const promise2 = adapter.createSandboxSession({ name: 'sandbox-b' });
      await vi.advanceTimersByTimeAsync(0);
      const msg2 = JSON.parse(ws.sentMessages[ws.sentMessages.length - 1]!);
      ws.simulateMessage({ id: msg2.id, result: { browserContextId: 'ctx-b' } });
      const result2 = await promise2;

      expect(result1.ok).toBe(true);
      expect(result2.ok).toBe(true);

      if (result1.ok && result2.ok) {
        expect(result1.value.browserContextId).toBe('ctx-a');
        expect(result2.value.browserContextId).toBe('ctx-b');
        expect(result1.value.sessionId).not.toBe(result2.value.sessionId);
      }

      const sessions = adapter.listSandboxSessions();
      expect(sessions).toHaveLength(2);
    });
  });

  describe('closeSandboxSession', () => {
    it('should dispose browser context and remove session', async () => {
      const ws = await connectAdapter();

      const createPromise = adapter.createSandboxSession({ name: 'to-close' });
      await vi.advanceTimersByTimeAsync(0);
      const createMsg = JSON.parse(ws.sentMessages[ws.sentMessages.length - 1]!);
      ws.simulateMessage({ id: createMsg.id, result: { browserContextId: 'ctx-close' } });
      const createResult = await createPromise;

      expect(createResult.ok).toBe(true);
      if (!createResult.ok) return;

      const closePromise = adapter.closeSandboxSession(createResult.value.sessionId);
      await vi.advanceTimersByTimeAsync(0);

      const closeMsg = JSON.parse(ws.sentMessages[ws.sentMessages.length - 1]!);
      expect(closeMsg.method).toBe('Target.disposeBrowserContext');
      expect(closeMsg.params.browserContextId).toBe('ctx-close');

      ws.simulateMessage({ id: closeMsg.id, result: {} });

      const closeResult = await closePromise;
      expect(closeResult.ok).toBe(true);

      expect(adapter.listSandboxSessions()).toHaveLength(0);
    });

    it('should return error for unknown session ID', async () => {
      await connectAdapter();
      const result = await adapter.closeSandboxSession('nonexistent');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('No sandbox session found');
      }
    });
  });

  describe('createSandboxTab', () => {
    it('should create a tab within sandbox browser context', async () => {
      const ws = await connectAdapter();

      const createPromise = adapter.createSandboxSession({ name: 'tab-test' });
      await vi.advanceTimersByTimeAsync(0);
      const createMsg = JSON.parse(ws.sentMessages[ws.sentMessages.length - 1]!);
      ws.simulateMessage({ id: createMsg.id, result: { browserContextId: 'ctx-tab' } });
      const createResult = await createPromise;

      expect(createResult.ok).toBe(true);
      if (!createResult.ok) return;

      const tabPromise = adapter.createSandboxTab(
        createResult.value.sessionId,
        'https://sandboxed.example.com',
      );

      await vi.advanceTimersByTimeAsync(0);

      const tabMsg = JSON.parse(ws.sentMessages[ws.sentMessages.length - 1]!);
      expect(tabMsg.method).toBe('Target.createTarget');
      expect(tabMsg.params.url).toBe('https://sandboxed.example.com');
      expect(tabMsg.params.browserContextId).toBe('ctx-tab');

      ws.simulateMessage({
        id: tabMsg.id,
        result: { targetId: 'target-sandbox-1' },
      });

      const tabResult = await tabPromise;
      expect(tabResult.ok).toBe(true);
      if (tabResult.ok) {
        expect(tabResult.value.url).toBe('https://sandboxed.example.com');
        expect(tabResult.value.tabId).toBeGreaterThan(0);
      }
    });

    it('should return error for unknown session ID', async () => {
      await connectAdapter();

      const result = await adapter.createSandboxTab('nonexistent');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('No sandbox session found');
      }
    });
  });

  describe('listSandboxSessions', () => {
    it('should return empty array when no sessions exist', async () => {
      await connectAdapter();
      expect(adapter.listSandboxSessions()).toHaveLength(0);
    });
  });

  // -- Remote IP connection (FR-039) -----------------------------------------

  describe('connectToIP', () => {
    it('should construct WSS URL and connect for LAN address', async () => {
      const connectPromise = adapter.connectToIP({
        host: '192.168.1.100',
        port: 9222,
      });

      await vi.advanceTimersByTimeAsync(0);
      expect(capturedWs).not.toBeNull();
      expect(capturedWs!.url).toBe('wss://192.168.1.100:9222/devtools/browser');
      capturedWs!.simulateOpen();

      const result = await connectPromise;
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.connected).toBe(true);
        expect(result.value.wsUrl).toBe('wss://192.168.1.100:9222/devtools/browser');
      }
    });

    it('should construct WSS URL for WAN hostname', async () => {
      const connectPromise = adapter.connectToIP({
        host: 'browser.cloud-provider.com',
        port: 443,
        path: '/cdp',
      });

      await vi.advanceTimersByTimeAsync(0);
      expect(capturedWs!.url).toBe('wss://browser.cloud-provider.com:443/cdp');
      capturedWs!.simulateOpen();

      const result = await connectPromise;
      expect(result.ok).toBe(true);
    });

    it('should use ws:// when secure is false (localhost only)', async () => {
      const connectPromise = adapter.connectToIP({
        host: 'localhost',
        port: 9222,
        secure: false,
      });

      await vi.advanceTimersByTimeAsync(0);
      expect(capturedWs!.url).toBe('ws://localhost:9222/devtools/browser');
      capturedWs!.simulateOpen();

      const result = await connectPromise;
      expect(result.ok).toBe(true);
    });

    it('should reject ws:// for non-localhost hosts', async () => {
      const result = await adapter.connectToIP({
        host: '10.0.0.5',
        port: 9222,
        secure: false,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCode.REMOTE_CONNECTION_FAILED);
        expect(result.error.message).toContain('WSS is required');
      }
    });

    it('should reject invalid host', async () => {
      const result = await adapter.connectToIP({
        host: '',
        port: 9222,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCode.REMOTE_CONNECTION_FAILED);
        expect(result.error.message).toContain('Invalid remote host');
      }
    });

    it('should reject invalid port', async () => {
      const result = await adapter.connectToIP({
        host: '192.168.1.1',
        port: 0,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCode.REMOTE_CONNECTION_FAILED);
        expect(result.error.message).toContain('Invalid port');
      }
    });

    it('should reject port over 65535', async () => {
      const result = await adapter.connectToIP({
        host: '192.168.1.1',
        port: 70000,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('Invalid port');
      }
    });

    it('should pass bearer token and TLS options', async () => {
      const connectPromise = adapter.connectToIP({
        host: 'secure.example.com',
        port: 9223,
        bearerToken: 'remote-token',
        tls: {
          rejectUnauthorized: true,
          certificateFingerprint: 'sha256/abc123',
        },
      });

      await vi.advanceTimersByTimeAsync(0);
      expect(capturedWs!.protocol).toBe('bearer-remote-token');
      capturedWs!.simulateOpen();

      const result = await connectPromise;
      expect(result.ok).toBe(true);
    });

    it('should support IPv6 addresses', async () => {
      const connectPromise = adapter.connectToIP({
        host: '::1',
        port: 9222,
      });

      await vi.advanceTimersByTimeAsync(0);
      expect(capturedWs!.url).toBe('wss://::1:9222/devtools/browser');
      capturedWs!.simulateOpen();

      const result = await connectPromise;
      expect(result.ok).toBe(true);
    });
  });

  // -- TLS validation (NFR-016) ----------------------------------------------

  describe('TLS options', () => {
    it('should log warning when TLS validation is disabled', async () => {
      const connectPromise = adapter.connectRemote('wss://remote.example.com/devtools', {
        tls: { rejectUnauthorized: false },
      });

      await vi.advanceTimersByTimeAsync(0);
      capturedWs!.simulateOpen();
      await connectPromise;

      expect(logger.warn).toHaveBeenCalledWith(
        'TLS certificate validation disabled for remote connection',
        expect.objectContaining({ wsUrl: 'wss://remote.example.com/devtools' }),
      );
    });

    it('should accept TLS certificate fingerprint option', async () => {
      const connectPromise = adapter.connectRemote('wss://remote.example.com/devtools', {
        tls: {
          rejectUnauthorized: true,
          certificateFingerprint: 'sha256/fingerprint123',
        },
      });

      await vi.advanceTimersByTimeAsync(0);
      capturedWs!.simulateOpen();

      const result = await connectPromise;
      expect(result.ok).toBe(true);
    });
  });

  // -- Cleanup on disconnect -------------------------------------------------

  describe('sandbox cleanup on disconnect', () => {
    it('should clear sandbox sessions on disconnect', async () => {
      const ws = await connectAdapter();

      const createPromise = adapter.createSandboxSession({ name: 'cleanup-test' });
      await vi.advanceTimersByTimeAsync(0);
      const createMsg = JSON.parse(ws.sentMessages[ws.sentMessages.length - 1]!);
      ws.simulateMessage({ id: createMsg.id, result: { browserContextId: 'ctx-cleanup' } });
      await createPromise;

      expect(adapter.listSandboxSessions()).toHaveLength(1);

      // Simulate unexpected close
      ws.simulateClose(1006, 'Abnormal closure');

      expect(adapter.listSandboxSessions()).toHaveLength(0);
    });
  });

  describe('profile-only APIs', () => {
    it('returns explicit errors for browser profile data unavailable over CDP', async () => {
      const results = await Promise.all([
        adapter.listBookmarks(),
        adapter.searchHistory('example'),
        adapter.getDownloadItems(),
      ]);

      for (const result of results) {
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.code).toBe(ErrorCode.PERMISSION_DENIED);
          expect(result.error.message).toContain('remote CDP adapter');
        }
      }
    });
  });
});
