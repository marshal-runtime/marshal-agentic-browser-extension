/**
 * Remote browser adapter implementing {@link IBrowserAdapter}.
 *
 * Connects to a remote browser via WebSocket using the Chrome DevTools
 * Protocol (CDP). All browser interactions are sent as JSON-RPC messages
 * over the WebSocket connection.
 */

import type {
  IBrowserAdapter,
  ConnectOptions,
  ConnectionStatus,
  NavigateOptions,
  WaitUntilCondition,
  ClickOptions,
  TypeOptions,
  HoverOptions,
  ScrollOptions,
  SelectOptions,
  FocusOptions,
  GetAttributeOptions,
  GetPropertyOptions,
  CreateTabOptions,
  TabInfo,
  HandleDialogOptions,
  DialogInfo,
  DialogType,
  ScreenshotOptions,
  ScreenshotResult,
  AccessibilityNode,
  QuerySelectorOptions,
  QuerySelectorAllOptions,
  DomElementInfo,
  ExecuteScriptOptions,
  ExecuteScriptFileOptions,
  ExecuteValidationOptions,
  ValidationResult,
  EvaluateExpressionOptions,
  ConsoleCommandOptions,
  InjectScriptOptions,
  RemoveScriptOptions,
  CdpCommandOptions,
  SetOuterHtmlOptions,
  SetInnerHtmlOptions,
  InsertAdjacentHtmlOptions,
  AddStyleSheetOptions,
  ModifyStyleOptions,
  GetComputedStyleOptions,
  CookieData,
  GetCookiesOptions,
  WaitForSelectorOptions,
  WaitForNavigationOptions,
  WaitForConditionOptions,
  ExecuteStepsOptions,
  ExecuteStepsResult,
  RemoteConnectOptions,
  RemoteConnectionStatus,
  SandboxOptions,
  SandboxSessionInfo,
  RemoteIPOptions,
  ErrorResponse,
  Result,
} from '@agentic-browser/shared';
import {
  ErrorCode,
  DEFAULT_CONNECT_TIMEOUT,
  DEFAULT_NAVIGATION_TIMEOUT,
  DEFAULT_SCREENSHOT_FORMAT,
  DEFAULT_SCREENSHOT_QUALITY,
  DEFAULT_SCRIPT_TIMEOUT,
  DEFAULT_WAIT_TIMEOUT,
  DEFAULT_POLLING_INTERVAL,
  DEFAULT_QUERY_LIMIT,
  DEFAULT_TYPE_DELAY,
  ok,
  err,
  getDomWalkerScript,
} from '@agentic-browser/shared';
import type { Logger } from '../infrastructure/logger.js';
import type {
  BrowserIsolationAdapter,
  IsolatedBrowserContext,
} from './browser-isolation.js';

/** Heartbeat interval in milliseconds. */
const HEARTBEAT_INTERVAL_MS = 5_000;

/** Timeout for individual CDP command responses in milliseconds. */
const CDP_RESPONSE_TIMEOUT_MS = 10_000;

/** CDP JSON-RPC response from the remote browser. */
interface CdpResponse {
  readonly id: number;
  readonly sessionId?: string;
  readonly result?: unknown;
  readonly error?: {
    readonly code: number;
    readonly message: string;
  };
}

/** CDP event received from the remote browser. */
interface CdpEvent {
  readonly method: string;
  readonly params?: Record<string, unknown>;
  readonly sessionId?: string;
}

/** Pending CDP command awaiting a response. */
interface PendingCommand {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** CDP Page.captureScreenshot response. */
interface CdpScreenshotResponse {
  readonly data: string;
}

/** CDP Accessibility.getFullAXTree node. */
interface CdpAXNode {
  readonly nodeId: string;
  readonly role?: { readonly value: string };
  readonly name?: { readonly value: string };
  readonly value?: { readonly value: string };
  readonly description?: { readonly value: string };
  readonly childIds?: readonly string[];
  readonly ignored?: boolean;
  readonly backendDOMNodeId?: number;
}

/** CDP Accessibility.getFullAXTree response. */
interface CdpAXTreeResponse {
  readonly nodes: readonly CdpAXNode[];
}

/** DOMSnapshot.captureSnapshot response (subset we use). */


/** CDP Runtime.evaluate response. */
interface CdpEvaluateResponse {
  readonly result: {
    readonly type: string;
    readonly subtype?: string;
    readonly value?: unknown;
    readonly description?: string;
  };
  readonly exceptionDetails?: {
    readonly text: string;
    readonly exception?: {
      readonly description?: string;
    };
  };
}

/** CDP Target.getTargets response. */
interface CdpTargetsResponse {
  readonly targetInfos: readonly CdpTargetInfo[];
}

/** CDP Target info structure. */
interface CdpTargetInfo {
  readonly targetId: string;
  readonly type: string;
  readonly title: string;
  readonly url: string;
  readonly attached: boolean;
  readonly browserContextId?: string;
}

/** CDP Target.createTarget response. */
interface CdpCreateTargetResponse {
  readonly targetId: string;
}

/** CDP Target.createBrowserContext response. */
interface CdpCreateBrowserContextResponse {
  readonly browserContextId: string;
}

interface CdpAttachToTargetResponse {
  readonly sessionId: string;
}

interface CdpTargetInfoResponse {
  readonly targetInfo: CdpTargetInfo;
}

/** Registered CDP event listener. */
type CdpEventListener = (method: string, params?: Record<string, unknown>) => void;

/**
 * Returns `true` when the given URL points to a localhost address.
 */
function isLocalhostUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname;
    return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
  } catch {
    return false;
  }
}

/**
 * Returns `true` when the given host is a valid IPv4, IPv6, or hostname
 * suitable for LAN or WAN remote connections.
 */
function isValidRemoteHost(host: string): boolean {
  if (!host || host.length === 0) return false;

  // IPv4
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
    return host.split('.').every((octet) => {
      const n = Number(octet);
      return n >= 0 && n <= 255;
    });
  }

  // IPv6 (bracketed or raw)
  const ipv6 = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  if (ipv6.includes(':')) {
    return /^[0-9a-fA-F:]+$/.test(ipv6);
  }

  // Hostname
  return /^[a-zA-Z0-9]([a-zA-Z0-9\-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9\-]*[a-zA-Z0-9])?)*$/.test(host);
}

/** Returns the MIME type for a screenshot format. */
function toMimeType(format: string): string {
  switch (format) {
    case 'jpeg':
      return 'image/jpeg';
    case 'webp':
      return 'image/webp';
    default:
      return 'image/png';
  }
}

/**
 * Remote browser adapter that bridges the {@link IBrowserAdapter} interface
 * to a remote browser via WebSocket CDP connection.
 */
class RemoteAdapter implements IBrowserAdapter, BrowserIsolationAdapter {
  readonly isolationCapabilities = {
    resource: 'cdp-browser-context',
    concurrentContexts: true,
    cookieIsolation: true,
    webStorageIsolation: true,
  } as const;
  private readonly logger: Logger;
  private ws: WebSocket | null = null;
  private connected = false;
  private nextCommandId = 1;
  private readonly pendingCommands = new Map<number, PendingCommand>();
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private wsUrl: string | null = null;
  private bearerToken: string | undefined;
  private tlsFingerprint: string | undefined;
  private readonly eventListeners: CdpEventListener[] = [];
  private currentDialog: DialogInfo | null = null;
  private targetIdCounter = 0;
  private readonly targetIdMap = new Map<string, number>();
  private readonly numericIdMap = new Map<number, string>();
  private readonly sandboxSessions = new Map<string, SandboxSessionInfo>();
  private readonly isolatedBrowserContexts = new Map<
    string,
    {
      readonly sandboxSessionId: string;
      readonly windowId: number;
      readonly tabIds: Set<number>;
    }
  >();
  private readonly targetSessionIds = new Map<string, string>();
  private activeTargetSessionId: string | undefined;
  private sandboxCounter = 0;

  constructor(logger: Logger) {
    this.logger = logger;
  }

  // -- Remote connection lifecycle -------------------------------------------

  async connectRemote(
    wsUrl: string,
    options?: RemoteConnectOptions,
  ): Promise<Result<RemoteConnectionStatus, ErrorResponse>> {
    if (this.connected && this.ws) {
      return err({
        code: ErrorCode.UNKNOWN,
        message: 'Already connected to a remote browser',
      });
    }

    if (!wsUrl.startsWith('ws://') && !wsUrl.startsWith('wss://')) {
      return err({
        code: ErrorCode.REMOTE_CONNECTION_FAILED,
        message: `Invalid WebSocket URL: ${wsUrl}`,
      });
    }

    if (wsUrl.startsWith('ws://') && !isLocalhostUrl(wsUrl)) {
      return err({
        code: ErrorCode.REMOTE_CONNECTION_FAILED,
        message: 'WSS is required for non-localhost connections. Use wss:// instead of ws://',
      });
    }

    const timeout = options?.timeout ?? DEFAULT_CONNECT_TIMEOUT;
    this.bearerToken = options?.bearerToken;
    this.tlsFingerprint = options?.tls?.certificateFingerprint;
    this.wsUrl = wsUrl;

    if (wsUrl.startsWith('wss://') && options?.tls?.rejectUnauthorized === false) {
      this.logger.warn('TLS certificate validation disabled for remote connection', { wsUrl });
    }

    try {
      await this.openWebSocket(wsUrl, timeout);

      this.startHeartbeat();

      const status: RemoteConnectionStatus = {
        connected: true,
        browserName: 'Remote CDP',
        wsUrl,
      };

      this.logger.info('RemoteAdapter connected', { wsUrl });
      return ok(status);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Connection failed';
      this.logger.error('RemoteAdapter connection failed', { wsUrl, error: message });
      this.cleanup();
      return err({ code: ErrorCode.REMOTE_CONNECTION_FAILED, message });
    }
  }

  async disconnectRemote(): Promise<Result<void, ErrorResponse>> {
    if (!this.ws) {
      return ok(undefined);
    }

    for (const [sessionId] of this.sandboxSessions) {
      await this.closeSandboxSession(sessionId).catch(() => {});
    }

    this.cleanup();
    this.logger.info('RemoteAdapter disconnected');
    return ok(undefined);
  }

  // -- Sandbox session management (FR-038) -----------------------------------

  async createSandboxSession(
    options?: SandboxOptions,
  ): Promise<Result<SandboxSessionInfo, ErrorResponse>> {
    if (!this.connected || !this.ws) {
      return err({
        code: ErrorCode.NOT_CONNECTED,
        message: 'Not connected to remote browser',
      });
    }

    try {
      const params: Record<string, unknown> = {
        disposeOnDetach: true,
      };

      if (options?.proxyServer) {
        params.proxyServer = options.proxyServer;
      }
      if (options?.proxyBypassList) {
        params.proxyBypassList = options.proxyBypassList;
      }

      const result = await this.sendCdpCommandRaw<CdpCreateBrowserContextResponse>(
        'Target.createBrowserContext',
        params,
      );

      const sessionId = `sandbox-${++this.sandboxCounter}`;
      const sessionInfo: SandboxSessionInfo = {
        sessionId,
        browserContextId: result.browserContextId,
        name: options?.name ?? sessionId,
        createdAt: Date.now(),
      };

      this.sandboxSessions.set(sessionId, sessionInfo);
      this.logger.info('Sandbox session created', {
        sessionId,
        browserContextId: result.browserContextId,
      });

      return ok(sessionInfo);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to create sandbox session';
      this.logger.error('createSandboxSession failed', { error: message });
      return err({ code: ErrorCode.UNKNOWN, message });
    }
  }

  async closeSandboxSession(sessionId: string): Promise<Result<void, ErrorResponse>> {
    const session = this.sandboxSessions.get(sessionId);
    if (!session) {
      return err({
        code: ErrorCode.UNKNOWN,
        message: `No sandbox session found with ID: ${sessionId}`,
      });
    }

    if (!this.connected || !this.ws) {
      this.sandboxSessions.delete(sessionId);
      return ok(undefined);
    }

    try {
      await this.sendCdpCommandRaw('Target.disposeBrowserContext', {
        browserContextId: session.browserContextId,
      });

      this.sandboxSessions.delete(sessionId);
      this.logger.info('Sandbox session closed', { sessionId });
      return ok(undefined);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to close sandbox session';
      this.logger.error('closeSandboxSession failed', { sessionId, error: message });
      return err({ code: ErrorCode.UNKNOWN, message });
    }
  }

  listSandboxSessions(): SandboxSessionInfo[] {
    return Array.from(this.sandboxSessions.values());
  }

  async createSandboxTab(
    sessionId: string,
    url?: string,
  ): Promise<Result<TabInfo, ErrorResponse>> {
    const session = this.sandboxSessions.get(sessionId);
    if (!session) {
      return err({
        code: ErrorCode.UNKNOWN,
        message: `No sandbox session found with ID: ${sessionId}`,
      });
    }

    try {
      const result = await this.sendCdpCommandRaw<CdpCreateTargetResponse>(
        'Target.createTarget',
        {
          url: url ?? 'about:blank',
          browserContextId: session.browserContextId,
        },
      );

      const numId = this.getNumericTabId(result.targetId);
      const tabInfo: TabInfo = {
        tabId: numId,
        url: url ?? 'about:blank',
        title: '',
        active: true,
        windowId: 0,
      };

      this.logger.debug('Sandbox tab created', {
        sessionId,
        tabId: numId,
        targetId: result.targetId,
      });

      return ok(tabInfo);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to create sandbox tab';
      this.logger.error('createSandboxTab failed', { sessionId, error: message });
      return err({ code: ErrorCode.UNKNOWN, message });
    }
  }

  async createIsolatedBrowserContext(
    browserSessionId: string,
  ): Promise<Result<IsolatedBrowserContext, ErrorResponse>> {
    const sandbox = await this.createSandboxSession({ name: browserSessionId });
    if (!sandbox.ok) {
      return sandbox;
    }

    const initialTab = await this.createSandboxTab(sandbox.value.sessionId);
    if (!initialTab.ok) {
      const cleanup = await this.closeSandboxSession(sandbox.value.sessionId);
      const cleanupDetail = cleanup.ok ? '' : `; cleanup also failed: ${cleanup.error.message}`;
      return err({
        code: initialTab.error.code,
        message: `${initialTab.error.message}${cleanupDetail}`,
      });
    }

    const allocationId = Number(sandbox.value.sessionId.slice('sandbox-'.length));
    const windowId = 1_000_000 + allocationId;
    const tab = { ...initialTab.value, windowId };
    this.isolatedBrowserContexts.set(sandbox.value.browserContextId, {
      sandboxSessionId: sandbox.value.sessionId,
      windowId,
      tabIds: new Set([tab.tabId]),
    });
    return ok({
      browserContextId: sandbox.value.browserContextId,
      windowId,
      initialTab: tab,
    });
  }

  async createIsolatedBrowserTab(
    browserContextId: string,
    options?: CreateTabOptions,
  ): Promise<Result<TabInfo, ErrorResponse>> {
    const context = this.isolatedBrowserContexts.get(browserContextId);
    if (!context) {
      return err({
        code: ErrorCode.UNKNOWN,
        message: `Unknown isolated browser context: ${browserContextId}`,
      });
    }

    const created = await this.createSandboxTab(context.sandboxSessionId, options?.url);
    if (!created.ok) {
      return created;
    }
    context.tabIds.add(created.value.tabId);
    return ok({
      ...created.value,
      active: options?.active ?? true,
      windowId: context.windowId,
    });
  }

  async closeIsolatedBrowserContext(
    browserContextId: string,
  ): Promise<Result<void, ErrorResponse>> {
    const context = this.isolatedBrowserContexts.get(browserContextId);
    if (!context) {
      return err({
        code: ErrorCode.UNKNOWN,
        message: `Unknown isolated browser context: ${browserContextId}`,
      });
    }

    const closed = await this.closeSandboxSession(context.sandboxSessionId);
    if (!closed.ok) {
      return closed;
    }
    for (const tabId of context.tabIds) {
      const targetId = this.numericIdMap.get(tabId);
      if (targetId) {
        const sessionId = this.targetSessionIds.get(targetId);
        if (sessionId === this.activeTargetSessionId) {
          this.activeTargetSessionId = undefined;
        }
        this.targetSessionIds.delete(targetId);
        this.targetIdMap.delete(targetId);
        this.numericIdMap.delete(tabId);
      }
    }
    this.isolatedBrowserContexts.delete(browserContextId);
    return ok(undefined);
  }

  async isTabInIsolatedBrowserContext(
    browserContextId: string,
    tabId: number,
  ): Promise<Result<boolean, ErrorResponse>> {
    const context = this.isolatedBrowserContexts.get(browserContextId);
    const targetId = this.getTargetId(tabId);
    if (!context || !targetId || !context.tabIds.has(tabId)) {
      return ok(false);
    }

    try {
      const result = await this.sendCdpCommandRaw<CdpTargetInfoResponse>('Target.getTargetInfo', {
        targetId,
      });
      return ok(result.targetInfo.browserContextId === browserContextId);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to inspect remote target';
      return err({ code: ErrorCode.CDP_ERROR, message });
    }
  }

  async activateIsolatedBrowserTab(
    browserContextId: string,
    tabId: number,
  ): Promise<Result<void, ErrorResponse>> {
    const ownership = await this.isTabInIsolatedBrowserContext(browserContextId, tabId);
    if (!ownership.ok) {
      return ownership;
    }
    if (!ownership.value) {
      return err({
        code: ErrorCode.PERMISSION_DENIED,
        message: `Browser tab ${String(tabId)} is outside isolated context ${browserContextId}`,
      });
    }

    const targetId = this.getTargetId(tabId);
    if (!targetId) {
      return err({
        code: ErrorCode.TAB_NOT_FOUND,
        message: `No target found for tab ID: ${String(tabId)}`,
      });
    }
    try {
      await this.sendCdpCommandRaw('Target.activateTarget', { targetId });
      let sessionId = this.targetSessionIds.get(targetId);
      if (!sessionId) {
        const attached = await this.sendCdpCommandRaw<CdpAttachToTargetResponse>(
          'Target.attachToTarget',
          { targetId, flatten: true },
        );
        sessionId = attached.sessionId;
        this.targetSessionIds.set(targetId, sessionId);
      }
      this.activeTargetSessionId = sessionId;
      return ok(undefined);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to activate remote target';
      return err({ code: ErrorCode.CDP_ERROR, message });
    }
  }

  // -- Remote IP connection (FR-039) -----------------------------------------

  async connectToIP(
    options: RemoteIPOptions,
  ): Promise<Result<RemoteConnectionStatus, ErrorResponse>> {
    if (!isValidRemoteHost(options.host)) {
      return err({
        code: ErrorCode.REMOTE_CONNECTION_FAILED,
        message: `Invalid remote host: ${options.host}`,
      });
    }

    if (options.port < 1 || options.port > 65535) {
      return err({
        code: ErrorCode.REMOTE_CONNECTION_FAILED,
        message: `Invalid port number: ${options.port}`,
      });
    }

    const protocol = options.secure !== false ? 'wss' : 'ws';
    const path = options.path ?? '/devtools/browser';
    const wsUrl = `${protocol}://${options.host}:${options.port}${path}`;

    return this.connectRemote(wsUrl, {
      bearerToken: options.bearerToken,
      timeout: options.timeout,
      tls: options.tls,
    });
  }

  // -- IBrowserAdapter lifecycle ---------------------------------------------

  async connect(options?: ConnectOptions): Promise<Result<ConnectionStatus, ErrorResponse>> {
    if (!this.wsUrl) {
      return err({
        code: ErrorCode.REMOTE_CONNECTION_FAILED,
        message: 'No WebSocket URL configured. Call connectRemote() first.',
      });
    }

    if (this.connected) {
      const status: ConnectionStatus = {
        connected: true,
        browserName: 'Remote CDP',
      };
      return ok(status);
    }

    const result = await this.connectRemote(this.wsUrl, {
      bearerToken: this.bearerToken,
      timeout: options?.timeout,
    });

    if (!result.ok) {
      return result;
    }

    return ok({
      connected: result.value.connected,
      browserName: result.value.browserName,
      browserVersion: result.value.browserVersion,
    });
  }

  async disconnect(): Promise<Result<void, ErrorResponse>> {
    return this.disconnectRemote();
  }

  isConnected(): boolean {
    return this.connected;
  }

  // -- CDP command transport -------------------------------------------------

  async sendCdpCommandRaw<T = unknown>(
    method: string,
    params?: Record<string, unknown>,
  ): Promise<T> {
    if (!this.ws || !this.connected) {
      throw new Error('Not connected to remote browser');
    }

    const id = this.nextCommandId++;
    const sessionId = isBrowserLevelCdpMethod(method) ? undefined : this.activeTargetSessionId;
    const message = JSON.stringify({ id, method, params, sessionId });

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingCommands.delete(id);
        reject(new Error(`CDP command '${method}' timed out after ${CDP_RESPONSE_TIMEOUT_MS}ms`));
      }, CDP_RESPONSE_TIMEOUT_MS);

      this.pendingCommands.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });

      this.ws!.send(message);
    });
  }

  // -- Private helpers -------------------------------------------------------

  private openWebSocket(url: string, timeout: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settled = false;

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        if (ws.readyState === WebSocket.CONNECTING) {
          ws.close();
        }
        reject(new Error(`WebSocket connection timed out after ${timeout}ms`));
      }, timeout);

      const protocols = this.bearerToken
        ? [`bearer-${this.bearerToken}`]
        : undefined;

      const ws = new WebSocket(url, protocols);

      ws.onopen = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.ws = ws;
        this.connected = true;
        this.setupMessageHandler(ws);
        resolve();
      };

      ws.onerror = (event: Event): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new Error('WebSocket connection error'));
      };

      ws.onclose = (event: CloseEvent): void => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(new Error(`WebSocket closed during connection: code=${event.code}`));
          return;
        }
        this.handleDisconnect(event);
      };
    });
  }

  private setupMessageHandler(ws: WebSocket): void {
    ws.onmessage = (event: MessageEvent): void => {
      let data: CdpResponse | CdpEvent;
      try {
        data = JSON.parse(String(event.data));
      } catch {
        this.logger.warn('Received non-JSON WebSocket message');
        return;
      }

      if ('id' in data && typeof (data).id === 'number') {
        this.handleCdpResponse(data);
      } else if ('method' in data) {
        this.handleCdpEvent(data);
      }
    };
  }

  private handleCdpResponse(response: CdpResponse): void {
    const pending = this.pendingCommands.get(response.id);
    if (!pending) {
      this.logger.warn('Received response for unknown command', { id: response.id });
      return;
    }

    this.pendingCommands.delete(response.id);
    clearTimeout(pending.timer);

    if (response.error) {
      pending.reject(
        new Error(`CDP error ${response.error.code}: ${response.error.message}`),
      );
    } else {
      pending.resolve(response.result);
    }
  }

  private handleCdpEvent(event: CdpEvent): void {
    if (event.sessionId && event.sessionId !== this.activeTargetSessionId) {
      return;
    }
    this.logger.debug('CDP event received', { method: event.method });

    if (event.method === 'Page.javascriptDialogOpening') {
      const params = event.params ?? {};
      this.currentDialog = {
        type: (params.type as DialogType) ?? 'alert',
        message: (params.message as string) ?? '',
        defaultPrompt: params.defaultPrompt as string | undefined,
      };
    } else if (event.method === 'Page.javascriptDialogClosed') {
      this.currentDialog = null;
    }

    for (const listener of this.eventListeners) {
      listener(event.method, event.params);
    }
  }

  private handleDisconnect(event: CloseEvent): void {
    this.logger.warn('WebSocket disconnected', {
      code: event.code,
      reason: event.reason,
      wasClean: event.wasClean,
    });
    this.cleanup();
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();

    this.heartbeatTimer = setInterval(() => {
      if (!this.connected || !this.ws) {
        this.stopHeartbeat();
        return;
      }

      this.sendCdpCommandRaw('Browser.getVersion')
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          this.logger.error('Heartbeat failed, connection may be stale', { error: message });
        });
    }, HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private cleanup(): void {
    this.stopHeartbeat();

    for (const [id, pending] of this.pendingCommands) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Connection closed'));
    }
    this.pendingCommands.clear();

    this.eventListeners.length = 0;
    this.currentDialog = null;
    this.sandboxSessions.clear();
    this.isolatedBrowserContexts.clear();
    this.targetSessionIds.clear();
    this.activeTargetSessionId = undefined;

    if (this.ws) {
      const ws = this.ws;
      this.ws = null;
      this.connected = false;

      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.onclose = null;
        ws.onerror = null;
        ws.onmessage = null;
        ws.close(1000, 'Client disconnect');
      }
    } else {
      this.connected = false;
    }
  }

  /**
   * Waits for a specific CDP event, with timeout.
   */
  private waitForEvent(eventName: string, timeout: number): Promise<Record<string, unknown>> {
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.eventListeners.indexOf(listener);
        if (idx >= 0) this.eventListeners.splice(idx, 1);
        reject(new Error(`Timed out waiting for event '${eventName}' after ${timeout}ms`));
      }, timeout);

      const listener: CdpEventListener = (method, params) => {
        if (method === eventName) {
          clearTimeout(timer);
          const idx = this.eventListeners.indexOf(listener);
          if (idx >= 0) this.eventListeners.splice(idx, 1);
          resolve(params ?? {});
        }
      };

      this.eventListeners.push(listener);
    });
  }

  /**
   * Evaluates a JS expression via CDP Runtime.evaluate and returns the result.
   */
  private async evaluateJs<T = unknown>(
    expression: string,
    returnByValue = true,
    awaitPromise = false,
  ): Promise<CdpEvaluateResponse> {
    return this.sendCdpCommandRaw<CdpEvaluateResponse>('Runtime.evaluate', {
      expression,
      returnByValue,
      awaitPromise,
    });
  }

  /**
   * Evaluates a JS expression and returns its value, or throws on error.
   */
  private async evaluateJsValue<T = unknown>(
    expression: string,
    awaitPromise = false,
  ): Promise<T> {
    const response = await this.evaluateJs(expression, true, awaitPromise);

    if (response.exceptionDetails) {
      const errorMessage =
        response.exceptionDetails.exception?.description ??
        response.exceptionDetails.text;
      throw new Error(errorMessage);
    }

    return response.result.value as T;
  }

  /**
   * Assigns a numeric ID to a CDP target ID for the TabInfo interface.
   */
  private getNumericTabId(targetId: string): number {
    const existing = this.targetIdMap.get(targetId);
    if (existing !== undefined) return existing;

    const numId = ++this.targetIdCounter;
    this.targetIdMap.set(targetId, numId);
    this.numericIdMap.set(numId, targetId);
    return numId;
  }

  /**
   * Resolves a numeric tab ID back to a CDP target ID.
   */
  private getTargetId(tabId: number): string | undefined {
    return this.numericIdMap.get(tabId);
  }

  // -- Navigation ------------------------------------------------------------

  async navigate(options: NavigateOptions): Promise<Result<string, ErrorResponse>> {
    const { url, waitUntil = 'load', timeout = DEFAULT_NAVIGATION_TIMEOUT } = options;

    try {
      new URL(url);
    } catch {
      return err({
        code: ErrorCode.NAVIGATION_FAILED,
        message: `Invalid URL: ${url}`,
      });
    }

    try {
      await this.sendCdpCommandRaw('Page.enable');

      const loadPromise = waitUntil === 'domcontentloaded'
        ? this.waitForEvent('Page.domContentEventFired', timeout)
        : this.waitForEvent('Page.loadEventFired', timeout);

      const navResult = await this.sendCdpCommandRaw<{ frameId: string; errorText?: string }>(
        'Page.navigate',
        { url },
      );

      if (navResult.errorText) {
        return err({
          code: ErrorCode.NAVIGATION_FAILED,
          message: `Navigation error: ${navResult.errorText}`,
        });
      }

      await loadPromise;

      const currentUrl = await this.evaluateJsValue<string>('window.location.href');
      this.logger.debug('Navigation completed', { url: currentUrl, waitUntil });
      return ok(currentUrl);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Navigation failed';
      if (message.includes('Timed out') || message.includes('timed out')) {
        return err({ code: ErrorCode.TIMEOUT, message });
      }
      this.logger.error('navigate failed', { url, error: message });
      return err({ code: ErrorCode.NAVIGATION_FAILED, message });
    }
  }

  async waitForLoad(
    waitUntil?: WaitUntilCondition,
    timeout?: number,
  ): Promise<Result<void, ErrorResponse>> {
    const effectiveTimeout = timeout ?? DEFAULT_NAVIGATION_TIMEOUT;

    try {
      await this.sendCdpCommandRaw('Page.enable');

      const eventName = waitUntil === 'domcontentloaded'
        ? 'Page.domContentEventFired'
        : 'Page.loadEventFired';

      await this.waitForEvent(eventName, effectiveTimeout);
      return ok(undefined);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Wait for load failed';
      if (message.includes('Timed out')) {
        return err({ code: ErrorCode.TIMEOUT, message });
      }
      return err({ code: ErrorCode.UNKNOWN, message });
    }
  }

  async goBack(): Promise<Result<string, ErrorResponse>> {
    try {
      const history = await this.sendCdpCommandRaw<{
        currentIndex: number;
        entries: readonly { url: string; id: number }[];
      }>('Page.getNavigationHistory');

      if (history.currentIndex <= 0) {
        return err({ code: ErrorCode.NAVIGATION_FAILED, message: 'No history entry to go back to' });
      }

      const prevEntry = history.entries[history.currentIndex - 1]!;
      await this.sendCdpCommandRaw('Page.navigateToHistoryEntry', { entryId: prevEntry.id });
      return ok(prevEntry.url);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Go back failed';
      return err({ code: ErrorCode.NAVIGATION_FAILED, message });
    }
  }

  async goForward(): Promise<Result<string, ErrorResponse>> {
    try {
      const history = await this.sendCdpCommandRaw<{
        currentIndex: number;
        entries: readonly { url: string; id: number }[];
      }>('Page.getNavigationHistory');

      if (history.currentIndex >= history.entries.length - 1) {
        return err({ code: ErrorCode.NAVIGATION_FAILED, message: 'No history entry to go forward to' });
      }

      const nextEntry = history.entries[history.currentIndex + 1]!;
      await this.sendCdpCommandRaw('Page.navigateToHistoryEntry', { entryId: nextEntry.id });
      return ok(nextEntry.url);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Go forward failed';
      return err({ code: ErrorCode.NAVIGATION_FAILED, message });
    }
  }

  async reload(): Promise<Result<string, ErrorResponse>> {
    try {
      await this.sendCdpCommandRaw('Page.enable');

      const loadPromise = this.waitForEvent('Page.loadEventFired', DEFAULT_NAVIGATION_TIMEOUT);
      await this.sendCdpCommandRaw('Page.reload');
      await loadPromise;

      const currentUrl = await this.evaluateJsValue<string>('window.location.href');
      return ok(currentUrl);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Reload failed';
      return err({ code: ErrorCode.NAVIGATION_FAILED, message });
    }
  }

  // -- DOM Interaction -------------------------------------------------------

  async click(options: ClickOptions): Promise<Result<void, ErrorResponse>> {
    const { selector, x: rawX, y: rawY, button = 'left', clickCount = 1 } = options;

    try {
      // Coordinate-based click via CDP Input.dispatchMouseEvent
      if (rawX !== undefined && rawY !== undefined && !selector) {
        if (!this.ws) {
          return err({ code: ErrorCode.NOT_CONNECTED, message: 'Not connected to a remote browser' });
        }
        for (let i = 0; i < clickCount; i++) {
          await this.sendCdpCommandRaw('Input.dispatchMouseEvent', {
            type: 'mousePressed', x: rawX, y: rawY, button, clickCount: i + 1,
          });
          await this.sendCdpCommandRaw('Input.dispatchMouseEvent', {
            type: 'mouseReleased', x: rawX, y: rawY, button, clickCount: i + 1,
          });
        }
        this.logger.debug('click (coordinate) completed', { x: rawX, y: rawY });
        return ok(undefined);
      }

      const exists = await this.evaluateJsValue<boolean>(
        `!!document.querySelector(${JSON.stringify(selector)})`,
      );

      if (!exists) {
        return err({
          code: ErrorCode.ELEMENT_NOT_FOUND,
          message: `No element found for selector: ${selector}`,
        });
      }

      const buttonIndex = button === 'right' ? 2 : button === 'middle' ? 1 : 0;

      await this.evaluateJsValue<void>(
        `(() => {
          const el = document.querySelector(${JSON.stringify(selector)});
          if (!el) throw new Error('Element not found');
          el.scrollIntoViewIfNeeded ? el.scrollIntoViewIfNeeded() : el.scrollIntoView();
          const rect = el.getBoundingClientRect();
          const x = rect.left + rect.width / 2;
          const y = rect.top + rect.height / 2;
          for (let i = 0; i < ${clickCount}; i++) {
            el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: ${buttonIndex}, clientX: x, clientY: y }));
            el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: ${buttonIndex}, clientX: x, clientY: y }));
            el.dispatchEvent(new MouseEvent('click', { bubbles: true, button: ${buttonIndex}, clientX: x, clientY: y }));
          }
        })()`,
      );

      this.logger.debug('click completed', { selector });
      return ok(undefined);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Click failed';
      return err({ code: ErrorCode.UNKNOWN, message });
    }
  }

  async type(options: TypeOptions): Promise<Result<void, ErrorResponse>> {
    const { selector, text, clearFirst = false } = options;

    try {
      const exists = await this.evaluateJsValue<boolean>(
        `!!document.querySelector(${JSON.stringify(selector)})`,
      );

      if (!exists) {
        return err({
          code: ErrorCode.ELEMENT_NOT_FOUND,
          message: `No element found for selector: ${selector}`,
        });
      }

      await this.evaluateJsValue<void>(
        `(() => {
          const el = document.querySelector(${JSON.stringify(selector)});
          if (!el) throw new Error('Element not found');
          el.focus();
          ${clearFirst ? `
          if ('value' in el) {
            el.value = '';
            el.dispatchEvent(new Event('input', { bubbles: true }));
          }` : ''}
          const text = ${JSON.stringify(text)};
          if ('value' in el) {
            el.value += text;
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
          } else {
            document.execCommand('insertText', false, text);
          }
        })()`,
      );

      this.logger.debug('type completed', { selector });
      return ok(undefined);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Type failed';
      return err({ code: ErrorCode.UNKNOWN, message });
    }
  }

  async hover(options: HoverOptions): Promise<Result<void, ErrorResponse>> {
    const { selector } = options;

    try {
      const exists = await this.evaluateJsValue<boolean>(
        `!!document.querySelector(${JSON.stringify(selector)})`,
      );

      if (!exists) {
        return err({
          code: ErrorCode.ELEMENT_NOT_FOUND,
          message: `No element found for selector: ${selector}`,
        });
      }

      await this.evaluateJsValue<void>(
        `(() => {
          const el = document.querySelector(${JSON.stringify(selector)});
          if (!el) throw new Error('Element not found');
          const rect = el.getBoundingClientRect();
          const x = rect.left + rect.width / 2;
          const y = rect.top + rect.height / 2;
          el.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true, clientX: x, clientY: y }));
          el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, clientX: x, clientY: y }));
          el.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: x, clientY: y }));
        })()`,
      );

      this.logger.debug('hover completed', { selector });
      return ok(undefined);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Hover failed';
      return err({ code: ErrorCode.UNKNOWN, message });
    }
  }

  async scroll(options: ScrollOptions): Promise<Result<void, ErrorResponse>> {
    const { selector, x = 0, y = 0, behavior = 'auto' } = options;

    try {
      if (selector) {
        const exists = await this.evaluateJsValue<boolean>(
          `!!document.querySelector(${JSON.stringify(selector)})`,
        );

        if (!exists) {
          return err({
            code: ErrorCode.ELEMENT_NOT_FOUND,
            message: `No element found for selector: ${selector}`,
          });
        }

        await this.evaluateJsValue<void>(
          `document.querySelector(${JSON.stringify(selector)}).scrollBy({ left: ${x}, top: ${y}, behavior: ${JSON.stringify(behavior)} })`,
        );
      } else {
        await this.evaluateJsValue<void>(
          `window.scrollBy({ left: ${x}, top: ${y}, behavior: ${JSON.stringify(behavior)} })`,
        );
      }

      this.logger.debug('scroll completed', { selector, x, y });
      return ok(undefined);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Scroll failed';
      return err({ code: ErrorCode.UNKNOWN, message });
    }
  }

  async select(options: SelectOptions): Promise<Result<readonly string[], ErrorResponse>> {
    const { selector, value, values, label, index } = options;

    try {
      const result = await this.evaluateJsValue<string[]>(
        `(() => {
          const el = document.querySelector(${JSON.stringify(selector)});
          if (!el || el.tagName !== 'SELECT') throw new Error('Select element not found');

          const selected = [];
          const opts = Array.from(el.options);

          for (const opt of opts) { opt.selected = false; }

          if (${index !== undefined ? 'true' : 'false'}) {
            if (opts[${index ?? 0}]) {
              opts[${index ?? 0}].selected = true;
              selected.push(opts[${index ?? 0}].value);
            }
          } else if (${label !== undefined ? 'true' : 'false'}) {
            const lbl = ${JSON.stringify(label ?? '')};
            for (const opt of opts) {
              if (opt.text === lbl || opt.label === lbl) {
                opt.selected = true;
                selected.push(opt.value);
                break;
              }
            }
          } else if (${values !== undefined ? 'true' : 'false'}) {
            const vals = ${JSON.stringify(values ?? [])};
            for (const opt of opts) {
              if (vals.includes(opt.value)) {
                opt.selected = true;
                selected.push(opt.value);
              }
            }
          } else if (${value !== undefined ? 'true' : 'false'}) {
            el.value = ${JSON.stringify(value ?? '')};
            selected.push(el.value);
          }

          el.dispatchEvent(new Event('change', { bubbles: true }));
          return selected;
        })()`,
      );

      this.logger.debug('select completed', { selector });
      return ok(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Select failed';
      return err({ code: ErrorCode.UNKNOWN, message });
    }
  }

  async focus(options: FocusOptions): Promise<Result<void, ErrorResponse>> {
    const { selector } = options;

    try {
      const exists = await this.evaluateJsValue<boolean>(
        `!!document.querySelector(${JSON.stringify(selector)})`,
      );

      if (!exists) {
        return err({
          code: ErrorCode.ELEMENT_NOT_FOUND,
          message: `No element found for selector: ${selector}`,
        });
      }

      await this.evaluateJsValue<void>(
        `document.querySelector(${JSON.stringify(selector)}).focus()`,
      );

      this.logger.debug('focus completed', { selector });
      return ok(undefined);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Focus failed';
      return err({ code: ErrorCode.UNKNOWN, message });
    }
  }

  async getAttribute(options: GetAttributeOptions): Promise<Result<string | null, ErrorResponse>> {
    const { selector, attribute } = options;

    try {
      const result = await this.evaluateJsValue<string | null>(
        `(() => {
          const el = document.querySelector(${JSON.stringify(selector)});
          if (!el) throw new Error('Element not found');
          return el.getAttribute(${JSON.stringify(attribute)});
        })()`,
      );

      return ok(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'getAttribute failed';
      if (message.includes('Element not found')) {
        return err({ code: ErrorCode.ELEMENT_NOT_FOUND, message });
      }
      return err({ code: ErrorCode.UNKNOWN, message });
    }
  }

  async getProperty(options: GetPropertyOptions): Promise<Result<unknown, ErrorResponse>> {
    const { selector, property } = options;

    try {
      const result = await this.evaluateJsValue(
        `(() => {
          const el = document.querySelector(${JSON.stringify(selector)});
          if (!el) throw new Error('Element not found');
          return el[${JSON.stringify(property)}];
        })()`,
      );

      return ok(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'getProperty failed';
      if (message.includes('Element not found')) {
        return err({ code: ErrorCode.ELEMENT_NOT_FOUND, message });
      }
      return err({ code: ErrorCode.UNKNOWN, message });
    }
  }

  // -- Tab Management --------------------------------------------------------

  async createTab(options?: CreateTabOptions): Promise<Result<TabInfo, ErrorResponse>> {
    try {
      const url = options?.url ?? 'about:blank';
      const result = await this.sendCdpCommandRaw<CdpCreateTargetResponse>(
        'Target.createTarget',
        { url },
      );

      const numId = this.getNumericTabId(result.targetId);

      const tabInfo: TabInfo = {
        tabId: numId,
        url,
        title: '',
        active: options?.active ?? true,
        windowId: 0,
      };

      this.logger.debug('Tab created', { tabId: numId, targetId: result.targetId });
      return ok(tabInfo);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to create tab';
      this.logger.error('createTab failed', { error: message });
      return err({ code: ErrorCode.UNKNOWN, message });
    }
  }

  async closeTab(tabId: number): Promise<Result<void, ErrorResponse>> {
    const targetId = this.getTargetId(tabId);
    if (!targetId) {
      return err({ code: ErrorCode.TAB_NOT_FOUND, message: `No target found for tab ID: ${tabId}` });
    }

    try {
      await this.sendCdpCommandRaw('Target.closeTarget', { targetId });
      for (const context of this.isolatedBrowserContexts.values()) {
        context.tabIds.delete(tabId);
      }
      const sessionId = this.targetSessionIds.get(targetId);
      if (sessionId === this.activeTargetSessionId) {
        this.activeTargetSessionId = undefined;
      }
      this.targetSessionIds.delete(targetId);
      this.targetIdMap.delete(targetId);
      this.numericIdMap.delete(tabId);
      this.logger.debug('Tab closed', { tabId, targetId });
      return ok(undefined);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to close tab';
      this.logger.error('closeTab failed', { tabId, error: message });
      return err({ code: ErrorCode.TAB_NOT_FOUND, message });
    }
  }

  async switchTab(tabId: number): Promise<Result<void, ErrorResponse>> {
    const targetId = this.getTargetId(tabId);
    if (!targetId) {
      return err({ code: ErrorCode.TAB_NOT_FOUND, message: `No target found for tab ID: ${tabId}` });
    }

    try {
      await this.sendCdpCommandRaw('Target.activateTarget', { targetId });
      this.logger.debug('Tab switched', { tabId, targetId });
      return ok(undefined);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to switch tab';
      this.logger.error('switchTab failed', { tabId, error: message });
      return err({ code: ErrorCode.TAB_NOT_FOUND, message });
    }
  }

  async listTabs(): Promise<Result<readonly TabInfo[], ErrorResponse>> {
    try {
      const result = await this.sendCdpCommandRaw<CdpTargetsResponse>('Target.getTargets');

      const tabs: TabInfo[] = result.targetInfos
        .filter((t) => t.type === 'page')
        .map((t) => {
          const numId = this.getNumericTabId(t.targetId);
          return {
            tabId: numId,
            url: t.url,
            title: t.title,
            active: t.attached,
            windowId: 0,
          };
        });

      return ok(tabs);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to list tabs';
      this.logger.error('listTabs failed', { error: message });
      return err({ code: ErrorCode.UNKNOWN, message });
    }
  }

  async getActiveTab(): Promise<Result<TabInfo, ErrorResponse>> {
    try {
      const result = await this.sendCdpCommandRaw<CdpTargetsResponse>('Target.getTargets');

      const attached = result.targetInfos.find((t) => t.type === 'page' && t.attached);
      if (!attached) {
        return err({ code: ErrorCode.TAB_NOT_FOUND, message: 'No active tab found' });
      }

      const numId = this.getNumericTabId(attached.targetId);
      return ok({
        tabId: numId,
        url: attached.url,
        title: attached.title,
        active: true,
        windowId: 0,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to get active tab';
      return err({ code: ErrorCode.TAB_NOT_FOUND, message });
    }
  }

  // -- Dialog Handling -------------------------------------------------------

  async handleDialog(options: HandleDialogOptions): Promise<Result<void, ErrorResponse>> {
    try {
      await this.sendCdpCommandRaw('Page.handleJavaScriptDialog', {
        accept: options.accept,
        promptText: options.promptText,
      });
      this.currentDialog = null;
      this.logger.debug('Dialog handled', { accept: options.accept });
      return ok(undefined);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to handle dialog';
      return err({ code: ErrorCode.DIALOG_NOT_FOUND, message });
    }
  }

  async getDialogInfo(): Promise<Result<DialogInfo | null, ErrorResponse>> {
    return ok(this.currentDialog);
  }

  // -- Screenshot ------------------------------------------------------------

  async captureScreenshot(
    options?: ScreenshotOptions,
  ): Promise<Result<ScreenshotResult, ErrorResponse>> {
    if (options?.fullPage) {
      return this.captureFullPageScreenshot(options);
    }

    const format = options?.format ?? DEFAULT_SCREENSHOT_FORMAT;
    const quality = format === 'png' ? undefined : (options?.quality ?? DEFAULT_SCREENSHOT_QUALITY);

    try {
      const cdpParams: Record<string, unknown> = {
        format: format === 'jpeg' ? 'jpeg' : format === 'webp' ? 'webp' : 'png',
      };
      if (quality !== undefined) {
        cdpParams.quality = quality;
      }

      if (options?.selector) {
        const clip = await this.evaluateJsValue<{ x: number; y: number; width: number; height: number }>(
          `(() => {
            const el = document.querySelector(${JSON.stringify(options.selector)});
            if (!el) throw new Error('Element not found');
            const rect = el.getBoundingClientRect();
            return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
          })()`,
        );
        cdpParams.clip = { ...clip, scale: 1 };
      }

      const result = await this.sendCdpCommandRaw<CdpScreenshotResponse>(
        'Page.captureScreenshot',
        cdpParams,
      );

      this.logger.debug('Screenshot captured', { format });
      return ok({
        data: result.data,
        mimeType: toMimeType(format),
        width: 0,
        height: 0,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Screenshot capture failed';
      this.logger.error('captureScreenshot failed', { error: message });
      return err({ code: ErrorCode.SCREENSHOT_FAILED, message });
    }
  }

  async captureFullPageScreenshot(
    options?: Omit<ScreenshotOptions, 'fullPage' | 'selector'>,
  ): Promise<Result<ScreenshotResult, ErrorResponse>> {
    const format = options?.format ?? DEFAULT_SCREENSHOT_FORMAT;
    const quality = format === 'png' ? undefined : (options?.quality ?? DEFAULT_SCREENSHOT_QUALITY);

    try {
      const cdpParams: Record<string, unknown> = {
        format: format === 'jpeg' ? 'jpeg' : format === 'webp' ? 'webp' : 'png',
        captureBeyondViewport: true,
      };
      if (quality !== undefined) {
        cdpParams.quality = quality;
      }

      const result = await this.sendCdpCommandRaw<CdpScreenshotResponse>(
        'Page.captureScreenshot',
        cdpParams,
      );

      this.logger.debug('Full-page screenshot captured', { format });
      return ok({
        data: result.data,
        mimeType: toMimeType(format),
        width: 0,
        height: 0,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Full-page screenshot failed';
      this.logger.error('captureFullPageScreenshot failed', { error: message });
      return err({ code: ErrorCode.SCREENSHOT_FAILED, message });
    }
  }

  // -- Accessibility ---------------------------------------------------------

  async getAccessibilityTree(): Promise<Result<AccessibilityNode, ErrorResponse>> {
    // Strategy 1 (preferred): DOM-walking via Runtime.evaluate.
    // This eliminates Chrome-internal pseudo-nodes (InlineTextBox, StaticText)
    // that bloat the tree without adding value for agent consumption.
    try {
      const walkerResult = await this.evaluateJsValue<{ tree: AccessibilityNode; nodeCount: number }>(
        getDomWalkerScript(),
      );

      if (walkerResult?.tree) {
        this.logger.debug('Accessibility tree extracted via DOM walking', {
          nodeCount: walkerResult.nodeCount,
        });
        return ok(walkerResult.tree);
      }

      this.logger.warn('DOM walking returned empty tree, falling back to CDP');
    } catch (domError) {
      this.logger.warn('DOM walking failed, falling back to CDP', {
        error: domError instanceof Error ? domError.message : String(domError),
      });
    }

    // Strategy 2 (fallback): CDP Accessibility.getFullAXTree
    try {
      await this.sendCdpCommandRaw('Accessibility.enable');
      const axTree = await this.sendCdpCommandRaw<CdpAXTreeResponse>(
        'Accessibility.getFullAXTree',
      );

      const tree = this.buildTreeFromCdpNodes(axTree.nodes);
      this.logger.debug('Accessibility tree extracted via CDP', { nodeCount: axTree.nodes.length });
      return ok(tree);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Accessibility tree extraction failed';
      this.logger.error('getAccessibilityTree failed', { error: message });
      return err({ code: ErrorCode.UNKNOWN, message });
    }
  }

  private buildTreeFromCdpNodes(
    nodes: readonly CdpAXNode[],
  ): AccessibilityNode {
    if (nodes.length === 0) {
      return { role: 'document', name: '', children: [] };
    }

    const nodeMap = new Map<string, CdpAXNode>();
    for (const node of nodes) {
      nodeMap.set(node.nodeId, node);
    }

    const convertNode = (cdpNode: CdpAXNode): AccessibilityNode => {
      const children: AccessibilityNode[] = [];
      if (cdpNode.childIds) {
        for (const childId of cdpNode.childIds) {
          const childCdp = nodeMap.get(childId);
          if (childCdp && !childCdp.ignored) {
            children.push(convertNode(childCdp));
          }
        }
      }

      return {
        role: cdpNode.role?.value ?? 'none',
        name: cdpNode.name?.value ?? '',
        ...(cdpNode.value?.value ? { value: cdpNode.value.value } : {}),
        ...(cdpNode.description?.value ? { description: cdpNode.description.value } : {}),
        ...(children.length > 0 ? { children } : {}),
      };
    };

    const rootNode = nodes[0];
    return rootNode ? convertNode(rootNode) : { role: 'document', name: '', children: [] };
  }

  // -- HTML Content ----------------------------------------------------------

  async getPageContent(): Promise<Result<string, ErrorResponse>> {
    try {
      const html = await this.evaluateJsValue<string>('document.documentElement.outerHTML');
      this.logger.debug('getPageContent completed', { length: html.length });
      return ok(html);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to get page content';
      return err({ code: ErrorCode.UNKNOWN, message });
    }
  }

  async getOuterHtml(selector: string): Promise<Result<string, ErrorResponse>> {
    try {
      const html = await this.evaluateJsValue<string | null>(
        `(() => {
          const el = document.querySelector(${JSON.stringify(selector)});
          return el ? el.outerHTML : null;
        })()`,
      );

      if (html === null) {
        return err({
          code: ErrorCode.ELEMENT_NOT_FOUND,
          message: `No element found for selector: ${selector}`,
        });
      }

      return ok(html);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to get outer HTML';
      return err({ code: ErrorCode.UNKNOWN, message });
    }
  }

  async getInnerHtml(selector: string): Promise<Result<string, ErrorResponse>> {
    try {
      const html = await this.evaluateJsValue<string | null>(
        `(() => {
          const el = document.querySelector(${JSON.stringify(selector)});
          return el ? el.innerHTML : null;
        })()`,
      );

      if (html === null) {
        return err({
          code: ErrorCode.ELEMENT_NOT_FOUND,
          message: `No element found for selector: ${selector}`,
        });
      }

      return ok(html);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to get inner HTML';
      return err({ code: ErrorCode.UNKNOWN, message });
    }
  }

  // -- DOM Querying ----------------------------------------------------------

  async querySelector(options: QuerySelectorOptions): Promise<Result<DomElementInfo | null, ErrorResponse>> {
    try {
      const result = await this.evaluateJsValue<DomElementInfo | null>(
        `(() => {
          const el = document.querySelector(${JSON.stringify(options.selector)});
          if (!el) return null;
          const attrs = {};
          for (const attr of el.attributes) { attrs[attr.name] = attr.value; }
          return {
            tagName: el.tagName.toLowerCase(),
            attributes: attrs,
            textContent: el.textContent || '',
            innerHtml: el.innerHTML,
            outerHtml: el.outerHTML,
          };
        })()`,
      );

      return ok(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'querySelector failed';
      return err({ code: ErrorCode.UNKNOWN, message });
    }
  }

  async querySelectorAll(options: QuerySelectorAllOptions): Promise<Result<readonly DomElementInfo[], ErrorResponse>> {
    const limit = options.limit ?? DEFAULT_QUERY_LIMIT;

    try {
      const result = await this.evaluateJsValue<DomElementInfo[]>(
        `(() => {
          const els = Array.from(document.querySelectorAll(${JSON.stringify(options.selector)})).slice(0, ${limit});
          return els.map(el => {
            const attrs = {};
            for (const attr of el.attributes) { attrs[attr.name] = attr.value; }
            return {
              tagName: el.tagName.toLowerCase(),
              attributes: attrs,
              textContent: el.textContent || '',
              innerHtml: el.innerHTML,
              outerHtml: el.outerHTML,
            };
          });
        })()`,
      );

      return ok(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'querySelectorAll failed';
      return err({ code: ErrorCode.UNKNOWN, message });
    }
  }

  async getAttributes(selector: string): Promise<Result<Readonly<Record<string, string>>, ErrorResponse>> {
    try {
      const result = await this.evaluateJsValue<Record<string, string> | null>(
        `(() => {
          const el = document.querySelector(${JSON.stringify(selector)});
          if (!el) return null;
          const attrs = {};
          for (const attr of el.attributes) { attrs[attr.name] = attr.value; }
          return attrs;
        })()`,
      );

      if (result === null) {
        return err({
          code: ErrorCode.ELEMENT_NOT_FOUND,
          message: `No element found for selector: ${selector}`,
        });
      }

      return ok(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to get attributes';
      return err({ code: ErrorCode.UNKNOWN, message });
    }
  }

  // -- Script Execution ------------------------------------------------------

  async executeScript(options: ExecuteScriptOptions): Promise<Result<unknown, ErrorResponse>> {
    const timeout = options.timeout ?? DEFAULT_SCRIPT_TIMEOUT;

    try {
      const serialisedArgs = JSON.stringify(options.args ?? []);
      const expression =
        `(async () => {\n` +
        `  const args = ${serialisedArgs};\n` +
        `  ${options.script}\n` +
        `})()`;

      const evaluatePromise = this.evaluateJs(expression, true, true);

      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(
          () => { reject(new Error(`Script execution timed out after ${timeout}ms`)); },
          timeout,
        ),
      );

      const response = await Promise.race([evaluatePromise, timeoutPromise]);

      if (response.exceptionDetails) {
        const errorMessage =
          response.exceptionDetails.exception?.description ??
          response.exceptionDetails.text;
        return err({
          code: ErrorCode.SCRIPT_EXECUTION_FAILED,
          message: errorMessage,
        });
      }

      const value = response.result.value ?? null;
      this.logger.debug('executeScript completed');
      return ok(value);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Script execution failed';
      if (message.includes('timed out')) {
        return err({ code: ErrorCode.TIMEOUT, message });
      }
      return err({ code: ErrorCode.SCRIPT_EXECUTION_FAILED, message });
    }
  }

  async evaluateExpression(options: EvaluateExpressionOptions): Promise<Result<unknown, ErrorResponse>> {
    const timeout = options.timeout ?? DEFAULT_SCRIPT_TIMEOUT;

    try {
      const evaluatePromise = this.evaluateJs(options.expression, true, true);

      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(
          () => { reject(new Error(`Expression evaluation timed out after ${timeout}ms`)); },
          timeout,
        ),
      );

      const response = await Promise.race([evaluatePromise, timeoutPromise]);

      if (response.exceptionDetails) {
        const errorMessage =
          response.exceptionDetails.exception?.description ??
          response.exceptionDetails.text;
        return err({
          code: ErrorCode.SCRIPT_EXECUTION_FAILED,
          message: errorMessage,
        });
      }

      return ok(response.result.value ?? null);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Expression evaluation failed';
      if (message.includes('timed out')) {
        return err({ code: ErrorCode.TIMEOUT, message });
      }
      return err({ code: ErrorCode.SCRIPT_EXECUTION_FAILED, message });
    }
  }

  // -- Console Command -------------------------------------------------------

  async executeConsoleCommand(options: ConsoleCommandOptions): Promise<Result<unknown, ErrorResponse>> {
    const timeout = options.timeout ?? DEFAULT_SCRIPT_TIMEOUT;

    try {
      const consoleEntries: Array<{ level: string; args: unknown[]; timestamp: number }> = [];

      const consoleListener: CdpEventListener = (method, params) => {
        if (method === 'Runtime.consoleAPICalled' && params) {
          const type = params.type as string;
          const args = (params.args as Array<{ type: string; value?: unknown; description?: string }>)
            .map((arg) => arg.value !== undefined ? arg.value : arg.description ?? `[${arg.type}]`);
          consoleEntries.push({
            level: type === 'warning' ? 'warn' : type,
            args,
            timestamp: params.timestamp as number,
          });
        }
      };

      this.eventListeners.push(consoleListener);

      try {
        await this.sendCdpCommandRaw('Runtime.enable');

        const evaluatePromise = this.sendCdpCommandRaw<CdpEvaluateResponse>(
          'Runtime.evaluate',
          {
            expression: options.command,
            includeCommandLineAPI: true,
            returnByValue: true,
            awaitPromise: true,
          },
        );

        const timeoutPromise = new Promise<never>((_, reject) =>
          setTimeout(
            () => { reject(new Error(`Console command timed out after ${timeout}ms`)); },
            timeout,
          ),
        );

        const response = await Promise.race([evaluatePromise, timeoutPromise]);

        if (response.exceptionDetails) {
          const errorMessage =
            response.exceptionDetails.exception?.description ??
            response.exceptionDetails.text;
          return err({
            code: ErrorCode.SCRIPT_EXECUTION_FAILED,
            message: errorMessage,
          });
        }

        this.logger.debug('executeConsoleCommand completed', {
          consoleEntries: consoleEntries.length,
        });

        return ok({
          returnValue: response.result.value ?? null,
          consoleOutput: consoleEntries,
        });
      } finally {
        const idx = this.eventListeners.indexOf(consoleListener);
        if (idx >= 0) this.eventListeners.splice(idx, 1);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Console command execution failed';
      if (message.includes('timed out')) {
        return err({ code: ErrorCode.TIMEOUT, message });
      }
      return err({ code: ErrorCode.SCRIPT_EXECUTION_FAILED, message });
    }
  }

  async executeScriptFile(options: ExecuteScriptFileOptions): Promise<Result<unknown, ErrorResponse>> {
    const timeout = options.timeout ?? DEFAULT_SCRIPT_TIMEOUT;
    const fileUrl = JSON.stringify(options.file);
    const expression =
      `(async () => {\n` +
      `  const response = await fetch(${fileUrl});\n` +
      `  if (!response.ok) throw new Error('Failed to load script file: ' + response.status + ' ' + response.statusText + ' for ' + ${fileUrl});\n` +
      `  const scriptContent = await response.text();\n` +
      `  return (0, eval)(scriptContent);\n` +
      `})()`;

    try {
      const result = await withTimeout(
        this.evaluateJsValue(expression, true),
        timeout,
        `Script file execution timed out after ${String(timeout)}ms`,
      );
      this.logger.debug('executeScriptFile completed', { file: options.file });
      return ok(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Script file execution failed';
      return err({
        code: message.includes('timed out') ? ErrorCode.TIMEOUT : ErrorCode.SCRIPT_EXECUTION_FAILED,
        message,
      });
    }
  }

  async executeValidation(options: ExecuteValidationOptions): Promise<Result<ValidationResult, ErrorResponse>> {
    const timeout = options.timeout ?? DEFAULT_SCRIPT_TIMEOUT;
    const expression =
      `(async () => {\n` +
      `  const assertions = [];\n` +
      `  function assert(name, condition, message) {\n` +
      `    assertions.push({ name, status: condition ? 'passed' : 'failed', message: message || (condition ? 'Passed' : 'Failed') });\n` +
      `  }\n` +
      `  function skip(name, message) {\n` +
      `    assertions.push({ name, status: 'skipped', message: message || 'Skipped' });\n` +
      `  }\n` +
      `  try {\n` +
      `    ${options.script}\n` +
      `  } catch (error) {\n` +
      `    assertions.push({ name: 'Uncaught error', status: 'failed', message: error instanceof Error ? error.message : String(error) });\n` +
      `  }\n` +
      `  return {\n` +
      `    passed: assertions.filter((item) => item.status === 'passed').length,\n` +
      `    failed: assertions.filter((item) => item.status === 'failed').length,\n` +
      `    skipped: assertions.filter((item) => item.status === 'skipped').length,\n` +
      `    assertions,\n` +
      `  };\n` +
      `})()`;

    try {
      const result = await withTimeout(
        this.evaluateJsValue<ValidationResult>(expression, true),
        timeout,
        `Validation execution timed out after ${String(timeout)}ms`,
      );
      this.logger.debug('executeValidation completed', {
        passed: result.passed,
        failed: result.failed,
        skipped: result.skipped,
      });
      return ok(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Validation execution failed';
      return err({
        code: message.includes('timed out') ? ErrorCode.TIMEOUT : ErrorCode.SCRIPT_EXECUTION_FAILED,
        message,
      });
    }
  }

  // -- Content Script Injection ----------------------------------------------

  async injectScript(options: InjectScriptOptions): Promise<Result<unknown, ErrorResponse>> {
    try {
      if (options.code) {
        const result = await this.evaluateJsValue(options.code);
        return ok(result);
      }

      if (options.file) {
        const result = await this.evaluateJsValue(
          `(() => {
            const script = document.createElement('script');
            script.src = ${JSON.stringify(options.file)};
            document.head.appendChild(script);
            return true;
          })()`,
        );
        return ok(result);
      }

      return err({
        code: ErrorCode.UNKNOWN,
        message: 'Either code or file must be provided',
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Script injection failed';
      return err({ code: ErrorCode.INJECTION_FAILED, message });
    }
  }

  async removeScript(options: RemoveScriptOptions): Promise<Result<void, ErrorResponse>> {
    try {
      await this.evaluateJsValue<void>(
        `(() => {
          const el = document.getElementById(${JSON.stringify(options.scriptId)});
          if (el) el.remove();
        })()`,
      );
      return ok(undefined);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Script removal failed';
      return err({ code: ErrorCode.UNKNOWN, message });
    }
  }

  // -- CDP -------------------------------------------------------------------

  async sendCdpCommand(options: CdpCommandOptions): Promise<Result<unknown, ErrorResponse>> {
    if (!this.connected) {
      return err({
        code: ErrorCode.NOT_CONNECTED,
        message: 'Not connected to remote browser',
      });
    }

    try {
      const result = await this.sendCdpCommandRaw(options.method, options.params);
      return ok(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'CDP command failed';
      return err({ code: ErrorCode.CDP_ERROR, message });
    }
  }

  attachDebugger: IBrowserAdapter['attachDebugger'] = () =>
    Promise.resolve(ok(undefined));

  detachDebugger: IBrowserAdapter['detachDebugger'] = () =>
    Promise.resolve(ok(undefined));

  // -- Live HTML Modification ------------------------------------------------

  async setOuterHtml(options: SetOuterHtmlOptions): Promise<Result<void, ErrorResponse>> {
    try {
      await this.evaluateJsValue<void>(
        `(() => {
          const el = document.querySelector(${JSON.stringify(options.selector)});
          if (!el) throw new Error('Element not found');
          el.outerHTML = ${JSON.stringify(options.html)};
        })()`,
      );
      return ok(undefined);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'setOuterHtml failed';
      if (message.includes('Element not found')) {
        return err({ code: ErrorCode.ELEMENT_NOT_FOUND, message });
      }
      return err({ code: ErrorCode.UNKNOWN, message });
    }
  }

  async setInnerHtml(options: SetInnerHtmlOptions): Promise<Result<void, ErrorResponse>> {
    try {
      await this.evaluateJsValue<void>(
        `(() => {
          const el = document.querySelector(${JSON.stringify(options.selector)});
          if (!el) throw new Error('Element not found');
          el.innerHTML = ${JSON.stringify(options.html)};
        })()`,
      );
      return ok(undefined);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'setInnerHtml failed';
      if (message.includes('Element not found')) {
        return err({ code: ErrorCode.ELEMENT_NOT_FOUND, message });
      }
      return err({ code: ErrorCode.UNKNOWN, message });
    }
  }

  async insertAdjacentHtml(options: InsertAdjacentHtmlOptions): Promise<Result<void, ErrorResponse>> {
    try {
      await this.evaluateJsValue<void>(
        `(() => {
          const el = document.querySelector(${JSON.stringify(options.selector)});
          if (!el) throw new Error('Element not found');
          el.insertAdjacentHTML(${JSON.stringify(options.position)}, ${JSON.stringify(options.html)});
        })()`,
      );
      return ok(undefined);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'insertAdjacentHtml failed';
      if (message.includes('Element not found')) {
        return err({ code: ErrorCode.ELEMENT_NOT_FOUND, message });
      }
      return err({ code: ErrorCode.UNKNOWN, message });
    }
  }

  // -- Live CSS Modification -------------------------------------------------

  async addStyleSheet(options: AddStyleSheetOptions): Promise<Result<string, ErrorResponse>> {
    try {
      const styleId = await this.evaluateJsValue<string>(
        `(() => {
          const style = document.createElement('style');
          style.id = 'agentic-style-' + Date.now();
          style.textContent = ${JSON.stringify(options.css)};
          document.head.appendChild(style);
          return style.id;
        })()`,
      );
      return ok(styleId);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'addStyleSheet failed';
      return err({ code: ErrorCode.STYLE_ERROR, message });
    }
  }

  async modifyStyle(options: ModifyStyleOptions): Promise<Result<void, ErrorResponse>> {
    const stylesJson = JSON.stringify(options.styles);

    try {
      await this.evaluateJsValue<void>(
        `(() => {
          const el = document.querySelector(${JSON.stringify(options.selector)});
          if (!el) throw new Error('Element not found');
          const styles = ${stylesJson};
          for (const [prop, val] of Object.entries(styles)) {
            el.style[prop] = val;
          }
        })()`,
      );
      return ok(undefined);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'modifyStyle failed';
      if (message.includes('Element not found')) {
        return err({ code: ErrorCode.ELEMENT_NOT_FOUND, message });
      }
      return err({ code: ErrorCode.STYLE_ERROR, message });
    }
  }

  async getComputedStyle(options: GetComputedStyleOptions): Promise<Result<Readonly<Record<string, string>>, ErrorResponse>> {
    const propsJson = JSON.stringify(options.properties ?? []);

    try {
      const result = await this.evaluateJsValue<Record<string, string>>(
        `(() => {
          const el = document.querySelector(${JSON.stringify(options.selector)});
          if (!el) throw new Error('Element not found');
          const computed = window.getComputedStyle(el);
          const props = ${propsJson};
          const result = {};
          if (props.length > 0) {
            for (const p of props) { result[p] = computed.getPropertyValue(p); }
          } else {
            for (let i = 0; i < computed.length; i++) {
              const name = computed[i];
              result[name] = computed.getPropertyValue(name);
            }
          }
          return result;
        })()`,
      );
      return ok(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'getComputedStyle failed';
      if (message.includes('Element not found')) {
        return err({ code: ErrorCode.ELEMENT_NOT_FOUND, message });
      }
      return err({ code: ErrorCode.STYLE_ERROR, message });
    }
  }

  // -- Cookies ---------------------------------------------------------------

  async getCookies(options?: GetCookiesOptions): Promise<Result<readonly CookieData[], ErrorResponse>> {
    try {
      const params: Record<string, unknown> = {};
      if (options?.url) params.urls = [options.url];

      const result = await this.sendCdpCommandRaw<{ cookies: CookieData[] }>(
        'Network.getCookies',
        Object.keys(params).length > 0 ? params : undefined,
      );

      let cookies = result.cookies;

      if (options?.domain) {
        cookies = cookies.filter((c) => c.domain === options.domain || c.domain === `.${options.domain}`);
      }
      if (options?.name) {
        cookies = cookies.filter((c) => c.name === options.name);
      }

      return ok(cookies);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to get cookies';
      return err({ code: ErrorCode.COOKIE_ERROR, message });
    }
  }

  async setCookie(cookie: CookieData): Promise<Result<void, ErrorResponse>> {
    try {
      await this.sendCdpCommandRaw('Network.setCookie', {
        name: cookie.name,
        value: cookie.value,
        domain: cookie.domain,
        path: cookie.path,
        secure: cookie.secure,
        httpOnly: cookie.httpOnly,
        sameSite: cookie.sameSite,
        expires: cookie.expirationDate,
      });
      return ok(undefined);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to set cookie';
      return err({ code: ErrorCode.COOKIE_ERROR, message });
    }
  }

  // -- Wait / Polling --------------------------------------------------------

  async waitForSelector(options: WaitForSelectorOptions): Promise<Result<void, ErrorResponse>> {
    const timeout = options.timeout ?? DEFAULT_WAIT_TIMEOUT;
    const interval = DEFAULT_POLLING_INTERVAL;
    const start = Date.now();

    while (Date.now() - start < timeout) {
      try {
        const found = await this.evaluateJsValue<boolean>(
          `(() => {
            const el = document.querySelector(${JSON.stringify(options.selector)});
            if (!el) return false;
            ${options.hidden ? 'return el.offsetParent === null || window.getComputedStyle(el).display === "none";' : ''}
            ${options.visible ? 'return el.offsetParent !== null && window.getComputedStyle(el).display !== "none";' : ''}
            return true;
          })()`,
        );

        if (found) return ok(undefined);
      } catch {
        // Element not found yet
      }

      await new Promise((r) => setTimeout(r, interval));
    }

    return err({
      code: ErrorCode.TIMEOUT,
      message: `Timed out waiting for selector '${options.selector}' after ${timeout}ms`,
    });
  }

  async waitForNavigation(options?: WaitForNavigationOptions): Promise<Result<string, ErrorResponse>> {
    const timeout = options?.timeout ?? DEFAULT_NAVIGATION_TIMEOUT;
    const waitUntil = options?.waitUntil ?? 'load';

    try {
      await this.sendCdpCommandRaw('Page.enable');

      const eventName = waitUntil === 'domcontentloaded'
        ? 'Page.domContentEventFired'
        : 'Page.loadEventFired';

      await this.waitForEvent(eventName, timeout);

      const currentUrl = await this.evaluateJsValue<string>('window.location.href');
      return ok(currentUrl);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Wait for navigation failed';
      if (message.includes('Timed out')) {
        return err({ code: ErrorCode.TIMEOUT, message });
      }
      return err({ code: ErrorCode.UNKNOWN, message });
    }
  }

  async waitForCondition(options: WaitForConditionOptions): Promise<Result<void, ErrorResponse>> {
    const timeout = options.timeout ?? DEFAULT_WAIT_TIMEOUT;
    const interval = options.pollingInterval ?? DEFAULT_POLLING_INTERVAL;
    const start = Date.now();

    while (Date.now() - start < timeout) {
      try {
        const result = await this.evaluateJsValue<boolean>(options.expression);
        if (result) return ok(undefined);
      } catch {
        // Condition not met yet
      }

      await new Promise((r) => setTimeout(r, interval));
    }

    return err({
      code: ErrorCode.TIMEOUT,
      message: `Condition not met after ${timeout}ms`,
    });
  }

  // -- Touch Interactions (FR-041) -------------------------------------------

  async tap(x: number, y: number): Promise<Result<void, ErrorResponse>> {
    try {
      await this.sendCdpCommandRaw('Input.dispatchTouchEvent', {
        type: 'touchStart',
        touchPoints: [{ x, y }],
      });
      await this.sendCdpCommandRaw('Input.dispatchTouchEvent', {
        type: 'touchEnd',
        touchPoints: [],
      });
      this.logger.debug('tap completed', { x, y });
      return ok(undefined);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Tap failed';
      return err({ code: ErrorCode.UNKNOWN, message });
    }
  }

  async swipe(
    startX: number,
    startY: number,
    endX: number,
    endY: number,
    duration = 300,
  ): Promise<Result<void, ErrorResponse>> {
    try {
      const steps = 10;
      const stepDelay = duration / steps;
      const dx = (endX - startX) / steps;
      const dy = (endY - startY) / steps;

      await this.sendCdpCommandRaw('Input.dispatchTouchEvent', {
        type: 'touchStart',
        touchPoints: [{ x: startX, y: startY }],
      });

      for (let i = 1; i <= steps; i++) {
        await new Promise((r) => setTimeout(r, stepDelay));
        await this.sendCdpCommandRaw('Input.dispatchTouchEvent', {
          type: 'touchMove',
          touchPoints: [{ x: startX + dx * i, y: startY + dy * i }],
        });
      }

      await this.sendCdpCommandRaw('Input.dispatchTouchEvent', {
        type: 'touchEnd',
        touchPoints: [],
      });

      this.logger.debug('swipe completed', { startX, startY, endX, endY });
      return ok(undefined);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Swipe failed';
      return err({ code: ErrorCode.UNKNOWN, message });
    }
  }

  // -- Multi-Step Execution --------------------------------------------------

  async executeSteps(options: ExecuteStepsOptions): Promise<Result<ExecuteStepsResult, ErrorResponse>> {
    const results: Array<{
      stepIndex: number;
      action: string;
      success: boolean;
      data?: unknown;
      error?: ErrorResponse;
    }> = [];

    let completedCount = 0;

    for (let i = 0; i < options.steps.length; i++) {
      const step = options.steps[i]!;

      try {
        const method = (this as unknown as Record<string, (params: unknown) => Promise<Result<unknown, ErrorResponse>>>)[step.action];
        if (typeof method !== 'function') {
          const stepErr: ErrorResponse = {
            code: ErrorCode.UNKNOWN,
            message: `Unknown action: ${step.action}`,
          };

          results.push({
            stepIndex: i,
            action: step.action,
            success: false,
            error: stepErr,
          });

          if (options.stopOnError) break;
          continue;
        }

        const result = await method.call(this, step.params);
        if (result.ok) {
          results.push({
            stepIndex: i,
            action: step.action,
            success: true,
            data: result.value,
          });
          completedCount++;
        } else {
          results.push({
            stepIndex: i,
            action: step.action,
            success: false,
            error: result.error,
          });
          if (options.stopOnError) break;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Step execution failed';
        results.push({
          stepIndex: i,
          action: step.action,
          success: false,
          error: { code: ErrorCode.UNKNOWN, message },
        });
        if (options.stopOnError) break;
      }
    }

    return ok({
      results,
      completedCount,
      totalCount: options.steps.length,
    });
  }

  listBookmarks: IBrowserAdapter['listBookmarks'] = () =>
    Promise.resolve(remoteProfileApiUnavailable('Bookmarks'));

  createBookmark: IBrowserAdapter['createBookmark'] = () =>
    Promise.resolve(remoteProfileApiUnavailable('Bookmarks'));

  searchBookmarks: IBrowserAdapter['searchBookmarks'] = () =>
    Promise.resolve(remoteProfileApiUnavailable('Bookmarks'));

  searchHistory: IBrowserAdapter['searchHistory'] = () =>
    Promise.resolve(remoteProfileApiUnavailable('Browser history'));

  getHistoryEntries: IBrowserAdapter['getHistoryEntries'] = () =>
    Promise.resolve(remoteProfileApiUnavailable('Browser history'));

  getDownloadItems: IBrowserAdapter['getDownloadItems'] = () =>
    Promise.resolve(remoteProfileApiUnavailable('Download history'));

  monitorDownloads: IBrowserAdapter['monitorDownloads'] = () =>
    Promise.resolve(remoteProfileApiUnavailable('Download history'));
}

function withTimeout<T>(operation: Promise<T>, timeout: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(message));
    }, timeout);
    void operation.then(
      (result) => {
        clearTimeout(timer);
        resolve(result);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

function remoteProfileApiUnavailable<T>(api: string): Result<T, ErrorResponse> {
  return err({
    code: ErrorCode.PERMISSION_DENIED,
    message: `${api} is not available through the remote CDP adapter`,
  });
}

function isBrowserLevelCdpMethod(method: string): boolean {
  const domain = method.split('.', 1)[0];
  return (
    domain === 'Browser' ||
    domain === 'Target' ||
    domain === 'SystemInfo' ||
    domain === 'Schema'
  );
}

export { RemoteAdapter };
