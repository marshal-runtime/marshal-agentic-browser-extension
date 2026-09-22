import { describe, expect, it, vi } from 'vitest';
import { NativeMessagingClient } from '@agentic-browser/mcp-server/runtime-api';
import {
  RuntimePanelMethod,
  isRuntimePanelChannelMessage,
  type RuntimePanelChannelMessage,
} from '@marshal/runtime-browser-panel';
import {
  createMarshalRuntimeHostBridge,
  PANEL_FOCUS_TOOL_ID,
  PANEL_OPEN_OR_FOCUS_TOOL_ID,
  PANEL_OPEN_TOOL_ID,
} from '../src/host.js';
import type { BrowserLifecycleEvent } from '../src/contracts.js';

const requestContext = {
  chatId: 'chat-1',
  executionId: 'exec-1',
  browserSessionId: 'browser-session-1',
};

describe('Marshal runtime host bridge', () => {
  it('delegates panel open and focus host tools without invoking browser transport', async () => {
    const open = vi.fn().mockResolvedValue({ opened: true });
    const focus = vi.fn().mockResolvedValue({ focused: true });
    const openOrFocus = vi.fn().mockResolvedValue({ focused: true });
    const bridge = createMarshalRuntimeHostBridge({
      lifecycle: { apply: vi.fn() },
      panel: { open, focus, openOrFocus },
      nativeMessagingHostPath: 'unused-for-panel-tools',
    });

    await expect(
      bridge.invokePanelHostTool({
        toolId: PANEL_OPEN_OR_FOCUS_TOOL_ID,
        input: {},
        context: requestContext,
      }),
    ).resolves.toEqual({ focused: true });
    await expect(
      bridge.invokePanelHostTool({
        toolId: PANEL_OPEN_TOOL_ID,
        input: {},
        context: requestContext,
      }),
    ).resolves.toEqual({ opened: true });
    await expect(
      bridge.invokePanelHostTool({
        toolId: PANEL_FOCUS_TOOL_ID,
        input: {},
        context: requestContext,
      }),
    ).resolves.toEqual({ focused: true });

    expect(open).toHaveBeenCalledWith({
      toolId: PANEL_OPEN_TOOL_ID,
      input: {},
      context: requestContext,
    });
    expect(focus).toHaveBeenCalledWith({
      toolId: PANEL_FOCUS_TOOL_ID,
      input: {},
      context: requestContext,
    });
    expect(openOrFocus).toHaveBeenCalledWith({
      toolId: PANEL_OPEN_OR_FOCUS_TOOL_ID,
      input: {},
      context: requestContext,
    });
  });

  it('adapts Marshal invocation context to the same browser session used by activation', async () => {
    const focus = vi.fn().mockResolvedValue({ focused: true });
    const bridge = createMarshalRuntimeHostBridge({
      lifecycle: { apply: vi.fn() },
      panel: { open: vi.fn(), focus, openOrFocus: vi.fn() },
      nativeMessagingHostPath: 'unused-for-panel-tools',
    });
    const invocation = {
      principal: { id: 'user-1', kind: 'user' },
      identity: { harnessId: 'marshal', installationId: 'install-1' },
      scope: { workspaceId: 'workspace-1', sessionId: 'chat-1' },
      executionId: 'exec-1',
    };
    const runtimeSession = bridge.resolveBrowserSession?.(invocation);

    await bridge.invokePanelHostToolForInvocation(PANEL_FOCUS_TOOL_ID, {}, invocation);

    expect(focus).toHaveBeenCalledWith({
      toolId: PANEL_FOCUS_TOOL_ID,
      input: {},
      context: runtimeSession?.context,
    });
  });

  it('blocks browser readback after a secret write while preserving safe interactions', async () => {
    const execute = vi.fn().mockResolvedValue({ success: true });
    const executeSecretType = vi.fn().mockResolvedValue({ success: true });
    const panelClient = createPanelClient();
    const bridge = createMarshalRuntimeHostBridge({
      lifecycle: passthroughLifecycle(),
      panel: { open: vi.fn(), focus: vi.fn(), openOrFocus: vi.fn() },
      nativeClient: panelClient.client,
      browserExecutor: { execute, executeSecretType },
    });
    const invocation = {
      principal: { id: 'agent-1', kind: 'agent' },
      scope: { sessionId: 'chat-1' },
      executionId: 'exec-1',
    };

    await bridge.invokeSecretType(
      {
        selector: '#password',
        text: 'secret-only-in-the-host-path',
        allowedUrlPatterns: ['https://accounts.google.com/*'],
      },
      invocation,
    );
    const browserContext = bridge.resolveBrowserSession?.(invocation)?.context;
    if (!browserContext) throw new Error('Expected a resolved browser context');

    await expect(
      bridge.invokeBrowserCommand('browser_execute_script', {}, browserContext),
    ).resolves.toMatchObject({
      success: false,
      error: { code: 'SECRET_READBACK_BLOCKED' },
    });
    await expect(
      bridge.invokeBrowserCommand('browser_click', { selector: '#submit' }, browserContext),
    ).resolves.toEqual({ success: true });
    expect(executeSecretType).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledOnce();
  });

  it('routes an instance-bound secret request to the configured Safari executor', async () => {
    const defaultSecretExecutor = vi.fn().mockResolvedValue({ success: true });
    const safariSecretExecutor = vi.fn().mockResolvedValue({ success: true });
    const bridge = createMarshalRuntimeHostBridge({
      lifecycle: passthroughLifecycle(),
      panel: { open: vi.fn(), focus: vi.fn(), openOrFocus: vi.fn() },
      nativeClient: createPanelClient().client,
      browserExecutor: {
        execute: vi.fn().mockResolvedValue({ success: true }),
        executeSecretType: defaultSecretExecutor,
      },
      secretExecutors: {
        'safari-work-profile': { executeSecretType: safariSecretExecutor },
      },
    });
    const invocation = {
      principal: { id: 'agent-1', kind: 'agent' },
      scope: { sessionId: 'chat-1' },
      executionId: 'exec-safari',
      browserInstanceId: 'safari-work-profile',
    };

    await expect(
      bridge.invokeSecretType(
        { selector: '#password', text: 'secret', allowedUrlPatterns: ['https://example.test/*'] },
        invocation,
      ),
    ).resolves.toEqual({ success: true });
    expect(safariSecretExecutor).toHaveBeenCalledWith(
      expect.objectContaining({ browserInstanceId: 'safari-work-profile' }),
      expect.objectContaining({ browserInstanceId: 'safari-work-profile' }),
    );
    expect(defaultSecretExecutor).not.toHaveBeenCalled();
  });

  it('automatically opens or focuses the panel for a browser execution', async () => {
    const openOrFocus = vi.fn();
    const bridge = createMarshalRuntimeHostBridge({
      lifecycle: { apply: vi.fn() },
      panel: { open: vi.fn(), focus: vi.fn(), openOrFocus },
      nativeMessagingHostPath: 'unused-for-panel-tools',
    });

    await bridge.openOrFocusPanel(requestContext);

    expect(openOrFocus).toHaveBeenCalledOnce();
    expect(openOrFocus).toHaveBeenCalledWith({
      toolId: PANEL_OPEN_OR_FOCUS_TOOL_ID,
      input: {},
      context: requestContext,
    });
  });

  it('persists lifecycle events through the injected durable coordinator', async () => {
    const apply = vi
      .fn()
      .mockImplementation(
        async (
          _kind: string,
          request: unknown,
          callback: (normalized: unknown) => Promise<unknown>,
        ) => callback(request),
      );
    const panelClient = createPanelClient();
    const bridge = createMarshalRuntimeHostBridge({
      lifecycle: { apply },
      panel: { open: vi.fn(), focus: vi.fn(), openOrFocus: vi.fn() },
      nativeMessagingHostPath: 'unused-for-lifecycle-events',
      nativeClient: panelClient.client,
    });
    const event: BrowserLifecycleEvent = {
      protocolVersion: '1.0.0',
      id: 'event-1',
      type: 'navigation',
      occurredAt: '2026-08-16T00:00:00.000Z',
      context: requestContext,
      command: 'browser_navigate',
    };

    await bridge.publishLifecycleEvent(event);

    expect(apply).toHaveBeenCalledWith(
      'navigation',
      expect.objectContaining({
        sessionId: 'chat-1',
        eventId: 'event-1',
        executionId: 'exec-1',
        browserSessionId: 'browser-session-1',
        command: 'browser_navigate',
      }),
      expect.any(Function),
    );
    expect(panelClient.requests.map((request) => request.message.method)).toEqual([
      RuntimePanelMethod.sessionSync,
      RuntimePanelMethod.runtimeLifecycle,
      RuntimePanelMethod.uiLifecycle,
    ]);
  });

  it('delivers scoped status, actions, screenshots, and snapshots to the panel protocol', async () => {
    const panelClient = createPanelClient();
    const bridge = createMarshalRuntimeHostBridge({
      lifecycle: passthroughLifecycle(),
      panel: { open: vi.fn(), focus: vi.fn(), openOrFocus: vi.fn() },
      nativeClient: panelClient.client,
    });
    const otherContext = {
      chatId: 'chat-2',
      executionId: 'exec-2',
      browserSessionId: 'browser-session-2',
    };

    await bridge.publishLifecycleEvent({
      protocolVersion: '1.0.0',
      id: 'action-1',
      type: 'interaction',
      occurredAt: '2026-08-16T00:00:00.000Z',
      context: requestContext,
      command: 'browser_screenshot',
      details: { operationId: 'operation-1', input: { format: 'png' } },
    });
    await bridge.publishLifecycleEvent({
      protocolVersion: '1.0.0',
      id: 'screenshot-1',
      type: 'completion',
      occurredAt: '2026-08-16T00:00:01.000Z',
      context: requestContext,
      command: 'browser_screenshot',
      details: {
        operationId: 'operation-1',
        result: {
          success: true,
          data: { data: 'cG5n', mimeType: 'image/png', width: 800, height: 600 },
          metadata: { duration: 1, timestamp: 1, commandId: 'command-1', activeTabId: 11 },
        },
      },
    });
    await bridge.publishLifecycleEvent({
      protocolVersion: '1.0.0',
      id: 'snapshot-2',
      type: 'completion',
      occurredAt: '2026-08-16T00:00:02.000Z',
      context: otherContext,
      command: 'browser_accessibility_tree',
      details: {
        result: {
          success: true,
          data: { snapshot: '- button "Continue" [ref=e1]' },
          metadata: { duration: 1, timestamp: 2, activeTabId: 22 },
        },
      },
    });

    const artifacts = panelClient.requests.filter(
      (request) => request.message.method === RuntimePanelMethod.artifact,
    );
    expect(artifacts).toHaveLength(2);
    expect(artifacts[0]?.message.params).toMatchObject({
      sessionId: 'browser-session-1',
      artifact: {
        kind: 'screenshot',
        mediaType: 'image/png',
        data: 'cG5n',
        metadata: { chatId: 'chat-1', executionId: 'exec-1', activeTabId: 11 },
      },
    });
    expect(artifacts[1]?.message.params).toMatchObject({
      sessionId: 'browser-session-2',
      artifact: {
        kind: 'accessibility-snapshot',
        text: '- button "Continue" [ref=e1]',
      },
    });
    const sessionSyncs = panelClient.requests.filter(
      (request) => request.message.method === RuntimePanelMethod.sessionSync,
    );
    expect(sessionSyncs.map((request) => request.message.params)).toEqual([
      expect.objectContaining({ sessionId: 'browser-session-1' }),
      expect.objectContaining({ sessionId: 'browser-session-1', activeTabId: 11 }),
      expect.objectContaining({ sessionId: 'browser-session-2', activeTabId: 22 }),
    ]);
    const toolEvents = panelClient.requests.filter(
      (request) => request.message.method === RuntimePanelMethod.uiLifecycle,
    );
    expect(toolEvents.slice(0, 2).map((request) => request.message.params)).toEqual([
      expect.objectContaining({ commandId: 'operation-1' }),
      expect.objectContaining({ commandId: 'operation-1' }),
    ]);
  });

  it('prevents stale automatic focus after a newer execution or explicit selection', async () => {
    const panelClient = createPanelClient();
    const openOrFocus = vi.fn();
    const bridge = createMarshalRuntimeHostBridge({
      lifecycle: passthroughLifecycle(),
      panel: { open: vi.fn(), focus: vi.fn(), openOrFocus },
      nativeClient: panelClient.client,
    });
    const newer = {
      ...requestContext,
      executionId: 'exec-2',
      browserSessionId: 'browser-session-2',
    };

    await bridge.publishLifecycleEvent({
      protocolVersion: '1.0.0',
      id: 'old-created',
      type: 'created',
      occurredAt: '2026-08-16T00:00:00.000Z',
      context: requestContext,
    });
    await bridge.publishLifecycleEvent({
      protocolVersion: '1.0.0',
      id: 'new-created',
      type: 'created',
      occurredAt: '2026-08-16T00:00:01.000Z',
      context: newer,
    });
    await bridge.openOrFocusPanel(requestContext);
    await bridge.openOrFocusPanel(newer);

    expect(openOrFocus).toHaveBeenCalledOnce();
    expect(openOrFocus).toHaveBeenCalledWith(expect.objectContaining({ context: newer }));

    await bridge.invokePanelHostTool({
      toolId: PANEL_FOCUS_TOOL_ID,
      input: {},
      context: requestContext,
    });
    await bridge.openOrFocusPanel(newer);
    expect(openOrFocus).toHaveBeenCalledOnce();
  });

  it('requests scoped panel cleanup before disconnecting the runtime transport', async () => {
    const panelClient = createPanelClient();
    const bridge = createMarshalRuntimeHostBridge({
      lifecycle: passthroughLifecycle(),
      panel: { open: vi.fn(), focus: vi.fn(), openOrFocus: vi.fn() },
      nativeClient: panelClient.client,
    });

    await bridge.publishLifecycleEvent({
      protocolVersion: '1.0.0',
      id: 'created-1',
      type: 'created',
      occurredAt: '2026-08-16T00:00:00.000Z',
      context: requestContext,
    });
    await bridge.dispose?.();

    expect(panelClient.requests.at(-1)?.message).toMatchObject({
      method: RuntimePanelMethod.cleanupSession,
      params: { sessionId: 'browser-session-1' },
    });
    expect(panelClient.client.disconnect).toHaveBeenCalledOnce();
  });

  it('attempts every session cleanup and reports aggregate failures', async () => {
    const panelClient = createPanelClient((request) =>
      request.message.method === RuntimePanelMethod.cleanupSession &&
      isRecord(request.message.params) &&
      request.message.params['sessionId'] === 'browser-session-1'
        ? 'first cleanup failed'
        : undefined,
    );
    const bridge = createMarshalRuntimeHostBridge({
      lifecycle: passthroughLifecycle(),
      panel: { open: vi.fn(), focus: vi.fn(), openOrFocus: vi.fn() },
      nativeClient: panelClient.client,
    });
    await bridge.publishLifecycleEvent({
      protocolVersion: '1.0.0',
      id: 'created-1',
      type: 'created',
      occurredAt: '2026-08-16T00:00:00.000Z',
      context: requestContext,
    });
    await bridge.publishLifecycleEvent({
      protocolVersion: '1.0.0',
      id: 'created-2',
      type: 'created',
      occurredAt: '2026-08-16T00:00:01.000Z',
      context: {
        chatId: 'chat-2',
        executionId: 'exec-2',
        browserSessionId: 'browser-session-2',
      },
    });

    await expect(bridge.dispose?.()).rejects.toThrow('Failed to clean up runtime browser sessions');
    const cleanupRequests = panelClient.requests.filter(
      (request) => request.message.method === RuntimePanelMethod.cleanupSession,
    );
    expect(cleanupRequests.map((request) => request.message.params)).toEqual([
      { sessionId: 'browser-session-1' },
      { sessionId: 'browser-session-2' },
    ]);
    expect(panelClient.client.disconnect).toHaveBeenCalledOnce();
  });

  it('does not project panel focus failures as browser execution failures', async () => {
    const panelClient = createPanelClient();
    const lifecycle = passthroughLifecycle();
    const bridge = createMarshalRuntimeHostBridge({
      lifecycle,
      panel: { open: vi.fn(), focus: vi.fn(), openOrFocus: vi.fn() },
      nativeClient: panelClient.client,
    });

    await bridge.publishLifecycleEvent({
      protocolVersion: '1.0.0',
      id: 'panel-failure',
      type: 'failure',
      occurredAt: '2026-08-16T00:00:00.000Z',
      context: requestContext,
      command: 'browser_navigate',
      details: { phase: 'panel-open-or-focus', error: { message: 'Panel unavailable' } },
    });

    expect(lifecycle.apply).toHaveBeenCalledOnce();
    expect(panelClient.requests).toEqual([]);
  });
});

function passthroughLifecycle(): {
  apply: ReturnType<typeof vi.fn>;
} {
  return {
    apply: vi.fn(
      async (
        _kind: string,
        request: unknown,
        callback: (normalized: unknown) => Promise<unknown>,
      ) => callback(request),
    ),
  };
}

function createPanelClient(
  errorFor?: (request: RuntimePanelChannelMessage) => string | undefined,
): {
  readonly client: NativeMessagingClient;
  readonly requests: RuntimePanelChannelMessage[];
} {
  const client = new NativeMessagingClient('unused');
  const listeners = new Set<(message: unknown) => void>();
  const requests: RuntimePanelChannelMessage[] = [];
  vi.spyOn(client, 'isConnected').mockReturnValue(true);
  vi.spyOn(client, 'connect').mockImplementation(() => {});
  vi.spyOn(client, 'disconnect').mockImplementation(() => {});
  vi.spyOn(client, 'onMessage').mockImplementation((listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  });
  vi.spyOn(client, 'send').mockImplementation((message) => {
    if (!isRuntimePanelChannelMessage(message)) {
      throw new Error('Expected a runtime panel message');
    }
    requests.push(message);
    const error = errorFor?.(message);
    const response: RuntimePanelChannelMessage = {
      channel: message.channel,
      message: {
        jsonrpc: '2.0',
        id: message.message.id,
        ...(error === undefined
          ? { result: { accepted: true } }
          : { error: { code: -32000, message: error } }),
      },
    };
    for (const listener of [...listeners]) {
      listener(response);
    }
  });
  return { client, requests };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
