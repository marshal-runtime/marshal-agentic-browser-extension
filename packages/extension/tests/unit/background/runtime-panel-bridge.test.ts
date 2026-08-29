import { describe, expect, it, vi } from 'vitest';
import {
  RUNTIME_PANEL_CHANNEL,
  RuntimePanelMethod,
  type RuntimePanelBrowserTab,
  type RuntimePanelChannelMessage,
} from '@marshal/runtime-browser-panel';
import type { CommandRequest, CommandResponse } from '@agentic-browser/shared';
import type { SessionState } from '../../../src/infrastructure/session-manager.js';
import { RuntimePanelBackgroundBridge } from '../../../src/background/runtime-panel-bridge.js';

const NOW = '2026-08-16T16:00:00.000Z';

function tab(tabId: number, url: string, active = false): RuntimePanelBrowserTab {
  return {
    tabId,
    url,
    title: `Tab ${String(tabId)}`,
    status: 'complete',
    windowId: 1,
    active,
  };
}

function message(id: string, method: string, params: unknown): RuntimePanelChannelMessage {
  return {
    channel: RUNTIME_PANEL_CHANNEL,
    message: { jsonrpc: '2.0', id, method, params },
  };
}

function createBridge(
  route: (request: CommandRequest) => Promise<CommandResponse>,
  releaseBrowserSession?: (browserSessionId: string) => Promise<void>,
): RuntimePanelBackgroundBridge {
  const tabs = [tab(1, 'https://a.example', true), tab(2, 'https://b.example')];
  let persisted: SessionState = {
    version: 1,
    timestamp: Date.now(),
    activeTabs: [],
    connections: [],
    scrollPositions: {},
    metadata: {},
  };
  const bridge = new RuntimePanelBackgroundBridge(
    { route },
    {
      getAllTabs: () =>
        tabs.map((entry) => ({
          id: entry.tabId,
          url: entry.url,
          title: entry.title,
          status: entry.status,
          favIconUrl: entry.favIconUrl ?? '',
          windowId: entry.windowId ?? 1,
          active: entry.active,
        })),
      onChange: () => () => {},
    },
    {
      load: () => Promise.resolve(persisted),
      save: (next) => {
        persisted = { ...persisted, ...next, timestamp: Date.now(), version: 1 };
        return Promise.resolve();
      },
      getState: () => persisted,
    },
    {
      debug: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    vi.fn().mockResolvedValue(undefined),
    releaseBrowserSession,
  );
  return bridge;
}

async function syncSession(
  bridge: RuntimePanelBackgroundBridge,
  sessionId: string,
  sessionTab: RuntimePanelBrowserTab,
): Promise<void> {
  await bridge.handleMessage(
    message(`${sessionId}:sync`, RuntimePanelMethod.sessionSync, {
      sessionId,
      scope: { sessionId, threadId: `chat:${sessionId}` },
      execution: {
        executionId: `execution:${sessionId}`,
        target: 'browser',
        status: 'running',
      },
      tabs: [sessionTab],
      activeTabId: sessionTab.tabId,
      updatedAt: NOW,
    }),
  );
}

describe('RuntimePanelBackgroundBridge', () => {
  it('rejects browser commands targeting another session tab', async () => {
    const route = vi.fn<(request: CommandRequest) => Promise<CommandResponse>>();
    const bridge = createBridge(route);
    await bridge.init();
    await syncSession(bridge, 'session-a', tab(1, 'https://a.example', true));
    await syncSession(bridge, 'session-b', tab(2, 'https://b.example', true));

    const response = await bridge.handleMessage(
      message('cross-session', RuntimePanelMethod.browserCommand, {
        sessionId: 'session-a',
        command: 'switchTab',
        tabId: 2,
      }),
    );

    expect(response?.message.error).toMatchObject({
      code: -32602,
      message: expect.stringContaining('not owned by runtime panel session session-a'),
    });
    expect(route).not.toHaveBeenCalled();
    expect(bridge.getState().sessions['session-b']?.tabs[0]?.url).toBe('https://b.example');
  });

  it('filters listTabs responses to tabs owned by the requesting session', async () => {
    const route = vi.fn(
      (request: CommandRequest): Promise<CommandResponse> =>
        Promise.resolve({
          id: request.id,
          success: true,
          data: {
            tabs: [
              { tabId: 1, url: 'https://a.example', title: 'A', active: true },
              { tabId: 2, url: 'https://b.example', title: 'B', active: false },
            ],
          },
          metadata: { duration: 1, timestamp: Date.now(), commandId: request.id },
        }),
    );
    const bridge = createBridge(route);
    await bridge.init();
    await syncSession(bridge, 'session-a', tab(1, 'https://a.example', true));

    const response = await bridge.handleMessage(
      message('list-tabs', RuntimePanelMethod.browserCommand, {
        sessionId: 'session-a',
        command: 'listTabs',
      }),
    );

    expect(response?.message.result).toMatchObject({
      response: {
        data: {
          tabs: [{ tabId: 1 }],
        },
      },
    });
    expect(route).toHaveBeenCalledWith(
      expect.objectContaining({
        context: {
          chatId: 'chat:session-a',
          executionId: 'execution:session-a',
          browserSessionId: 'session-a',
        },
      }),
    );
  });

  it('returns a protocol error for malformed runtime lifecycle events', async () => {
    const route = vi.fn<(request: CommandRequest) => Promise<CommandResponse>>();
    const bridge = createBridge(route);
    await bridge.init();

    const response = await bridge.handleMessage(
      message('bad-lifecycle', RuntimePanelMethod.runtimeLifecycle, {
        protocolVersion: '1.0.0',
        id: 'event-1',
        type: 'runtime.execution.completed',
        occurredAt: NOW,
        payload: {},
      }),
    );

    expect(response?.message.error).toMatchObject({
      code: -32602,
      message: 'Invalid runtime lifecycle event',
    });
  });

  it('consumes scoped lifecycle, tool, screenshot, and snapshot notifications', async () => {
    const bridge = createBridge(vi.fn());
    await bridge.init();
    await syncSession(bridge, 'browser-a', tab(1, 'https://a.example', true));
    await syncSession(bridge, 'browser-b', tab(2, 'https://b.example', true));

    await bridge.handleMessage(
      message('runtime-a', RuntimePanelMethod.runtimeLifecycle, {
        protocolVersion: '1.0.0',
        id: 'runtime-a',
        type: 'runtime.execution.started',
        occurredAt: NOW,
        context: {
          principal: { id: 'agentic-browser', kind: 'runtime-extension' },
          scope: { sessionId: 'browser-a', threadId: 'chat-a' },
          executionId: 'exec-a',
        },
        payload: {
          executionId: 'exec-a',
          target: 'browser_screenshot',
          providerId: 'agentic-browser.extension',
        },
      }),
    );
    await bridge.handleMessage(
      message('ui-a', RuntimePanelMethod.uiLifecycle, {
        sessionId: 'browser-a',
        eventId: 'ui-a',
        occurredAt: NOW,
        event: { type: 'tool-input', input: { command: 'browser_screenshot' } },
      }),
    );
    await bridge.handleMessage(
      message('artifact-a', RuntimePanelMethod.artifact, {
        sessionId: 'browser-a',
        artifact: {
          id: 'screenshot-a',
          kind: 'screenshot',
          mediaType: 'image/png',
          data: 'cG5n',
          createdAt: NOW,
        },
      }),
    );
    await bridge.handleMessage(
      message('artifact-b', RuntimePanelMethod.artifact, {
        sessionId: 'browser-b',
        artifact: {
          id: 'snapshot-b',
          kind: 'accessibility-snapshot',
          mediaType: 'text/yaml',
          text: '- heading "B"',
          createdAt: NOW,
        },
      }),
    );

    const state = bridge.getState();
    expect(state.sessions['browser-a']).toMatchObject({
      execution: { executionId: 'exec-a', status: 'running' },
      artifacts: [{ id: 'screenshot-a', kind: 'screenshot' }],
    });
    expect(state.sessions['browser-a']?.toolLogs).toHaveLength(1);
    expect(state.sessions['browser-b']).toMatchObject({
      execution: { executionId: 'execution:browser-b', status: 'running' },
      artifacts: [{ id: 'snapshot-b', kind: 'accessibility-snapshot' }],
    });
    expect(state.sessions['browser-b']?.toolLogs).toHaveLength(0);
  });

  it('releases only the cleaned runtime browser session', async () => {
    const release = vi.fn().mockResolvedValue(undefined);
    const bridge = createBridge(vi.fn(), release);
    await bridge.init();
    await syncSession(bridge, 'browser-a', tab(1, 'https://a.example', true));
    await syncSession(bridge, 'browser-b', tab(2, 'https://b.example', true));

    await bridge.handleMessage(
      message('cleanup-a', RuntimePanelMethod.cleanupSession, { sessionId: 'browser-a' }),
    );
    await bridge.handleMessage(
      message('cleanup-a-again', RuntimePanelMethod.cleanupSession, { sessionId: 'browser-a' }),
    );

    expect(release).toHaveBeenCalledTimes(2);
    expect(release).toHaveBeenNthCalledWith(1, 'browser-a');
    expect(release).toHaveBeenNthCalledWith(2, 'browser-a');
    expect(bridge.getState().sessions['browser-a']).toBeUndefined();
    expect(bridge.getState().sessions['browser-b']).toBeDefined();
  });
});
