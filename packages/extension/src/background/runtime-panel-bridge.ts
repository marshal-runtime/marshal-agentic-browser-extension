import type { CommandName, CommandRequest, CommandResponse } from '@agentic-browser/shared';
import {
  RuntimePanelMethod,
  addRuntimePanelArtifact,
  addRuntimePanelToolLog,
  applyRuntimeLifecycleEvent,
  applyUiLifecycleEvent,
  beginBrowserCommand,
  beginRuntimePanelRestoration,
  completeBrowserCommand,
  completeRuntimePanelRestoration,
  createRuntimePanelRestorationPlan,
  createRuntimePanelState,
  failRuntimePanelRestoration,
  isRuntimeLifecycleEvent,
  isRuntimePanelArtifactNotification,
  isRecord,
  isRuntimePanelBrowserCommand,
  isRuntimePanelSessionSync,
  isRuntimePanelState,
  isRuntimePanelToolLogNotification,
  isRuntimePanelUiLifecycleNotification,
  removeRuntimePanelSession,
  selectRuntimePanelSession,
  updateRuntimePanelTabs,
  upsertRuntimePanelSession,
  type RuntimeLifecycleEvent,
  type RuntimePanelArtifact,
  type RuntimePanelArtifactNotification,
  type RuntimePanelBrowserCommandRequest,
  type RuntimePanelBrowserCommandResult,
  type RuntimePanelBrowserTab,
  type RuntimePanelChannelMessage,
  type RuntimePanelCleanupRequest,
  type RuntimePanelCommandResponse,
  type RuntimePanelRestorationRequest,
  type RuntimePanelRestorationResult,
  type RuntimePanelSession,
  type RuntimePanelSessionSync,
  type RuntimePanelState,
  type RuntimePanelToolLogNotification,
  type RuntimePanelUiLifecycleNotification,
} from '@marshal/runtime-browser-panel';
import type { Logger } from '../infrastructure/logger.js';
import type { SessionManager } from '../infrastructure/session-manager.js';
import type { TabState, TabTracker } from '../infrastructure/tab-tracker.js';
import type { CommandRouter } from './command-router.js';

const PANEL_METADATA_KEY = 'marshalRuntimePanel';

type PanelBroadcaster = (message: RuntimePanelChannelMessage) => Promise<void>;
type BrowserSessionReleaser = (browserSessionId: string) => Promise<void>;

export class RuntimePanelBackgroundBridge {
  private state: RuntimePanelState = createRuntimePanelState();
  private disposeTabListener: (() => void) | undefined;

  constructor(
    private readonly commandRouter: Pick<CommandRouter, 'route'>,
    private readonly tabTracker: Pick<TabTracker, 'getAllTabs' | 'onChange'>,
    private readonly sessionManager: Pick<SessionManager, 'load' | 'save' | 'getState'>,
    private readonly logger: Pick<Logger, 'debug' | 'warn' | 'error'>,
    private readonly broadcast: PanelBroadcaster,
    private readonly releaseBrowserSession?: BrowserSessionReleaser,
  ) {}

  async init(): Promise<void> {
    const restored = await this.sessionManager.load();
    const storedPanelState = restored.metadata[PANEL_METADATA_KEY];
    if (isRuntimePanelState(storedPanelState)) {
      this.state = storedPanelState;
    } else if (storedPanelState !== undefined) {
      this.logger.warn('Ignoring invalid Marshal runtime panel state');
    }

    this.disposeTabListener = this.tabTracker.onChange((tabs) => {
      void this.handleTabsChanged(tabs).catch((error: unknown) => {
        this.logger.error('Failed to synchronize runtime panel tabs', {
          error: errorMessage(error),
        });
      });
    });
  }

  dispose(): void {
    this.disposeTabListener?.();
    this.disposeTabListener = undefined;
  }

  async handleMessage(
    envelope: RuntimePanelChannelMessage,
  ): Promise<RuntimePanelChannelMessage | undefined> {
    const message = envelope.message;
    if (!message.method) {
      return message.id === undefined
        ? undefined
        : createErrorResponse(message.id, -32600, 'JSON-RPC method is required');
    }

    try {
      const result = await this.dispatch(message.method, message.params);
      return message.id === undefined ? undefined : createSuccessResponse(message.id, result);
    } catch (error: unknown) {
      const detail = errorMessage(error);
      this.logger.error('Marshal runtime panel protocol request failed', {
        method: message.method,
        error: detail,
      });
      return message.id === undefined
        ? undefined
        : createErrorResponse(message.id, protocolErrorCode(error), detail);
    }
  }

  getState(): RuntimePanelState {
    return this.state;
  }

  private async dispatch(method: string, params: unknown): Promise<unknown> {
    switch (method) {
      case RuntimePanelMethod.getState:
        return { state: this.state };
      case RuntimePanelMethod.selectSession: {
        const sessionId = requireSessionId(params);
        await this.commit(selectRuntimePanelSession(this.state, sessionId));
        return { state: this.state };
      }
      case RuntimePanelMethod.browserCommand:
        return this.executeBrowserCommand(requireBrowserCommandRequest(params));
      case RuntimePanelMethod.restoreSession:
        return this.restoreSession({ sessionId: requireSessionId(params) });
      case RuntimePanelMethod.cleanupSession:
        return this.cleanupSession(requireCleanupRequest(params));
      case RuntimePanelMethod.sessionSync: {
        const sync = requireSessionSync(params);
        const tabs =
          sync.tabs ??
          (sync.activeTabId === undefined
            ? this.state.sessions[sync.sessionId]?.tabs
            : this.getCurrentTabs().filter((tab) => tab.tabId === sync.activeTabId));
        await this.commit(upsertRuntimePanelSession(this.state, { ...sync, tabs }));
        return { state: this.state };
      }
      case RuntimePanelMethod.runtimeLifecycle: {
        const event = requireRuntimeLifecycleEvent(params);
        await this.commit(applyRuntimeLifecycleEvent(this.state, event));
        return { state: this.state };
      }
      case RuntimePanelMethod.uiLifecycle: {
        const notification = requireUiLifecycleNotification(params);
        await this.commit(applyUiLifecycleEvent(this.state, notification));
        return { state: this.state };
      }
      case RuntimePanelMethod.artifact: {
        const notification = requireArtifactNotification(params);
        await this.commit(
          addRuntimePanelArtifact(this.state, notification.sessionId, notification.artifact),
        );
        return { state: this.state };
      }
      case RuntimePanelMethod.toolLog: {
        const notification = requireToolLogNotification(params);
        await this.commit(
          addRuntimePanelToolLog(this.state, notification.sessionId, notification.log),
        );
        return { state: this.state };
      }
      default:
        throw new ProtocolError(-32601, `Unknown runtime panel method: ${method}`);
    }
  }

  private async executeBrowserCommand(
    request: RuntimePanelBrowserCommandRequest,
  ): Promise<RuntimePanelBrowserCommandResult> {
    const session = this.state.sessions[request.sessionId];
    if (!session) {
      throw new ProtocolError(-32602, `Unknown runtime panel session: ${request.sessionId}`);
    }
    const scopedRequest = scopeBrowserCommand(session, request);
    const context = toBrowserRequestContext(session);

    const commandId = crypto.randomUUID();
    const startedAt = new Date().toISOString();
    await this.commit(
      beginBrowserCommand(
        this.state,
        scopedRequest.sessionId,
        scopedRequest.command,
        commandId,
        startedAt,
        scopedRequest.params,
      ),
    );

    if (
      scopedRequest.tabId !== undefined &&
      !['switchTab', 'closeTab', 'createTab', 'listTabs'].includes(request.command)
    ) {
      const switchResponse = await this.routeCommand(
        'switchTab',
        { tabId: scopedRequest.tabId },
        undefined,
        context,
      );
      if (!switchResponse.success) {
        await this.finishBrowserCommand(scopedRequest, commandId, switchResponse);
        return { response: switchResponse, state: this.state };
      }
    }

    let response = await this.routeCommand(
      scopedRequest.command,
      normalizeCommandParams(scopedRequest),
      commandId,
      context,
    );
    if (scopedRequest.command === 'listTabs') {
      response = scopeListTabsResponse(session, response);
    }
    await this.finishBrowserCommand(scopedRequest, commandId, response);
    return { response, state: this.state };
  }

  private async finishBrowserCommand(
    request: RuntimePanelBrowserCommandRequest,
    commandId: string,
    response: RuntimePanelCommandResponse,
  ): Promise<void> {
    const completedAt = new Date().toISOString();
    let nextState = completeBrowserCommand(
      this.state,
      request.sessionId,
      request.command,
      commandId,
      response,
      completedAt,
    );

    const artifact = createCommandArtifact(request, response, commandId, completedAt);
    if (artifact) {
      nextState = addRuntimePanelArtifact(nextState, request.sessionId, artifact);
    }
    nextState = updateRuntimePanelTabs(
      nextState,
      request.sessionId,
      this.getCurrentTabs(),
      completedAt,
    );
    await this.commit(nextState);
  }

  private async restoreSession(
    request: RuntimePanelRestorationRequest,
  ): Promise<RuntimePanelRestorationResult> {
    const session = this.state.sessions[request.sessionId];
    if (!session) {
      throw new ProtocolError(-32602, `Unknown runtime panel session: ${request.sessionId}`);
    }

    const steps = createRuntimePanelRestorationPlan(session, this.getCurrentTabs());
    const context = toBrowserRequestContext(session);
    const startedAt = new Date().toISOString();
    await this.commit(beginRuntimePanelRestoration(this.state, request.sessionId, startedAt));

    for (const [index, step] of steps.entries()) {
      const response = await this.routeCommand(
        step.command,
        step.params,
        `restore:${request.sessionId}:${String(index)}`,
        context,
      );
      if (!response.success) {
        const failedAt = new Date().toISOString();
        await this.commit(
          failRuntimePanelRestoration(
            this.state,
            request.sessionId,
            failedAt,
            response.error?.message ?? `Restoration command ${step.command} failed`,
          ),
        );
        throw new ProtocolError(
          -32010,
          response.error?.message ?? `Restoration command ${step.command} failed`,
        );
      }
    }

    const completedAt = new Date().toISOString();
    let nextState = updateRuntimePanelTabs(
      this.state,
      request.sessionId,
      this.getCurrentTabs(),
      completedAt,
    );
    nextState = completeRuntimePanelRestoration(nextState, request.sessionId, completedAt);
    await this.commit(nextState);
    return { steps, state: this.state };
  }

  private async cleanupSession(
    request: RuntimePanelCleanupRequest,
  ): Promise<{ state: RuntimePanelState }> {
    const session = this.state.sessions[request.sessionId];
    if (!session) {
      await this.releaseBrowserSession?.(request.sessionId);
      return { state: this.state };
    }
    if (
      request.restoreFirst &&
      (session.restoration.status === 'available' || session.restoration.status === 'failed')
    ) {
      await this.restoreSession({ sessionId: request.sessionId });
    }
    await this.releaseBrowserSession?.(request.sessionId);
    await this.commit(removeRuntimePanelSession(this.state, request.sessionId));
    return { state: this.state };
  }

  private async routeCommand(
    command: CommandName,
    params: Readonly<Record<string, unknown>>,
    requestId?: string,
    context?: CommandRequest['context'],
  ): Promise<CommandResponse> {
    const request: CommandRequest = {
      id: requestId ?? crypto.randomUUID(),
      command,
      params: { ...params },
      timestamp: Date.now(),
      context,
    };
    return this.commandRouter.route(request);
  }

  private async handleTabsChanged(tabs: readonly TabState[]): Promise<void> {
    const occurredAt = new Date().toISOString();
    let nextState = this.state;
    const browserTabs = tabs.map(toRuntimePanelTab);
    for (const sessionId of Object.keys(nextState.sessions)) {
      nextState = updateRuntimePanelTabs(nextState, sessionId, browserTabs, occurredAt);
    }
    if (nextState !== this.state) {
      await this.commit(nextState);
    }
  }

  private getCurrentTabs(): readonly RuntimePanelBrowserTab[] {
    return this.tabTracker.getAllTabs().map(toRuntimePanelTab);
  }

  private async commit(state: RuntimePanelState): Promise<void> {
    this.state = state;
    const metadata = {
      ...this.sessionManager.getState().metadata,
      [PANEL_METADATA_KEY]: state,
    };
    await this.sessionManager.save({ metadata });
    await this.broadcast({
      channel: 'marshal-runtime-panel',
      message: {
        jsonrpc: '2.0',
        method: RuntimePanelMethod.stateChanged,
        params: { state },
      },
    });
  }
}

class ProtocolError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

function createSuccessResponse(id: string | number, result: unknown): RuntimePanelChannelMessage {
  return {
    channel: 'marshal-runtime-panel',
    message: { jsonrpc: '2.0', id, result },
  };
}

function createErrorResponse(
  id: string | number,
  code: number,
  message: string,
): RuntimePanelChannelMessage {
  return {
    channel: 'marshal-runtime-panel',
    message: { jsonrpc: '2.0', id, error: { code, message } },
  };
}

function protocolErrorCode(error: unknown): number {
  return error instanceof ProtocolError ? error.code : -32000;
}

function requireSessionId(value: unknown): string {
  if (!isRecord(value) || typeof value['sessionId'] !== 'string' || value['sessionId'] === '') {
    throw new ProtocolError(-32602, 'sessionId is required');
  }
  return value['sessionId'];
}

function requireBrowserCommandRequest(value: unknown): RuntimePanelBrowserCommandRequest {
  const sessionId = requireSessionId(value);
  if (!isRecord(value) || !isRuntimePanelBrowserCommand(value['command'])) {
    throw new ProtocolError(-32602, 'A supported browser command is required');
  }
  if (value['tabId'] !== undefined && typeof value['tabId'] !== 'number') {
    throw new ProtocolError(-32602, 'tabId must be a number');
  }
  if (value['params'] !== undefined && !isRecord(value['params'])) {
    throw new ProtocolError(-32602, 'params must be an object');
  }
  return {
    sessionId,
    command: value['command'],
    tabId: value['tabId'],
    params: value['params'],
  };
}

function requireCleanupRequest(value: unknown): RuntimePanelCleanupRequest {
  const sessionId = requireSessionId(value);
  if (
    !isRecord(value) ||
    (value['restoreFirst'] !== undefined && typeof value['restoreFirst'] !== 'boolean')
  ) {
    throw new ProtocolError(-32602, 'restoreFirst must be a boolean');
  }
  return { sessionId, restoreFirst: value['restoreFirst'] };
}

function requireSessionSync(value: unknown): RuntimePanelSessionSync {
  if (!isRuntimePanelSessionSync(value)) {
    throw new ProtocolError(-32602, 'updatedAt is required for session sync');
  }
  return value;
}

function requireRuntimeLifecycleEvent(value: unknown): RuntimeLifecycleEvent {
  if (!isRuntimeLifecycleEvent(value)) {
    throw new ProtocolError(-32602, 'Invalid runtime lifecycle event');
  }
  return value;
}

function requireUiLifecycleNotification(value: unknown): RuntimePanelUiLifecycleNotification {
  if (!isRuntimePanelUiLifecycleNotification(value)) {
    throw new ProtocolError(-32602, 'Invalid UI lifecycle notification');
  }
  return value;
}

function requireArtifactNotification(value: unknown): RuntimePanelArtifactNotification {
  if (!isRuntimePanelArtifactNotification(value)) {
    throw new ProtocolError(-32602, 'Invalid artifact notification');
  }
  return value;
}

function requireToolLogNotification(value: unknown): RuntimePanelToolLogNotification {
  if (!isRuntimePanelToolLogNotification(value)) {
    throw new ProtocolError(-32602, 'Invalid tool log notification');
  }
  return value;
}

function normalizeCommandParams(
  request: RuntimePanelBrowserCommandRequest,
): Readonly<Record<string, unknown>> {
  const params = { ...request.params };
  if (
    request.command === 'goBack' ||
    request.command === 'goForward' ||
    request.command === 'reload'
  ) {
    return { ...params, action: request.command };
  }
  if (
    request.tabId !== undefined &&
    (request.command === 'switchTab' || request.command === 'closeTab')
  ) {
    return { ...params, tabId: request.tabId };
  }
  return params;
}

function createCommandArtifact(
  request: RuntimePanelBrowserCommandRequest,
  response: RuntimePanelCommandResponse,
  commandId: string,
  createdAt: string,
): RuntimePanelArtifact | undefined {
  if (!response.success || !isRecord(response.data)) {
    return undefined;
  }
  if (
    request.command === 'captureScreenshot' &&
    typeof response.data['data'] === 'string' &&
    typeof response.data['mimeType'] === 'string'
  ) {
    return {
      id: `screenshot:${commandId}`,
      kind: 'screenshot',
      mediaType: response.data['mimeType'],
      data: response.data['data'],
      metadata: {
        width: response.data['width'],
        height: response.data['height'],
        url: request.params?.['url'],
      },
      createdAt,
    };
  }
  if (request.command === 'getHTML' && typeof response.data['html'] === 'string') {
    return {
      id: `page-snapshot:${commandId}`,
      kind: 'page-snapshot',
      mediaType: 'text/html',
      text: response.data['html'],
      metadata: { length: response.data['length'], url: request.params?.['url'] },
      createdAt,
    };
  }
  return undefined;
}

function scopeBrowserCommand(
  session: RuntimePanelSession,
  request: RuntimePanelBrowserCommandRequest,
): RuntimePanelBrowserCommandRequest {
  if (request.command === 'createTab' || request.command === 'listTabs') {
    return request;
  }

  const tabId = request.tabId ?? session.activeTabId;
  if (tabId === undefined) {
    throw new ProtocolError(-32602, `Session ${session.sessionId} has no active browser tab`);
  }

  const ownedTabIds = new Set([
    ...session.tabs.map((tab) => tab.tabId),
    ...session.baselineTabs.map((tab) => tab.tabId),
    ...session.createdTabIds,
  ]);
  if (!ownedTabIds.has(tabId)) {
    throw new ProtocolError(
      -32602,
      `Browser tab ${String(tabId)} is not owned by runtime panel session ${session.sessionId}`,
    );
  }
  return { ...request, tabId };
}

function scopeListTabsResponse(
  session: RuntimePanelSession,
  response: RuntimePanelCommandResponse,
): RuntimePanelCommandResponse {
  if (!response.success || !isRecord(response.data) || !Array.isArray(response.data['tabs'])) {
    return response;
  }

  const ownedTabIds = new Set([
    ...session.tabs.map((tab) => tab.tabId),
    ...session.baselineTabs.map((tab) => tab.tabId),
    ...session.createdTabIds,
  ]);
  return {
    ...response,
    data: {
      ...response.data,
      tabs: response.data['tabs'].filter(
        (tab) => isRecord(tab) && typeof tab['tabId'] === 'number' && ownedTabIds.has(tab['tabId']),
      ),
    },
  };
}

function toBrowserRequestContext(session: RuntimePanelSession): CommandRequest['context'] {
  const chatId = session.scope.threadId;
  const executionId = session.execution.executionId;
  if (!chatId || !executionId) {
    return undefined;
  }
  return {
    chatId,
    executionId,
    browserSessionId: session.sessionId,
  };
}

function toRuntimePanelTab(tab: TabState): RuntimePanelBrowserTab {
  return {
    tabId: tab.id,
    url: tab.url,
    title: tab.title,
    status: tab.status,
    favIconUrl: tab.favIconUrl,
    windowId: tab.windowId,
    active: tab.active,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
