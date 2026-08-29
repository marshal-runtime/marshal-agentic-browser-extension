export const RUNTIME_PANEL_CHANNEL = 'marshal-runtime-panel';
export const RUNTIME_PANEL_PROTOCOL_VERSION = '1.0.0';

export const RuntimePanelMethod = {
  getState: 'marshal/browser-panel/get-state',
  selectSession: 'marshal/browser-panel/select-session',
  browserCommand: 'marshal/browser-panel/browser-command',
  restoreSession: 'marshal/browser-panel/restore-session',
  cleanupSession: 'marshal/browser-panel/cleanup-session',
  sessionSync: 'marshal/browser-panel/session-sync',
  runtimeLifecycle: 'marshal/runtime/lifecycle',
  uiLifecycle: 'marshal/ui/lifecycle',
  artifact: 'marshal/browser-panel/artifact',
  toolLog: 'marshal/browser-panel/tool-log',
  stateChanged: 'marshal/browser-panel/state-changed',
} as const;

export type RuntimePanelMethodName = (typeof RuntimePanelMethod)[keyof typeof RuntimePanelMethod];

export interface UiProtocolMessage {
  readonly jsonrpc: '2.0';
  readonly id?: string | number;
  readonly method?: string;
  readonly params?: unknown;
  readonly result?: unknown;
  readonly error?: { readonly code?: number; readonly message: string; readonly data?: unknown };
}

export interface UiProtocolTransport {
  request<TResult = unknown>(
    method: string,
    params: unknown,
    options?: { readonly signal?: AbortSignal },
  ): Promise<TResult>;
  notify(method: string, params: unknown): void;
  subscribe(listener: (message: UiProtocolMessage) => void): () => void;
}

export interface RuntimePanelChannelMessage {
  readonly channel: typeof RUNTIME_PANEL_CHANNEL;
  readonly message: UiProtocolMessage;
}

export interface RuntimeHarnessIdentity {
  readonly harnessId: string;
  readonly installationId?: string;
  readonly profileId?: string;
  readonly userId?: string;
  readonly agentId?: string;
}

export interface RuntimeScope {
  readonly workspaceId?: string;
  readonly projectId?: string;
  readonly sessionId?: string;
  readonly threadId?: string;
  readonly parentExecutionId?: string;
  readonly [key: string]: string | undefined;
}

export type RuntimeExecutionStatus =
  | 'success'
  | 'not_found'
  | 'denied'
  | 'approval_required'
  | 'failed'
  | 'cancelled';

export type PermissionDecision =
  | {
      readonly decision: 'allow';
      readonly reason?: string;
      readonly grants?: readonly string[];
    }
  | {
      readonly decision: 'deny';
      readonly reason: string;
      readonly code?: string;
    }
  | {
      readonly decision: 'approval';
      readonly reason: string;
      readonly approvalId?: string;
      readonly prompt?: string;
      readonly expiresAt?: string;
    };

export interface RuntimeLifecyclePayloads {
  readonly 'runtime.provider.registered': {
    readonly providerId: string;
    readonly providerVersion?: string;
  };
  readonly 'runtime.provider.disposed': {
    readonly providerId: string;
  };
  readonly 'runtime.search.completed': {
    readonly query: string;
    readonly resultCount: number;
  };
  readonly 'runtime.execution.started': {
    readonly executionId: string;
    readonly target: string;
    readonly providerId: string;
  };
  readonly 'runtime.execution.permission': {
    readonly executionId: string;
    readonly target: string;
    readonly decision: PermissionDecision;
  };
  readonly 'runtime.execution.completed': {
    readonly executionId: string;
    readonly target: string;
    readonly status: RuntimeExecutionStatus;
    readonly receiptId: string;
  };
}

export type RuntimeLifecycleEventType = keyof RuntimeLifecyclePayloads;

export type RuntimeLifecycleEvent = {
  [TType in RuntimeLifecycleEventType]: {
    readonly protocolVersion: typeof RUNTIME_PANEL_PROTOCOL_VERSION;
    readonly id: string;
    readonly type: TType;
    readonly occurredAt: string;
    readonly context?: {
      readonly principal: { readonly id: string; readonly kind: string };
      readonly identity?: RuntimeHarnessIdentity;
      readonly scope?: RuntimeScope;
      readonly executionId?: string;
      readonly metadata?: Readonly<Record<string, unknown>>;
    };
    readonly payload: RuntimeLifecyclePayloads[TType];
  };
}[RuntimeLifecycleEventType];

export type UiLifecycleEvent =
  | { readonly type: 'tool-input'; readonly input: unknown }
  | { readonly type: 'tool-input-partial'; readonly input: unknown }
  | { readonly type: 'tool-result'; readonly result: unknown }
  | { readonly type: 'tool-cancelled'; readonly reason?: string }
  | {
      readonly type: 'tool-error';
      readonly error: {
        readonly code?: string;
        readonly message: string;
        readonly details?: unknown;
      };
    }
  | { readonly type: 'host-context-changed'; readonly context: Readonly<Record<string, unknown>> }
  | { readonly type: 'teardown'; readonly reason?: string };

export type RuntimePanelExecutionStatus = 'idle' | 'running' | RuntimeExecutionStatus;

export interface RuntimePanelExecutionState {
  readonly executionId?: string;
  readonly target?: string;
  readonly providerId?: string;
  readonly receiptId?: string;
  readonly status: RuntimePanelExecutionStatus;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly error?: { readonly code?: string; readonly message: string; readonly details?: unknown };
}

export interface RuntimePanelChatMessage {
  readonly id: string;
  readonly role: 'user' | 'assistant' | 'system' | 'tool';
  readonly content: string;
  readonly createdAt: string;
}

export interface RuntimePanelBrowserTab {
  readonly tabId: number;
  readonly url: string;
  readonly title: string;
  readonly status: string;
  readonly favIconUrl?: string;
  readonly windowId?: number;
  readonly active: boolean;
}

export interface RuntimePanelTimelineEntry {
  readonly id: string;
  readonly type: string;
  readonly label: string;
  readonly status: 'info' | 'running' | 'success' | 'warning' | 'error';
  readonly occurredAt: string;
  readonly details?: unknown;
}

export interface RuntimePanelToolLog {
  readonly id: string;
  readonly name: string;
  readonly status: 'pending' | 'success' | 'failed' | 'cancelled';
  readonly occurredAt: string;
  readonly input?: unknown;
  readonly result?: unknown;
  readonly error?: { readonly code?: string; readonly message: string; readonly details?: unknown };
}

export interface RuntimePanelArtifact {
  readonly id: string;
  readonly kind: string;
  readonly uri?: string;
  readonly mediaType?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly data?: string;
  readonly text?: string;
  readonly createdAt: string;
}

export type RuntimePanelRestorationStatus =
  | 'unavailable'
  | 'available'
  | 'restoring'
  | 'restored'
  | 'failed';

export interface RuntimePanelSession {
  readonly sessionId: string;
  readonly title: string;
  readonly identity?: RuntimeHarnessIdentity;
  readonly scope: RuntimeScope;
  readonly chat: readonly RuntimePanelChatMessage[];
  readonly execution: RuntimePanelExecutionState;
  readonly tabs: readonly RuntimePanelBrowserTab[];
  readonly baselineTabs: readonly RuntimePanelBrowserTab[];
  readonly activeTabId?: number;
  readonly createdTabIds: readonly number[];
  readonly timeline: readonly RuntimePanelTimelineEntry[];
  readonly toolLogs: readonly RuntimePanelToolLog[];
  readonly artifacts: readonly RuntimePanelArtifact[];
  readonly loading: boolean;
  readonly error?: { readonly code?: string; readonly message: string; readonly details?: unknown };
  readonly restoration: {
    readonly status: RuntimePanelRestorationStatus;
    readonly error?: string;
    readonly restoredAt?: string;
  };
  readonly updatedAt: string;
}

export interface RuntimePanelState {
  readonly schemaVersion: typeof RUNTIME_PANEL_PROTOCOL_VERSION;
  readonly selectedSessionId?: string;
  readonly sessions: Readonly<Record<string, RuntimePanelSession>>;
}

export interface RuntimePanelSessionSync {
  readonly sessionId: string;
  readonly title?: string;
  readonly identity?: RuntimeHarnessIdentity;
  readonly scope?: RuntimeScope;
  readonly chat?: readonly RuntimePanelChatMessage[];
  readonly execution?: RuntimePanelExecutionState;
  readonly tabs?: readonly RuntimePanelBrowserTab[];
  readonly activeTabId?: number;
  readonly updatedAt: string;
}

export interface RuntimePanelUiLifecycleNotification {
  readonly sessionId: string;
  readonly eventId: string;
  readonly commandId?: string;
  readonly occurredAt: string;
  readonly event: UiLifecycleEvent;
}

export interface RuntimePanelArtifactNotification {
  readonly sessionId: string;
  readonly artifact: RuntimePanelArtifact;
}

export interface RuntimePanelToolLogNotification {
  readonly sessionId: string;
  readonly log: RuntimePanelToolLog;
}

export type RuntimePanelBrowserCommand =
  | 'navigate'
  | 'goBack'
  | 'goForward'
  | 'reload'
  | 'createTab'
  | 'closeTab'
  | 'switchTab'
  | 'listTabs'
  | 'captureScreenshot'
  | 'getHTML';

export interface RuntimePanelBrowserCommandRequest {
  readonly sessionId: string;
  readonly command: RuntimePanelBrowserCommand;
  readonly tabId?: number;
  readonly params?: Readonly<Record<string, unknown>>;
}

export interface RuntimePanelCommandResponse {
  readonly id: string;
  readonly success: boolean;
  readonly data?: unknown;
  readonly error?: { readonly code: string; readonly message: string; readonly details?: unknown };
  readonly metadata?: {
    readonly duration: number;
    readonly timestamp: number;
    readonly commandId?: string;
  };
}

export interface RuntimePanelBrowserCommandResult {
  readonly response: RuntimePanelCommandResponse;
  readonly state: RuntimePanelState;
}

export interface RuntimePanelRestorationRequest {
  readonly sessionId: string;
}

export interface RuntimePanelCleanupRequest {
  readonly sessionId: string;
  readonly restoreFirst?: boolean;
}

export interface RuntimePanelSelectSessionRequest {
  readonly sessionId: string;
}

export interface RuntimePanelStateChangedNotification {
  readonly state: RuntimePanelState;
}

export interface RuntimePanelRestorationStep {
  readonly command: Extract<
    RuntimePanelBrowserCommand,
    'navigate' | 'createTab' | 'closeTab' | 'switchTab'
  >;
  readonly params: Readonly<Record<string, unknown>>;
}

export interface RuntimePanelRestorationResult {
  readonly steps: readonly RuntimePanelRestorationStep[];
  readonly state: RuntimePanelState;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isUiProtocolMessage(value: unknown): value is UiProtocolMessage {
  if (!isRecord(value) || value['jsonrpc'] !== '2.0') {
    return false;
  }
  const id = value['id'];
  const method = value['method'];
  return (
    (id === undefined || typeof id === 'string' || typeof id === 'number') &&
    (method === undefined || typeof method === 'string')
  );
}

export function isRuntimePanelChannelMessage(value: unknown): value is RuntimePanelChannelMessage {
  return (
    isRecord(value) &&
    value['channel'] === RUNTIME_PANEL_CHANNEL &&
    isUiProtocolMessage(value['message'])
  );
}

export function isRuntimePanelBrowserCommand(value: unknown): value is RuntimePanelBrowserCommand {
  return (
    typeof value === 'string' &&
    [
      'navigate',
      'goBack',
      'goForward',
      'reload',
      'createTab',
      'closeTab',
      'switchTab',
      'listTabs',
      'captureScreenshot',
      'getHTML',
    ].includes(value)
  );
}

export function isRuntimeLifecycleEvent(value: unknown): value is RuntimeLifecycleEvent {
  if (
    !isRecord(value) ||
    value['protocolVersion'] !== RUNTIME_PANEL_PROTOCOL_VERSION ||
    typeof value['id'] !== 'string' ||
    typeof value['type'] !== 'string' ||
    typeof value['occurredAt'] !== 'string' ||
    !isRuntimeInvocationContext(value['context']) ||
    !isRecord(value['payload'])
  ) {
    return false;
  }

  const payload = value['payload'];
  switch (value['type']) {
    case 'runtime.provider.registered':
      return (
        typeof payload['providerId'] === 'string' && optionalString(payload['providerVersion'])
      );
    case 'runtime.provider.disposed':
      return typeof payload['providerId'] === 'string';
    case 'runtime.search.completed':
      return typeof payload['query'] === 'string' && typeof payload['resultCount'] === 'number';
    case 'runtime.execution.started':
      return (
        typeof payload['executionId'] === 'string' &&
        typeof payload['target'] === 'string' &&
        typeof payload['providerId'] === 'string'
      );
    case 'runtime.execution.permission':
      return (
        typeof payload['executionId'] === 'string' &&
        typeof payload['target'] === 'string' &&
        isPermissionDecision(payload['decision'])
      );
    case 'runtime.execution.completed':
      return (
        typeof payload['executionId'] === 'string' &&
        typeof payload['target'] === 'string' &&
        isRuntimeExecutionStatus(payload['status']) &&
        typeof payload['receiptId'] === 'string'
      );
    default:
      return false;
  }
}

export function isRuntimePanelSessionSync(value: unknown): value is RuntimePanelSessionSync {
  return (
    isRecord(value) &&
    typeof value['sessionId'] === 'string' &&
    value['sessionId'] !== '' &&
    optionalString(value['title']) &&
    (value['identity'] === undefined || isRuntimeHarnessIdentity(value['identity'])) &&
    (value['scope'] === undefined || isRuntimeScope(value['scope'])) &&
    optionalArray(value['chat'], isRuntimePanelChatMessage) &&
    (value['execution'] === undefined || isRuntimePanelExecutionState(value['execution'])) &&
    optionalArray(value['tabs'], isRuntimePanelBrowserTab) &&
    (value['activeTabId'] === undefined || isTabId(value['activeTabId'])) &&
    typeof value['updatedAt'] === 'string'
  );
}

export function isRuntimePanelUiLifecycleNotification(
  value: unknown,
): value is RuntimePanelUiLifecycleNotification {
  return (
    isRecord(value) &&
    typeof value['sessionId'] === 'string' &&
    value['sessionId'] !== '' &&
    typeof value['eventId'] === 'string' &&
    optionalString(value['commandId']) &&
    typeof value['occurredAt'] === 'string' &&
    isUiLifecycleEvent(value['event'])
  );
}

export function isRuntimePanelArtifactNotification(
  value: unknown,
): value is RuntimePanelArtifactNotification {
  return (
    isRecord(value) &&
    typeof value['sessionId'] === 'string' &&
    value['sessionId'] !== '' &&
    isRuntimePanelArtifact(value['artifact'])
  );
}

export function isRuntimePanelToolLogNotification(
  value: unknown,
): value is RuntimePanelToolLogNotification {
  return (
    isRecord(value) &&
    typeof value['sessionId'] === 'string' &&
    value['sessionId'] !== '' &&
    isRuntimePanelToolLog(value['log'])
  );
}

export function isRuntimePanelBrowserCommandResult(
  value: unknown,
): value is RuntimePanelBrowserCommandResult {
  return (
    isRecord(value) &&
    isRuntimePanelCommandResponse(value['response']) &&
    isRuntimePanelState(value['state'])
  );
}

export function isRuntimePanelRestorationResult(
  value: unknown,
): value is RuntimePanelRestorationResult {
  return (
    isRecord(value) &&
    Array.isArray(value['steps']) &&
    value['steps'].every(isRuntimePanelRestorationStep) &&
    isRuntimePanelState(value['state'])
  );
}

export function isRuntimePanelState(value: unknown): value is RuntimePanelState {
  if (
    !isRecord(value) ||
    value['schemaVersion'] !== RUNTIME_PANEL_PROTOCOL_VERSION ||
    !isRecord(value['sessions']) ||
    (value['selectedSessionId'] !== undefined && typeof value['selectedSessionId'] !== 'string')
  ) {
    return false;
  }
  if (!Object.values(value['sessions']).every(isRuntimePanelSession)) {
    return false;
  }
  return (
    value['selectedSessionId'] === undefined ||
    Object.hasOwn(value['sessions'], value['selectedSessionId'])
  );
}

function isRuntimeInvocationContext(value: unknown): boolean {
  if (value === undefined) {
    return true;
  }
  return (
    isRecord(value) &&
    isRecord(value['principal']) &&
    typeof value['principal']['id'] === 'string' &&
    typeof value['principal']['kind'] === 'string' &&
    (value['identity'] === undefined || isRuntimeHarnessIdentity(value['identity'])) &&
    (value['scope'] === undefined || isRuntimeScope(value['scope'])) &&
    optionalString(value['executionId']) &&
    (value['metadata'] === undefined || isRecord(value['metadata']))
  );
}

function isRuntimeHarnessIdentity(value: unknown): value is RuntimeHarnessIdentity {
  return (
    isRecord(value) &&
    typeof value['harnessId'] === 'string' &&
    optionalString(value['installationId']) &&
    optionalString(value['profileId']) &&
    optionalString(value['userId']) &&
    optionalString(value['agentId'])
  );
}

function isRuntimeScope(value: unknown): value is RuntimeScope {
  return (
    isRecord(value) &&
    Object.values(value).every((entry) => entry === undefined || typeof entry === 'string')
  );
}

function isPermissionDecision(value: unknown): value is PermissionDecision {
  if (!isRecord(value) || typeof value['decision'] !== 'string') {
    return false;
  }
  if (value['decision'] === 'allow') {
    return (
      optionalString(value['reason']) &&
      (value['grants'] === undefined ||
        (Array.isArray(value['grants']) &&
          value['grants'].every((grant) => typeof grant === 'string')))
    );
  }
  if (value['decision'] === 'deny') {
    return typeof value['reason'] === 'string' && optionalString(value['code']);
  }
  return (
    value['decision'] === 'approval' &&
    typeof value['reason'] === 'string' &&
    optionalString(value['approvalId']) &&
    optionalString(value['prompt']) &&
    optionalString(value['expiresAt'])
  );
}

function isRuntimeExecutionStatus(value: unknown): value is RuntimeExecutionStatus {
  return (
    typeof value === 'string' &&
    ['success', 'not_found', 'denied', 'approval_required', 'failed', 'cancelled'].includes(value)
  );
}

function isRuntimePanelExecutionStatus(value: unknown): value is RuntimePanelExecutionStatus {
  return value === 'idle' || value === 'running' || isRuntimeExecutionStatus(value);
}

function isRuntimePanelExecutionState(value: unknown): value is RuntimePanelExecutionState {
  return (
    isRecord(value) &&
    isRuntimePanelExecutionStatus(value['status']) &&
    optionalString(value['executionId']) &&
    optionalString(value['target']) &&
    optionalString(value['providerId']) &&
    optionalString(value['receiptId']) &&
    optionalString(value['startedAt']) &&
    optionalString(value['completedAt']) &&
    (value['error'] === undefined || isRuntimePanelError(value['error']))
  );
}

function isRuntimePanelChatMessage(value: unknown): value is RuntimePanelChatMessage {
  return (
    isRecord(value) &&
    typeof value['id'] === 'string' &&
    typeof value['role'] === 'string' &&
    ['user', 'assistant', 'system', 'tool'].includes(value['role']) &&
    typeof value['content'] === 'string' &&
    typeof value['createdAt'] === 'string'
  );
}

function isRuntimePanelBrowserTab(value: unknown): value is RuntimePanelBrowserTab {
  return (
    isRecord(value) &&
    isTabId(value['tabId']) &&
    typeof value['url'] === 'string' &&
    typeof value['title'] === 'string' &&
    typeof value['status'] === 'string' &&
    optionalString(value['favIconUrl']) &&
    (value['windowId'] === undefined || Number.isInteger(value['windowId'])) &&
    typeof value['active'] === 'boolean'
  );
}

function isRuntimePanelTimelineEntry(value: unknown): value is RuntimePanelTimelineEntry {
  return (
    isRecord(value) &&
    typeof value['id'] === 'string' &&
    typeof value['type'] === 'string' &&
    typeof value['label'] === 'string' &&
    typeof value['status'] === 'string' &&
    ['info', 'running', 'success', 'warning', 'error'].includes(value['status']) &&
    typeof value['occurredAt'] === 'string'
  );
}

function isRuntimePanelToolLog(value: unknown): value is RuntimePanelToolLog {
  return (
    isRecord(value) &&
    typeof value['id'] === 'string' &&
    typeof value['name'] === 'string' &&
    typeof value['status'] === 'string' &&
    ['pending', 'success', 'failed', 'cancelled'].includes(value['status']) &&
    typeof value['occurredAt'] === 'string' &&
    (value['error'] === undefined || isRuntimePanelError(value['error']))
  );
}

function isRuntimePanelArtifact(value: unknown): value is RuntimePanelArtifact {
  return (
    isRecord(value) &&
    typeof value['id'] === 'string' &&
    typeof value['kind'] === 'string' &&
    optionalString(value['uri']) &&
    optionalString(value['mediaType']) &&
    (value['metadata'] === undefined || isRecord(value['metadata'])) &&
    optionalString(value['data']) &&
    optionalString(value['text']) &&
    typeof value['createdAt'] === 'string'
  );
}

function isRuntimePanelSession(value: unknown): value is RuntimePanelSession {
  return (
    isRecord(value) &&
    typeof value['sessionId'] === 'string' &&
    value['sessionId'] !== '' &&
    typeof value['title'] === 'string' &&
    (value['identity'] === undefined || isRuntimeHarnessIdentity(value['identity'])) &&
    isRuntimeScope(value['scope']) &&
    requiredArray(value['chat'], isRuntimePanelChatMessage) &&
    isRuntimePanelExecutionState(value['execution']) &&
    requiredArray(value['tabs'], isRuntimePanelBrowserTab) &&
    requiredArray(value['baselineTabs'], isRuntimePanelBrowserTab) &&
    (value['activeTabId'] === undefined || isTabId(value['activeTabId'])) &&
    requiredArray(value['createdTabIds'], isTabId) &&
    requiredArray(value['timeline'], isRuntimePanelTimelineEntry) &&
    requiredArray(value['toolLogs'], isRuntimePanelToolLog) &&
    requiredArray(value['artifacts'], isRuntimePanelArtifact) &&
    typeof value['loading'] === 'boolean' &&
    (value['error'] === undefined || isRuntimePanelError(value['error'])) &&
    isRuntimePanelRestoration(value['restoration']) &&
    typeof value['updatedAt'] === 'string'
  );
}

function isRuntimePanelRestoration(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value['status'] === 'string' &&
    ['unavailable', 'available', 'restoring', 'restored', 'failed'].includes(value['status']) &&
    optionalString(value['error']) &&
    optionalString(value['restoredAt'])
  );
}

function isRuntimePanelError(value: unknown): boolean {
  return isRecord(value) && optionalString(value['code']) && typeof value['message'] === 'string';
}

function isUiLifecycleEvent(value: unknown): value is UiLifecycleEvent {
  if (!isRecord(value) || typeof value['type'] !== 'string') {
    return false;
  }
  switch (value['type']) {
    case 'tool-input':
    case 'tool-input-partial':
      return Object.hasOwn(value, 'input');
    case 'tool-result':
      return Object.hasOwn(value, 'result');
    case 'tool-cancelled':
    case 'teardown':
      return optionalString(value['reason']);
    case 'tool-error':
      return isRuntimePanelError(value['error']);
    case 'host-context-changed':
      return isRecord(value['context']);
    default:
      return false;
  }
}

function isRuntimePanelCommandResponse(value: unknown): value is RuntimePanelCommandResponse {
  return (
    isRecord(value) &&
    typeof value['id'] === 'string' &&
    typeof value['success'] === 'boolean' &&
    (value['error'] === undefined ||
      (isRecord(value['error']) &&
        typeof value['error']['code'] === 'string' &&
        typeof value['error']['message'] === 'string')) &&
    (value['metadata'] === undefined ||
      (isRecord(value['metadata']) &&
        typeof value['metadata']['duration'] === 'number' &&
        typeof value['metadata']['timestamp'] === 'number' &&
        optionalString(value['metadata']['commandId'])))
  );
}

function isRuntimePanelRestorationStep(value: unknown): value is RuntimePanelRestorationStep {
  return (
    isRecord(value) &&
    typeof value['command'] === 'string' &&
    ['navigate', 'createTab', 'closeTab', 'switchTab'].includes(value['command']) &&
    isRecord(value['params'])
  );
}

function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string';
}

function isTabId(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function optionalArray<T>(
  value: unknown,
  predicate: (entry: unknown) => entry is T,
): value is readonly T[] | undefined {
  return value === undefined || requiredArray(value, predicate);
}

function requiredArray<T>(
  value: unknown,
  predicate: (entry: unknown) => entry is T,
): value is readonly T[] {
  return Array.isArray(value) && value.every(predicate);
}
