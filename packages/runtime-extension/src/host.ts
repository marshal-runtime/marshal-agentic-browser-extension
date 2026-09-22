import { randomUUID } from 'node:crypto';
import { NativeMessagingClient, ToolExecutor } from '@agentic-browser/mcp-server/runtime-api';
import {
  RUNTIME_PANEL_CHANNEL,
  RuntimePanelMethod,
  isRuntimePanelChannelMessage,
  type RuntimeLifecycleEvent,
  type RuntimePanelArtifact,
  type RuntimePanelChannelMessage,
  type RuntimePanelExecutionState,
  type RuntimePanelSessionSync,
  type RuntimePanelUiLifecycleNotification,
} from '@marshal/runtime-browser-panel';
import {
  PANEL_FOCUS_TOOL_ID,
  PANEL_OPEN_OR_FOCUS_TOOL_ID,
  PANEL_OPEN_TOOL_ID,
} from './activation.js';
import type {
  BrowserLifecycleEvent,
  BrowserRequestContext,
  InvocationContext,
  MarshalBrowserRuntimeHostModule,
  MaybePromise,
  ResolvedBrowserSession,
  SecretBrowserExecutor,
} from './contracts.js';
import { buildBrowserIsolationKey, resolveChatId } from './session-registry.js';

/**
 * Once a secret has been typed, block operations that can read it back from
 * the page. Clicks, navigation, waits, and ordinary typing remain available
 * so an agent can finish the sign-in flow.
 */
const SECRET_READBACK_BLOCKED_TOOLS = new Set([
  'browser_screenshot',
  'browser_accessibility_tree',
  'browser_get_html',
  'browser_extract_data',
  'browser_execute_script',
  'browser_execute_script_file',
  'browser_validate',
  'browser_console',
  'browser_wait_for_condition',
  'browser_intercept_network',
  'browser_get_storage',
]);

export interface DurableLifecycleCoordinator {
  apply<TRequest, TResult>(
    kind: string,
    request: TRequest,
    callback: (normalized: TRequest) => Promise<TResult>,
  ): Promise<unknown>;
}

export interface MarshalBrowserPanelController {
  open(request: PanelHostToolRequest): MaybePromise<unknown>;
  focus(request: PanelHostToolRequest): MaybePromise<unknown>;
  openOrFocus(request: PanelHostToolRequest): MaybePromise<unknown>;
}

export interface PanelHostToolRequest {
  readonly toolId: string;
  readonly input: unknown;
  readonly context: BrowserRequestContext;
}

export interface MarshalRuntimeHostBridgeOptions {
  readonly lifecycle: DurableLifecycleCoordinator;
  readonly panel: MarshalBrowserPanelController;
  readonly nativeMessagingHostPath?: string;
  readonly timeout?: number;
  readonly nativeClient?: NativeMessagingClient;
  readonly browserExecutor?: Pick<ToolExecutor, 'execute' | 'executeSecretType'>;
  /** Optional per-browser-instance secret transports, e.g. real Safari. */
  readonly secretExecutors?: Readonly<Record<string, SecretBrowserExecutor>>;
}

export interface MarshalRuntimeHostBridge extends MarshalBrowserRuntimeHostModule {
  invokePanelHostTool(request: PanelHostToolRequest): Promise<unknown>;
  invokePanelHostToolForInvocation(
    toolId: string,
    input: unknown,
    context: InvocationContext,
  ): Promise<unknown>;
}

export function createMarshalRuntimeHostBridge(
  options: MarshalRuntimeHostBridgeOptions,
): MarshalRuntimeHostBridge {
  const client = options.nativeClient ?? new NativeMessagingClient(options.nativeMessagingHostPath);
  const executor = options.browserExecutor ?? new ToolExecutor(client, options.timeout);
  const focus = new PanelFocusCoordinator();
  const panelSessions = new Set<string>();
  const secretTaintedSessions = new Set<string>();
  const panelTimeout = options.timeout ?? 30_000;
  const browserSessions = new BrowserInvocationContextResolver(() => randomUUID());

  return {
    createId: () => randomUUID(),
    now: () => new Date().toISOString(),
    resolveBrowserSession: (context) => browserSessions.resolve(context),
    invokeBrowserCommand: async (name, input, context) => {
      if (
        secretTaintedSessions.has(context.browserSessionId) &&
        SECRET_READBACK_BLOCKED_TOOLS.has(name)
      ) {
        return {
          success: false,
          error: {
            code: 'SECRET_READBACK_BLOCKED',
            message:
              'This browser session has received a KeyVault secret; DOM/script readback is blocked.',
          },
        };
      }
      if (!client.isConnected()) {
        client.connect();
      }
      return executor.execute(name, input, context);
    },
    invokeSecretType: async (input, context) => {
      const browserContext = browserSessions.resolve(context).context;
      const secretExecutor = resolveSecretExecutor(
        options.secretExecutors,
        browserContext,
        executor,
      );
      if (!secretExecutor) {
        return {
          success: false,
          error: {
            code: 'BROWSER_INSTANCE_UNBOUND',
            message: 'No secret transport is bound to the requested browser instance.',
          },
        };
      }
      if (secretExecutor === executor && !client.isConnected()) {
        client.connect();
      }
      const result = await secretExecutor.executeSecretType(
        browserContext.browserInstanceId === undefined
          ? input
          : { ...input, browserInstanceId: browserContext.browserInstanceId },
        browserContext,
      );
      if (result.success) {
        secretTaintedSessions.add(browserContext.browserSessionId);
      }
      return result;
    },
    publishLifecycleEvent: async (event) => {
      await persistLifecycleEvent(options.lifecycle, event);
      focus.noteExecution(event.context);
      panelSessions.add(event.context.browserSessionId);
      for (const message of translateLifecycleEvent(event)) {
        await requestRuntimePanel(client, message.method, message.params, panelTimeout);
      }
    },
    openOrFocusPanel: async (context) => {
      if (!focus.canAutoFocus(context)) {
        return;
      }
      await options.panel.openOrFocus({
        toolId: PANEL_OPEN_OR_FOCUS_TOOL_ID,
        input: {},
        context,
      });
    },
    invokePanelHostTool: (request) => {
      focus.noteUserSelection(request.context);
      switch (request.toolId) {
        case PANEL_OPEN_OR_FOCUS_TOOL_ID:
          return Promise.resolve(options.panel.openOrFocus(request));
        case PANEL_OPEN_TOOL_ID:
          return Promise.resolve(options.panel.open(request));
        case PANEL_FOCUS_TOOL_ID:
          return Promise.resolve(options.panel.focus(request));
        default:
          return Promise.reject(
            new Error(`Unsupported Marshal browser panel host tool: ${request.toolId}`),
          );
      }
    },
    invokePanelHostToolForInvocation(toolId, input, context) {
      if (!context.executionId) {
        return Promise.reject(new Error('Marshal browser panel host tools require an executionId'));
      }
      return this.invokePanelHostTool({
        toolId,
        input,
        context: browserSessions.resolve(context).context,
      });
    },
    dispose: async () => {
      const cleanupErrors: Error[] = [];
      try {
        for (const sessionId of panelSessions) {
          try {
            await requestRuntimePanel(
              client,
              RuntimePanelMethod.cleanupSession,
              { sessionId },
              panelTimeout,
            );
          } catch (error: unknown) {
            cleanupErrors.push(toError(error));
          }
        }
      } finally {
        secretTaintedSessions.clear();
        client.disconnect();
      }
      if (cleanupErrors.length > 0) {
        throw new AggregateError(cleanupErrors, 'Failed to clean up runtime browser sessions');
      }
    },
  };
}

function resolveSecretExecutor(
  secretExecutors: Readonly<Record<string, SecretBrowserExecutor>> | undefined,
  context: BrowserRequestContext,
  defaultExecutor: SecretBrowserExecutor,
): SecretBrowserExecutor | undefined {
  if (context.browserInstanceId === undefined) return defaultExecutor;
  return secretExecutors?.[context.browserInstanceId];
}

class BrowserInvocationContextResolver {
  private readonly sessions = new Map<string, string>();

  constructor(private readonly createSessionId: () => string) {}

  resolve(context: InvocationContext): ResolvedBrowserSession {
    const chatId = resolveChatId(context);
    const executionId = context.executionId ?? `panel-${this.createSessionId()}`;
    const key = buildBrowserIsolationKey(context, chatId, executionId);
    const existing = this.sessions.get(key);
    const browserSessionId = existing ?? this.createSessionId();
    if (existing === undefined) {
      this.sessions.set(key, browserSessionId);
    }
    return {
      context: {
        chatId,
        executionId,
        browserSessionId,
        ...(context.browserInstanceId === undefined
          ? {}
          : { browserInstanceId: context.browserInstanceId }),
      },
      created: existing === undefined,
    };
  }
}

interface RuntimePanelRequest {
  readonly method: string;
  readonly params: unknown;
}

class PanelFocusCoordinator {
  private readonly executionRanks = new Map<string, number>();
  private sequence = 0;
  private latestIntentRank = 0;

  noteExecution(context: BrowserRequestContext): void {
    const key = executionKey(context);
    if (this.executionRanks.has(key)) {
      return;
    }
    const rank = ++this.sequence;
    this.executionRanks.set(key, rank);
    this.latestIntentRank = rank;
  }

  noteUserSelection(context: BrowserRequestContext): void {
    const rank = ++this.sequence;
    this.executionRanks.set(executionKey(context), rank);
    this.latestIntentRank = rank;
  }

  canAutoFocus(context: BrowserRequestContext): boolean {
    const key = executionKey(context);
    if (!this.executionRanks.has(key)) {
      this.noteExecution(context);
    }
    return this.executionRanks.get(key) === this.latestIntentRank;
  }
}

function translateLifecycleEvent(event: BrowserLifecycleEvent): readonly RuntimePanelRequest[] {
  if (event.type === 'failure' && event.details?.['phase'] === 'panel-open-or-focus') {
    return [];
  }
  const requests: RuntimePanelRequest[] = [
    {
      method: RuntimePanelMethod.sessionSync,
      params: toSessionSync(event),
    },
  ];
  const runtimeLifecycle = toRuntimeLifecycle(event);
  if (runtimeLifecycle) {
    requests.push({
      method: RuntimePanelMethod.runtimeLifecycle,
      params: runtimeLifecycle,
    });
  }
  const uiLifecycle = toUiLifecycle(event);
  if (uiLifecycle) {
    requests.push({
      method: RuntimePanelMethod.uiLifecycle,
      params: uiLifecycle,
    });
  }
  const artifact = toArtifact(event);
  if (artifact) {
    requests.push({
      method: RuntimePanelMethod.artifact,
      params: { sessionId: event.context.browserSessionId, artifact },
    });
  }
  return requests;
}

function toSessionSync(event: BrowserLifecycleEvent): RuntimePanelSessionSync {
  const activeTabId = resultMetadata(event)?.['activeTabId'];
  return {
    sessionId: event.context.browserSessionId,
    title: `Browser execution ${event.context.executionId}`,
    scope: {
      sessionId: event.context.browserSessionId,
      threadId: event.context.chatId,
    },
    execution: executionState(event),
    activeTabId: typeof activeTabId === 'number' ? activeTabId : undefined,
    updatedAt: event.occurredAt,
  };
}

function executionState(event: BrowserLifecycleEvent): RuntimePanelExecutionState {
  const base = {
    executionId: event.context.executionId,
    target: event.command,
  };
  switch (event.type) {
    case 'created':
      return { ...base, status: 'idle' };
    case 'navigation':
    case 'interaction':
    case 'pause':
      return {
        ...base,
        providerId: 'agentic-browser.extension',
        status: 'running',
        startedAt: event.occurredAt,
      };
    case 'completion':
      return {
        ...base,
        receiptId: event.id,
        status: 'success',
        completedAt: event.occurredAt,
      };
    case 'failure':
      return {
        ...base,
        receiptId: event.id,
        status: 'failed',
        completedAt: event.occurredAt,
        error: normalizePanelError(event.details?.['error']),
      };
  }
}

function toRuntimeLifecycle(event: BrowserLifecycleEvent): RuntimeLifecycleEvent | undefined {
  if (event.type === 'created') {
    return undefined;
  }
  const context = {
    principal: { id: 'agentic-browser', kind: 'runtime-extension' },
    scope: {
      sessionId: event.context.browserSessionId,
      threadId: event.context.chatId,
    },
    executionId: event.context.executionId,
    metadata: { browserSessionId: event.context.browserSessionId },
  };
  if (event.type === 'navigation' || event.type === 'interaction' || event.type === 'pause') {
    return {
      protocolVersion: '1.0.0',
      id: event.id,
      type: 'runtime.execution.started',
      occurredAt: event.occurredAt,
      context,
      payload: {
        executionId: event.context.executionId,
        target: event.command ?? event.type,
        providerId: 'agentic-browser.extension',
      },
    };
  }
  return {
    protocolVersion: '1.0.0',
    id: event.id,
    type: 'runtime.execution.completed',
    occurredAt: event.occurredAt,
    context,
    payload: {
      executionId: event.context.executionId,
      target: event.command ?? 'browser',
      status: event.type === 'completion' ? 'success' : 'failed',
      receiptId: event.id,
    },
  };
}

function toUiLifecycle(
  event: BrowserLifecycleEvent,
): RuntimePanelUiLifecycleNotification | undefined {
  const base = {
    sessionId: event.context.browserSessionId,
    eventId: `ui:${event.id}`,
    commandId:
      typeof event.details?.['operationId'] === 'string' ? event.details['operationId'] : undefined,
    occurredAt: event.occurredAt,
  };
  if (event.type === 'navigation' || event.type === 'interaction' || event.type === 'pause') {
    return {
      ...base,
      event: {
        type: 'tool-input',
        input: { command: event.command, input: event.details?.['input'] },
      },
    };
  }
  if (event.type === 'completion') {
    return {
      ...base,
      event: { type: 'tool-result', result: event.details?.['result'] },
    };
  }
  if (event.type === 'failure') {
    return {
      ...base,
      event: { type: 'tool-error', error: normalizePanelError(event.details?.['error']) },
    };
  }
  return undefined;
}

function toArtifact(event: BrowserLifecycleEvent): RuntimePanelArtifact | undefined {
  if (event.type !== 'completion' || !event.command) {
    return undefined;
  }
  const data = resultData(event);
  if (!data) {
    return undefined;
  }
  const metadata = {
    chatId: event.context.chatId,
    executionId: event.context.executionId,
    browserSessionId: event.context.browserSessionId,
    commandId: resultMetadata(event)?.commandId,
    activeTabId: resultMetadata(event)?.activeTabId,
  };
  if (
    event.command === 'browser_screenshot' &&
    typeof data['data'] === 'string' &&
    typeof data['mimeType'] === 'string'
  ) {
    return {
      id: `screenshot:${event.id}`,
      kind: 'screenshot',
      mediaType: data['mimeType'],
      data: data['data'],
      metadata: { ...metadata, width: data['width'], height: data['height'] },
      createdAt: event.occurredAt,
    };
  }
  if (event.command === 'browser_accessibility_tree' && typeof data['snapshot'] === 'string') {
    return {
      id: `accessibility-snapshot:${event.id}`,
      kind: 'accessibility-snapshot',
      mediaType: 'text/yaml',
      text: data['snapshot'],
      metadata: { ...metadata, refs: data['refs'] },
      createdAt: event.occurredAt,
    };
  }
  if (event.command === 'browser_get_html' && typeof data['html'] === 'string') {
    return {
      id: `page-snapshot:${event.id}`,
      kind: 'page-snapshot',
      mediaType: 'text/html',
      text: data['html'],
      metadata: { ...metadata, length: data['length'], selector: data['selector'] },
      createdAt: event.occurredAt,
    };
  }
  return undefined;
}

function resultData(event: BrowserLifecycleEvent): Record<string, unknown> | undefined {
  const result = event.details?.['result'];
  if (!isRecord(result) || result['success'] !== true || !isRecord(result['data'])) {
    return undefined;
  }
  return result['data'];
}

function resultMetadata(event: BrowserLifecycleEvent): Record<string, unknown> | undefined {
  const result = event.details?.['result'];
  return isRecord(result) && isRecord(result['metadata']) ? result['metadata'] : undefined;
}

function normalizePanelError(value: unknown): {
  readonly code?: string;
  readonly message: string;
  readonly details?: unknown;
} {
  if (isRecord(value)) {
    return {
      code: typeof value['code'] === 'string' ? value['code'] : undefined,
      message: typeof value['message'] === 'string' ? value['message'] : 'Browser command failed',
      details: value['details'],
    };
  }
  return { message: primitiveMessage(value) ?? 'Browser command failed' };
}

async function requestRuntimePanel(
  client: NativeMessagingClient,
  method: string,
  params: unknown,
  timeout: number,
): Promise<void> {
  if (!client.isConnected()) {
    client.connect();
  }
  const id = randomUUID();
  await new Promise<void>((resolve, reject) => {
    const dispose = client.onMessage((message: unknown) => {
      if (!isRuntimePanelChannelMessage(message) || message.message.id !== id) {
        return;
      }
      dispose();
      clearTimeout(timer);
      if (message.message.error) {
        reject(new Error(message.message.error.message));
      } else {
        resolve();
      }
    });
    const timer = setTimeout(() => {
      dispose();
      reject(new Error(`Runtime panel request ${method} timed out after ${String(timeout)}ms`));
    }, timeout);
    const envelope: RuntimePanelChannelMessage = {
      channel: RUNTIME_PANEL_CHANNEL,
      message: { jsonrpc: '2.0', id, method, params },
    };
    try {
      client.send(envelope);
    } catch (error: unknown) {
      dispose();
      clearTimeout(timer);
      reject(toError(error));
    }
  });
}

function executionKey(context: BrowserRequestContext): string {
  return `${context.chatId}\u0000${context.executionId}\u0000${context.browserSessionId}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function primitiveMessage(value: unknown): string | undefined {
  if (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    typeof value === 'bigint'
  ) {
    return String(value);
  }
  return value instanceof Error ? value.message : undefined;
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(primitiveMessage(value) ?? 'Unknown error');
}

async function persistLifecycleEvent(
  coordinator: DurableLifecycleCoordinator,
  event: BrowserLifecycleEvent,
): Promise<void> {
  const request = {
    sessionId: event.context.chatId,
    eventId: event.id,
    protocolVersion: event.protocolVersion,
    executionId: event.context.executionId,
    browserSessionId: event.context.browserSessionId,
    occurredAt: event.occurredAt,
    command: event.command,
    metadata: {
      type: event.type,
      details: event.details,
    },
  };

  await coordinator.apply(event.type, request, (normalized) =>
    Promise.resolve({
      accepted: true,
      event: normalized,
    }),
  );
}

export { PANEL_FOCUS_TOOL_ID, PANEL_OPEN_OR_FOCUS_TOOL_ID, PANEL_OPEN_TOOL_ID };
export {
  createMarshalBrowserExtensionLifecycle,
  MARSHAL_BROWSER_EXTENSION_IDENTITY,
} from './manager-lifecycle.js';
export type {
  MarshalBrowserExtensionLifecycle,
  MarshalBrowserExtensionLifecycleOptions,
  MarshalBrowserExtensionStateStore,
  MarshalPanelHostToolAdapter,
  MarshalRuntimeExtensionContracts,
  PersistedMarshalBrowserExtensionState,
} from './manager-lifecycle.js';
