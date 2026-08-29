import { describe, expect, it } from 'vitest';
import {
  applyRuntimeLifecycleEvent,
  applyUiLifecycleEvent,
  beginBrowserCommand,
  beginRuntimePanelRestoration,
  completeBrowserCommand,
  completeRuntimePanelRestoration,
  createRuntimePanelRestorationPlan,
  createRuntimePanelState,
  isRuntimeLifecycleEvent,
  isRuntimePanelState,
  renderRuntimePanel,
  updateRuntimePanelTabs,
  upsertRuntimePanelSession,
  type RuntimeExecutionStatus,
  type RuntimeLifecycleEvent,
  type RuntimePanelBrowserTab,
} from '../src/index.js';

const BASE_TIME = '2026-08-16T16:00:00.000Z';

function tab(
  tabId: number,
  url: string,
  active = false,
  status: 'loading' | 'complete' = 'complete',
): RuntimePanelBrowserTab {
  return {
    tabId,
    url,
    title: `Tab ${String(tabId)}`,
    status,
    windowId: 1,
    active,
  };
}

function executionEvent(
  sessionId: string,
  type: 'runtime.execution.started' | 'runtime.execution.completed',
  status: RuntimeExecutionStatus = 'success',
): RuntimeLifecycleEvent {
  if (type === 'runtime.execution.started') {
    return {
      protocolVersion: '1.0.0',
      id: `${sessionId}:started`,
      type,
      occurredAt: BASE_TIME,
      context: {
        principal: { id: 'agent-1', kind: 'agent' },
        scope: { sessionId },
      },
      payload: {
        executionId: `execution-${sessionId}`,
        target: 'browser.navigate',
        providerId: 'browser-provider',
      },
    };
  }
  return {
    protocolVersion: '1.0.0',
    id: `${sessionId}:completed`,
    type,
    occurredAt: '2026-08-16T16:01:00.000Z',
    context: {
      principal: { id: 'agent-1', kind: 'agent' },
      scope: { sessionId },
    },
    payload: {
      executionId: `execution-${sessionId}`,
      target: 'browser.navigate',
      status,
      receiptId: `receipt-${sessionId}`,
    },
  };
}

describe('runtime panel session model', () => {
  it('scopes lifecycle updates to the event session', () => {
    let state = createRuntimePanelState();
    state = upsertRuntimePanelSession(state, {
      sessionId: 'session-a',
      tabs: [tab(1, 'https://a.example', true)],
      updatedAt: BASE_TIME,
    });
    state = upsertRuntimePanelSession(state, {
      sessionId: 'session-b',
      tabs: [tab(2, 'https://b.example', true)],
      updatedAt: BASE_TIME,
    });

    state = applyRuntimeLifecycleEvent(
      state,
      executionEvent('session-a', 'runtime.execution.started'),
    );

    expect(state.sessions['session-a']?.execution.status).toBe('running');
    expect(state.sessions['session-a']?.timeline).toHaveLength(1);
    expect(state.sessions['session-b']?.execution.status).toBe('idle');
    expect(state.sessions['session-b']?.timeline).toHaveLength(0);
  });

  it('keeps two concurrent sessions, tabs, and chats independent', () => {
    let state = createRuntimePanelState();
    state = upsertRuntimePanelSession(state, {
      sessionId: 'session-a',
      title: 'Research',
      chat: [{ id: 'a1', role: 'user', content: 'Open A', createdAt: BASE_TIME }],
      tabs: [tab(1, 'https://a.example', true)],
      updatedAt: BASE_TIME,
    });
    state = upsertRuntimePanelSession(state, {
      sessionId: 'session-b',
      title: 'Checkout',
      chat: [{ id: 'b1', role: 'assistant', content: 'Opening B', createdAt: BASE_TIME }],
      tabs: [tab(2, 'https://b.example', true)],
      updatedAt: BASE_TIME,
    });

    expect(Object.keys(state.sessions)).toEqual(['session-a', 'session-b']);
    expect(state.sessions['session-a']?.tabs[0]?.url).toBe('https://a.example');
    expect(state.sessions['session-b']?.tabs[0]?.url).toBe('https://b.example');
    expect(state.sessions['session-a']?.chat[0]?.content).toBe('Open A');
    expect(state.sessions['session-b']?.chat[0]?.content).toBe('Opening B');
  });

  it('renders runtime and UI lifecycle events in the live timeline', () => {
    let state = createRuntimePanelState();
    state = upsertRuntimePanelSession(state, {
      sessionId: 'session-a',
      tabs: [tab(1, 'https://a.example', true)],
      updatedAt: BASE_TIME,
    });
    state = applyRuntimeLifecycleEvent(
      state,
      executionEvent('session-a', 'runtime.execution.started'),
    );
    state = applyUiLifecycleEvent(state, {
      sessionId: 'session-a',
      eventId: 'tool-input-1',
      occurredAt: '2026-08-16T16:00:10.000Z',
      event: { type: 'tool-input', input: { url: 'https://a.example' } },
    });
    state = applyUiLifecycleEvent(state, {
      sessionId: 'session-a',
      eventId: 'tool-result-1',
      occurredAt: '2026-08-16T16:00:20.000Z',
      event: { type: 'tool-result', result: { ok: true } },
    });
    state = applyRuntimeLifecycleEvent(
      state,
      executionEvent('session-a', 'runtime.execution.completed'),
    );

    const html = renderRuntimePanel(state);
    expect(html).toContain('Execution started: browser.navigate');
    expect(html).toContain('Tool input received');
    expect(html).toContain('Tool completed');
    expect(html).toContain('Execution success: browser.navigate');
    expect(html).toContain('runtime.execution.completed');
  });

  it('correlates interleaved tool results by command ID', () => {
    let state = upsertRuntimePanelSession(createRuntimePanelState(), {
      sessionId: 'session-a',
      updatedAt: BASE_TIME,
    });
    state = applyUiLifecycleEvent(state, {
      sessionId: 'session-a',
      eventId: 'input-a',
      commandId: 'command-a',
      occurredAt: BASE_TIME,
      event: { type: 'tool-input', input: { marker: 'a' } },
    });
    state = applyUiLifecycleEvent(state, {
      sessionId: 'session-a',
      eventId: 'input-b',
      commandId: 'command-b',
      occurredAt: BASE_TIME,
      event: { type: 'tool-input', input: { marker: 'b' } },
    });
    state = applyUiLifecycleEvent(state, {
      sessionId: 'session-a',
      eventId: 'result-a',
      commandId: 'command-a',
      occurredAt: BASE_TIME,
      event: { type: 'tool-result', result: { marker: 'result-a' } },
    });
    state = applyUiLifecycleEvent(state, {
      sessionId: 'session-a',
      eventId: 'result-b',
      commandId: 'command-b',
      occurredAt: BASE_TIME,
      event: { type: 'tool-result', result: { marker: 'result-b' } },
    });

    expect(state.sessions['session-a']?.toolLogs).toEqual([
      expect.objectContaining({
        id: 'command-a',
        status: 'success',
        result: { marker: 'result-a' },
      }),
      expect.objectContaining({
        id: 'command-b',
        status: 'success',
        result: { marker: 'result-b' },
      }),
    ]);
  });

  it.each<RuntimeExecutionStatus>(['success', 'failed'])(
    'builds and completes restoration after a %s execution',
    (status) => {
      let state = createRuntimePanelState();
      state = upsertRuntimePanelSession(state, {
        sessionId: 'session-a',
        tabs: [tab(1, 'https://original.example', true), tab(2, 'https://secondary.example')],
        updatedAt: BASE_TIME,
      });
      state = applyRuntimeLifecycleEvent(
        state,
        executionEvent('session-a', 'runtime.execution.completed', status),
      );
      state = beginBrowserCommand(
        state,
        'session-a',
        'createTab',
        'create-tab',
        '2026-08-16T16:01:10.000Z',
        { active: true },
      );
      state = completeBrowserCommand(
        state,
        'session-a',
        'createTab',
        'create-tab',
        {
          id: 'create-tab',
          success: true,
          data: { tabId: 3, url: 'https://created.example', title: 'Created', active: true },
        },
        '2026-08-16T16:01:11.000Z',
      );
      state = updateRuntimePanelTabs(
        state,
        'session-a',
        [
          tab(1, 'https://changed.example'),
          tab(2, 'https://secondary.example'),
          tab(3, 'https://created.example', true),
        ],
        '2026-08-16T16:01:12.000Z',
      );

      const session = state.sessions['session-a'];
      expect(session).toBeDefined();
      if (!session) {
        throw new Error('Expected session-a to exist');
      }
      const steps = createRuntimePanelRestorationPlan(session, session.tabs);
      expect(steps).toEqual(
        expect.arrayContaining([
          { command: 'closeTab', params: { tabId: 3 } },
          { command: 'switchTab', params: { tabId: 1 } },
          { command: 'navigate', params: { url: 'https://original.example' } },
        ]),
      );

      state = beginRuntimePanelRestoration(state, 'session-a', '2026-08-16T16:02:00.000Z');
      state = completeRuntimePanelRestoration(state, 'session-a', '2026-08-16T16:02:10.000Z');
      expect(state.sessions['session-a']?.restoration.status).toBe('restored');
      expect(state.sessions['session-a']?.createdTabIds).toEqual([]);
    },
  );

  it('rejects malformed persisted state and lifecycle payloads', () => {
    expect(
      isRuntimePanelState({
        schemaVersion: '1.0.0',
        selectedSessionId: 'session-a',
        sessions: { 'session-a': { sessionId: 'session-a' } },
      }),
    ).toBe(false);
    expect(
      isRuntimeLifecycleEvent({
        protocolVersion: '1.0.0',
        id: 'broken-event',
        type: 'runtime.execution.completed',
        occurredAt: BASE_TIME,
        payload: {},
      }),
    ).toBe(false);
  });
});
