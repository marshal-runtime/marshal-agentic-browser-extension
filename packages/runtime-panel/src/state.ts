import {
  RUNTIME_PANEL_PROTOCOL_VERSION,
  type RuntimeLifecycleEvent,
  type RuntimePanelArtifact,
  type RuntimePanelBrowserCommand,
  type RuntimePanelBrowserTab,
  type RuntimePanelCommandResponse,
  type RuntimePanelRestorationStep,
  type RuntimePanelSession,
  type RuntimePanelSessionSync,
  type RuntimePanelState,
  type RuntimePanelTimelineEntry,
  type RuntimePanelToolLog,
  type RuntimePanelUiLifecycleNotification,
} from './protocol.js';

const MAX_TIMELINE_ENTRIES = 500;
const MAX_TOOL_LOGS = 250;
const MAX_ARTIFACTS = 50;

export function createRuntimePanelState(): RuntimePanelState {
  return {
    schemaVersion: RUNTIME_PANEL_PROTOCOL_VERSION,
    sessions: {},
  };
}

export function upsertRuntimePanelSession(
  state: RuntimePanelState,
  sync: RuntimePanelSessionSync,
): RuntimePanelState {
  const existing = state.sessions[sync.sessionId];
  const tabs = sync.tabs ?? existing?.tabs ?? [];
  const execution = sync.execution ?? existing?.execution ?? { status: 'idle' };
  const terminal = isTerminalExecutionStatus(execution.status);
  const session: RuntimePanelSession = {
    sessionId: sync.sessionId,
    title: sync.title ?? existing?.title ?? sync.sessionId,
    identity: sync.identity ?? existing?.identity,
    scope: { ...existing?.scope, ...sync.scope, sessionId: sync.sessionId },
    chat: sync.chat ?? existing?.chat ?? [],
    execution,
    tabs,
    baselineTabs:
      existing?.baselineTabs.length === 0 || existing === undefined
        ? cloneTabs(tabs)
        : existing.baselineTabs,
    activeTabId: sync.activeTabId ?? tabs.find((tab) => tab.active)?.tabId ?? existing?.activeTabId,
    createdTabIds: existing?.createdTabIds ?? [],
    timeline: existing?.timeline ?? [],
    toolLogs: existing?.toolLogs ?? [],
    artifacts: existing?.artifacts ?? [],
    loading: existing?.loading ?? false,
    error: existing?.error,
    restoration: terminal
      ? existing?.restoration.status === 'restored'
        ? existing.restoration
        : { status: 'available' }
      : (existing?.restoration ?? { status: 'unavailable' }),
    updatedAt: sync.updatedAt,
  };

  return {
    ...state,
    selectedSessionId: state.selectedSessionId ?? sync.sessionId,
    sessions: { ...state.sessions, [sync.sessionId]: session },
  };
}

export function applyRuntimeLifecycleEvent(
  state: RuntimePanelState,
  event: RuntimeLifecycleEvent,
): RuntimePanelState {
  const sessionId = event.context?.scope?.sessionId;
  if (!sessionId) {
    return state;
  }

  let nextState = ensureSession(
    state,
    sessionId,
    event.occurredAt,
    event.context.identity,
    event.context.scope,
  );
  const session = requireSession(nextState, sessionId);
  const entry = toRuntimeTimelineEntry(event);
  let execution = session.execution;
  let restoration = session.restoration;

  switch (event.type) {
    case 'runtime.execution.started':
      execution = {
        executionId: event.payload.executionId,
        target: event.payload.target,
        providerId: event.payload.providerId,
        status: 'running',
        startedAt: event.occurredAt,
      };
      restoration = { status: 'unavailable' };
      break;
    case 'runtime.execution.permission':
      if (event.payload.decision.decision === 'approval') {
        execution = { ...execution, status: 'approval_required' };
      } else if (event.payload.decision.decision === 'deny') {
        execution = {
          ...execution,
          status: 'denied',
          completedAt: event.occurredAt,
          error: {
            code: event.payload.decision.code,
            message: event.payload.decision.reason,
          },
        };
        restoration = { status: 'available' };
      }
      break;
    case 'runtime.execution.completed':
      execution = {
        ...execution,
        executionId: event.payload.executionId,
        target: event.payload.target,
        receiptId: event.payload.receiptId,
        status: event.payload.status,
        completedAt: event.occurredAt,
      };
      restoration = { status: 'available' };
      break;
    default:
      break;
  }

  nextState = updateSession(nextState, sessionId, {
    ...session,
    execution,
    restoration,
    timeline: appendBounded(session.timeline, entry, MAX_TIMELINE_ENTRIES),
    updatedAt: event.occurredAt,
  });
  return nextState;
}

export function applyUiLifecycleEvent(
  state: RuntimePanelState,
  notification: RuntimePanelUiLifecycleNotification,
): RuntimePanelState {
  let nextState = ensureSession(state, notification.sessionId, notification.occurredAt);
  const session = requireSession(nextState, notification.sessionId);
  const event = notification.event;
  const entry = toUiTimelineEntry(notification);
  let toolLogs = session.toolLogs;
  let execution = session.execution;
  let restoration = session.restoration;

  if (event.type === 'tool-input' || event.type === 'tool-input-partial') {
    toolLogs = appendBounded(
      toolLogs,
      {
        id: notification.commandId ?? notification.eventId,
        name: event.type === 'tool-input' ? 'runtime tool' : 'runtime tool (streaming)',
        status: 'pending',
        occurredAt: notification.occurredAt,
        input: event.input,
      },
      MAX_TOOL_LOGS,
    );
  } else if (event.type === 'tool-result') {
    toolLogs = terminalizePendingLog(
      toolLogs,
      notification.commandId,
      notification.eventId,
      notification.occurredAt,
      { status: 'success', result: event.result },
    );
  } else if (event.type === 'tool-error') {
    toolLogs = terminalizePendingLog(
      toolLogs,
      notification.commandId,
      notification.eventId,
      notification.occurredAt,
      { status: 'failed', error: event.error },
    );
    execution = {
      ...execution,
      status: 'failed',
      completedAt: notification.occurredAt,
      error: event.error,
    };
    restoration = { status: 'available' };
  } else if (event.type === 'tool-cancelled') {
    toolLogs = terminalizePendingLog(
      toolLogs,
      notification.commandId,
      notification.eventId,
      notification.occurredAt,
      {
        status: 'cancelled',
        error: event.reason ? { message: event.reason } : undefined,
      },
    );
    execution = { ...execution, status: 'cancelled', completedAt: notification.occurredAt };
    restoration = { status: 'available' };
  } else if (event.type === 'teardown' && execution.status === 'running') {
    execution = {
      ...execution,
      status: 'cancelled',
      completedAt: notification.occurredAt,
      error: event.reason ? { message: event.reason } : undefined,
    };
    restoration = { status: 'available' };
  }

  nextState = updateSession(nextState, notification.sessionId, {
    ...session,
    execution,
    restoration,
    toolLogs,
    timeline: appendBounded(session.timeline, entry, MAX_TIMELINE_ENTRIES),
    updatedAt: notification.occurredAt,
  });
  return nextState;
}

export function addRuntimePanelArtifact(
  state: RuntimePanelState,
  sessionId: string,
  artifact: RuntimePanelArtifact,
): RuntimePanelState {
  const nextState = ensureSession(state, sessionId, artifact.createdAt);
  const session = requireSession(nextState, sessionId);
  return updateSession(nextState, sessionId, {
    ...session,
    artifacts: appendBounded(session.artifacts, artifact, MAX_ARTIFACTS),
    updatedAt: artifact.createdAt,
  });
}

export function addRuntimePanelToolLog(
  state: RuntimePanelState,
  sessionId: string,
  log: RuntimePanelToolLog,
): RuntimePanelState {
  const nextState = ensureSession(state, sessionId, log.occurredAt);
  const session = requireSession(nextState, sessionId);
  return updateSession(nextState, sessionId, {
    ...session,
    toolLogs: appendBounded(session.toolLogs, log, MAX_TOOL_LOGS),
    updatedAt: log.occurredAt,
  });
}

export function beginBrowserCommand(
  state: RuntimePanelState,
  sessionId: string,
  command: RuntimePanelBrowserCommand,
  commandId: string,
  occurredAt: string,
  input?: unknown,
): RuntimePanelState {
  const session = requireSession(state, sessionId);
  const entry: RuntimePanelTimelineEntry = {
    id: commandId,
    type: `browser.${command}`,
    label: `Browser ${command}`,
    status: 'running',
    occurredAt,
    details: input,
  };
  const log: RuntimePanelToolLog = {
    id: commandId,
    name: command,
    status: 'pending',
    occurredAt,
    input,
  };
  return updateSession(state, sessionId, {
    ...session,
    loading: true,
    error: undefined,
    timeline: appendBounded(session.timeline, entry, MAX_TIMELINE_ENTRIES),
    toolLogs: appendBounded(session.toolLogs, log, MAX_TOOL_LOGS),
    updatedAt: occurredAt,
  });
}

export function completeBrowserCommand(
  state: RuntimePanelState,
  sessionId: string,
  command: RuntimePanelBrowserCommand,
  commandId: string,
  response: RuntimePanelCommandResponse,
  occurredAt: string,
): RuntimePanelState {
  const session = requireSession(state, sessionId);
  const timeline = session.timeline.map((entry) =>
    entry.id === commandId
      ? {
          ...entry,
          status: response.success ? ('success' as const) : ('error' as const),
          details: response.success ? response.data : response.error,
        }
      : entry,
  );
  const toolLogs = session.toolLogs.map((log) =>
    log.id === commandId
      ? {
          ...log,
          status: response.success ? ('success' as const) : ('failed' as const),
          result: response.success ? response.data : undefined,
          error: response.success ? undefined : response.error,
        }
      : log,
  );
  const createdTabId =
    command === 'createTab' && response.success && isTabResponse(response.data)
      ? response.data.tabId
      : undefined;

  return updateSession(state, sessionId, {
    ...session,
    loading: false,
    error: response.success ? undefined : response.error,
    createdTabIds:
      createdTabId === undefined || session.createdTabIds.includes(createdTabId)
        ? session.createdTabIds
        : [...session.createdTabIds, createdTabId],
    timeline,
    toolLogs,
    updatedAt: occurredAt,
  });
}

export function updateRuntimePanelTabs(
  state: RuntimePanelState,
  sessionId: string,
  tabs: readonly RuntimePanelBrowserTab[],
  occurredAt: string,
): RuntimePanelState {
  const session = requireSession(state, sessionId);
  const trackedIds = new Set([
    ...session.tabs.map((tab) => tab.tabId),
    ...session.baselineTabs.map((tab) => tab.tabId),
    ...session.createdTabIds,
  ]);
  const scopedTabs =
    trackedIds.size === 0 ? session.tabs : tabs.filter((tab) => trackedIds.has(tab.tabId));
  return updateSession(state, sessionId, {
    ...session,
    tabs: scopedTabs,
    activeTabId: scopedTabs.find((tab) => tab.active)?.tabId ?? session.activeTabId,
    updatedAt: occurredAt,
  });
}

export function selectRuntimePanelSession(
  state: RuntimePanelState,
  sessionId: string,
): RuntimePanelState {
  requireSession(state, sessionId);
  return { ...state, selectedSessionId: sessionId };
}

export function removeRuntimePanelSession(
  state: RuntimePanelState,
  sessionId: string,
): RuntimePanelState {
  requireSession(state, sessionId);
  const sessions = Object.fromEntries(
    Object.entries(state.sessions).filter(([candidateId]) => candidateId !== sessionId),
  );
  const remainingIds = Object.keys(sessions);
  return {
    ...state,
    sessions,
    selectedSessionId:
      state.selectedSessionId === sessionId ? remainingIds[0] : state.selectedSessionId,
  };
}

export function beginRuntimePanelRestoration(
  state: RuntimePanelState,
  sessionId: string,
  occurredAt: string,
): RuntimePanelState {
  const session = requireSession(state, sessionId);
  if (session.restoration.status !== 'available' && session.restoration.status !== 'failed') {
    throw new Error(`Session ${sessionId} is not ready for restoration`);
  }
  return updateSession(state, sessionId, {
    ...session,
    loading: true,
    error: undefined,
    restoration: { status: 'restoring' },
    timeline: appendBounded(
      session.timeline,
      {
        id: `restore:${occurredAt}`,
        type: 'browser.restoration.started',
        label: 'Browser restoration started',
        status: 'running',
        occurredAt,
      },
      MAX_TIMELINE_ENTRIES,
    ),
    updatedAt: occurredAt,
  });
}

export function completeRuntimePanelRestoration(
  state: RuntimePanelState,
  sessionId: string,
  occurredAt: string,
): RuntimePanelState {
  const session = requireSession(state, sessionId);
  return updateSession(state, sessionId, {
    ...session,
    loading: false,
    error: undefined,
    createdTabIds: [],
    restoration: { status: 'restored', restoredAt: occurredAt },
    timeline: appendBounded(
      session.timeline,
      {
        id: `restore:${occurredAt}`,
        type: 'browser.restoration.completed',
        label: 'Browser restoration completed',
        status: 'success',
        occurredAt,
      },
      MAX_TIMELINE_ENTRIES,
    ),
    updatedAt: occurredAt,
  });
}

export function failRuntimePanelRestoration(
  state: RuntimePanelState,
  sessionId: string,
  occurredAt: string,
  message: string,
): RuntimePanelState {
  const session = requireSession(state, sessionId);
  return updateSession(state, sessionId, {
    ...session,
    loading: false,
    error: { code: 'RESTORATION_FAILED', message },
    restoration: { status: 'failed', error: message },
    timeline: appendBounded(
      session.timeline,
      {
        id: `restore:${occurredAt}`,
        type: 'browser.restoration.failed',
        label: 'Browser restoration failed',
        status: 'error',
        occurredAt,
        details: { message },
      },
      MAX_TIMELINE_ENTRIES,
    ),
    updatedAt: occurredAt,
  });
}

export function createRuntimePanelRestorationPlan(
  session: RuntimePanelSession,
  currentTabs: readonly RuntimePanelBrowserTab[],
): readonly RuntimePanelRestorationStep[] {
  if (session.restoration.status !== 'available' && session.restoration.status !== 'failed') {
    return [];
  }

  const currentById = new Map(currentTabs.map((tab) => [tab.tabId, tab]));
  const baselineIds = new Set(session.baselineTabs.map((tab) => tab.tabId));
  const steps: RuntimePanelRestorationStep[] = [];

  for (const tabId of session.createdTabIds) {
    if (!baselineIds.has(tabId) && currentById.has(tabId)) {
      steps.push({ command: 'closeTab', params: { tabId } });
    }
  }

  const inactiveBaselineTabs = session.baselineTabs.filter((tab) => !tab.active);
  const activeBaselineTabs = session.baselineTabs.filter((tab) => tab.active);
  for (const baseline of [...inactiveBaselineTabs, ...activeBaselineTabs]) {
    const current = currentById.get(baseline.tabId);
    if (!current) {
      steps.push({
        command: 'createTab',
        params: { url: baseline.url, active: baseline.active, windowId: baseline.windowId },
      });
      continue;
    }
    if (current.url !== baseline.url) {
      steps.push({ command: 'switchTab', params: { tabId: baseline.tabId } });
      steps.push({ command: 'navigate', params: { url: baseline.url } });
    }
  }

  const originalActive = session.baselineTabs.find((tab) => tab.active);
  if (originalActive && currentById.has(originalActive.tabId)) {
    steps.push({ command: 'switchTab', params: { tabId: originalActive.tabId } });
  }
  return steps;
}

export function isTerminalExecutionStatus(status: string): boolean {
  return ['success', 'not_found', 'denied', 'approval_required', 'failed', 'cancelled'].includes(
    status,
  );
}

function ensureSession(
  state: RuntimePanelState,
  sessionId: string,
  occurredAt: string,
  identity?: RuntimePanelSession['identity'],
  scope?: RuntimePanelSession['scope'],
): RuntimePanelState {
  if (state.sessions[sessionId]) {
    return state;
  }
  return upsertRuntimePanelSession(state, {
    sessionId,
    identity,
    scope,
    updatedAt: occurredAt,
  });
}

function updateSession(
  state: RuntimePanelState,
  sessionId: string,
  session: RuntimePanelSession,
): RuntimePanelState {
  return { ...state, sessions: { ...state.sessions, [sessionId]: session } };
}

function requireSession(state: RuntimePanelState, sessionId: string): RuntimePanelSession {
  const session = state.sessions[sessionId];
  if (!session) {
    throw new Error(`Unknown runtime panel session: ${sessionId}`);
  }
  return session;
}

function appendBounded<T>(items: readonly T[], item: T, limit: number): readonly T[] {
  const next = [...items, item];
  return next.length > limit ? next.slice(next.length - limit) : next;
}

function cloneTabs(tabs: readonly RuntimePanelBrowserTab[]): readonly RuntimePanelBrowserTab[] {
  return tabs.map((tab) => ({ ...tab }));
}

function toRuntimeTimelineEntry(event: RuntimeLifecycleEvent): RuntimePanelTimelineEntry {
  switch (event.type) {
    case 'runtime.provider.registered':
      return {
        id: event.id,
        type: event.type,
        label: `Provider registered: ${event.payload.providerId}`,
        status: 'info',
        occurredAt: event.occurredAt,
        details: event.payload,
      };
    case 'runtime.provider.disposed':
      return {
        id: event.id,
        type: event.type,
        label: `Provider disposed: ${event.payload.providerId}`,
        status: 'warning',
        occurredAt: event.occurredAt,
        details: event.payload,
      };
    case 'runtime.search.completed':
      return {
        id: event.id,
        type: event.type,
        label: `Search completed (${String(event.payload.resultCount)})`,
        status: 'success',
        occurredAt: event.occurredAt,
        details: event.payload,
      };
    case 'runtime.execution.started':
      return {
        id: event.id,
        type: event.type,
        label: `Execution started: ${event.payload.target}`,
        status: 'running',
        occurredAt: event.occurredAt,
        details: event.payload,
      };
    case 'runtime.execution.permission':
      return {
        id: event.id,
        type: event.type,
        label: `Permission ${event.payload.decision.decision}: ${event.payload.target}`,
        status:
          event.payload.decision.decision === 'allow'
            ? 'success'
            : event.payload.decision.decision === 'approval'
              ? 'warning'
              : 'error',
        occurredAt: event.occurredAt,
        details: event.payload,
      };
    case 'runtime.execution.completed':
      return {
        id: event.id,
        type: event.type,
        label: `Execution ${event.payload.status}: ${event.payload.target}`,
        status: event.payload.status === 'success' ? 'success' : 'error',
        occurredAt: event.occurredAt,
        details: event.payload,
      };
  }
}

function toUiTimelineEntry(
  notification: RuntimePanelUiLifecycleNotification,
): RuntimePanelTimelineEntry {
  const event = notification.event;
  const labelByType: Record<typeof event.type, string> = {
    'tool-input': 'Tool input received',
    'tool-input-partial': 'Tool input streaming',
    'tool-result': 'Tool completed',
    'tool-cancelled': 'Tool cancelled',
    'tool-error': 'Tool failed',
    'host-context-changed': 'Host context changed',
    teardown: 'Runtime UI teardown',
  };
  return {
    id: notification.eventId,
    type: `ui.${event.type}`,
    label: labelByType[event.type],
    status:
      event.type === 'tool-error'
        ? 'error'
        : event.type === 'tool-cancelled' || event.type === 'teardown'
          ? 'warning'
          : event.type === 'tool-result'
            ? 'success'
            : event.type === 'tool-input' || event.type === 'tool-input-partial'
              ? 'running'
              : 'info',
    occurredAt: notification.occurredAt,
    details: event,
  };
}

function terminalizePendingLog(
  logs: readonly RuntimePanelToolLog[],
  commandId: string | undefined,
  fallbackId: string,
  occurredAt: string,
  terminal: Pick<RuntimePanelToolLog, 'status' | 'result' | 'error'>,
): readonly RuntimePanelToolLog[] {
  const index = [...logs]
    .reverse()
    .findIndex(
      (log) => log.status === 'pending' && (commandId === undefined || log.id === commandId),
    );
  if (index === -1) {
    return appendBounded(
      logs,
      {
        id: fallbackId,
        name: 'runtime tool',
        occurredAt,
        ...terminal,
      },
      MAX_TOOL_LOGS,
    );
  }
  const targetIndex = logs.length - index - 1;
  return logs.map((log, logIndex) => (logIndex === targetIndex ? { ...log, ...terminal } : log));
}

function isTabResponse(value: unknown): value is { readonly tabId: number } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'tabId' in value &&
    typeof value.tabId === 'number'
  );
}
