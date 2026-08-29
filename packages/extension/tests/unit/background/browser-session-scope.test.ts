import { describe, expect, it, vi } from 'vitest';
import type { CommandRequest, ErrorResponse, Result, TabInfo } from '@agentic-browser/shared';
import { err, ok } from '@agentic-browser/shared';
import {
  BrowserSessionContextScope,
  BrowserSessionScopeError,
} from '../../../src/background/browser-session-scope.js';

function request(
  chatId: string,
  executionId: string,
  browserSessionId: string,
  command: CommandRequest['command'] = 'navigate',
  params: Record<string, unknown> = { url: 'https://example.test' },
): CommandRequest {
  return {
    id: `${chatId}:${executionId}:${command}`,
    command,
    params,
    timestamp: Date.now(),
    context: { chatId, executionId, browserSessionId },
  };
}

function createAdapter() {
  let nextContextId = 0;
  let nextWindowId = 0;
  let nextTabId = 100;
  let activeContextId: string | undefined;
  const contexts = new Map<
    string,
    { windowId: number; tabIds: Set<number>; storage: Map<string, string> }
  >();

  const createIsolatedBrowserContext = vi.fn(async () => {
    const browserContextId = `context-${++nextContextId}`;
    const windowId = ++nextWindowId;
    const tabId = ++nextTabId;
    contexts.set(browserContextId, {
      windowId,
      tabIds: new Set([tabId]),
      storage: new Map(),
    });
    return ok({
      browserContextId,
      windowId,
      initialTab: {
        tabId,
        url: 'about:blank',
        title: '',
        active: true,
        windowId,
      },
    });
  });
  const closeIsolatedBrowserContext = vi.fn(
    async (browserContextId: string): Promise<Result<void, ErrorResponse>> => {
      if (!contexts.delete(browserContextId)) {
        return err({ code: 'UNKNOWN', message: 'Unknown context' });
      }
      return ok(undefined);
    },
  );
  const isTabInIsolatedBrowserContext = vi.fn(
    async (browserContextId: string, tabId: number): Promise<Result<boolean, ErrorResponse>> =>
      ok(contexts.get(browserContextId)?.tabIds.has(tabId) ?? false),
  );
  const activateIsolatedBrowserTab = vi.fn(
    async (browserContextId: string, tabId: number): Promise<Result<void, ErrorResponse>> => {
      if (!contexts.get(browserContextId)?.tabIds.has(tabId)) {
        return err({ code: 'TAB_NOT_FOUND', message: 'Tab is outside context' });
      }
      activeContextId = browserContextId;
      return ok(undefined);
    },
  );
  const closeTab = vi.fn(async (tabId: number): Promise<Result<void, ErrorResponse>> => {
    for (const context of contexts.values()) {
      context.tabIds.delete(tabId);
    }
    return ok(undefined);
  });

  function createOwnedTab(params: Record<string, unknown> | undefined): TabInfo {
    const windowId = params?.['windowId'];
    const context = [...contexts.values()].find((entry) => entry.windowId === windowId);
    if (!context || typeof windowId !== 'number') {
      throw new Error('Missing owned window');
    }

    const tabId = ++nextTabId;
    context.tabIds.add(tabId);
    return {
      tabId,
      url: typeof params?.['url'] === 'string' ? params['url'] : 'about:blank',
      title: '',
      active: params?.['active'] !== false,
      windowId,
    };
  }

  const createIsolatedBrowserTab = vi.fn(
    async (
      browserContextId: string,
      options?: { readonly url?: string; readonly active?: boolean },
    ): Promise<Result<TabInfo, ErrorResponse>> => {
      const context = contexts.get(browserContextId);
      if (!context) {
        return err({ code: 'UNKNOWN', message: 'Unknown context' });
      }
      return ok(
        createOwnedTab({
          ...options,
          windowId: context.windowId,
        }),
      );
    },
  );

  function setStorage(key: string, value: string): void {
    if (!activeContextId) {
      throw new Error('No active context');
    }
    contexts.get(activeContextId)?.storage.set(key, value);
  }

  function getStorage(key: string): string | undefined {
    if (!activeContextId) {
      throw new Error('No active context');
    }
    return contexts.get(activeContextId)?.storage.get(key);
  }

  return {
    adapter: {
      isolationCapabilities: {
        resource: 'cdp-browser-context' as const,
        concurrentContexts: true,
        cookieIsolation: true,
        webStorageIsolation: true,
      },
      createIsolatedBrowserContext,
      createIsolatedBrowserTab,
      closeIsolatedBrowserContext,
      isTabInIsolatedBrowserContext,
      activateIsolatedBrowserTab,
      closeTab,
    },
    createIsolatedBrowserContext,
    createIsolatedBrowserTab,
    closeIsolatedBrowserContext,
    activateIsolatedBrowserTab,
    closeTab,
    createOwnedTab,
    setStorage,
    getStorage,
  };
}

describe('BrowserSessionContextScope', () => {
  it('allocates distinct contexts and windows with isolated storage for two sessions', async () => {
    const harness = createAdapter();
    const scope = new BrowserSessionContextScope(harness.adapter);

    const first = await scope.run(request('chat-a', 'exec-1', 'browser-a'), async () => {
      harness.setStorage('token', 'session-a');
      return harness.getStorage('token');
    });
    const second = await scope.run(request('chat-b', 'exec-2', 'browser-b'), async () => {
      expect(harness.getStorage('token')).toBeUndefined();
      harness.setStorage('token', 'session-b');
      return harness.getStorage('token');
    });
    const firstAgain = await scope.run(request('chat-a', 'exec-1', 'browser-a'), async () =>
      harness.getStorage('token'),
    );

    expect(first.data).toBe('session-a');
    expect(second.data).toBe('session-b');
    expect(firstAgain.data).toBe('session-a');
    expect(first.browserContextId).not.toBe(second.browserContextId);
    expect(first.windowId).not.toBe(second.windowId);
    expect(first.activeTabId).not.toBe(second.activeTabId);
  });

  it('serializes interleaved executions in their owned contexts', async () => {
    const harness = createAdapter();
    const scope = new BrowserSessionContextScope(harness.adapter);
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = scope.run(request('chat-a', 'exec-1', 'browser-a'), async () => {
      order.push('a:start');
      await firstBlocked;
      order.push('a:end');
      return { marker: 'a' };
    });
    const second = scope.run(request('chat-b', 'exec-2', 'browser-b'), async () => {
      order.push('b:start');
      order.push('b:end');
      return { marker: 'b' };
    });

    await vi.waitFor(() => expect(order).toEqual(['a:start']));
    releaseFirst();
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(order).toEqual(['a:start', 'a:end', 'b:start', 'b:end']);
    expect(firstResult.browserContextId).toBe('context-1');
    expect(secondResult.browserContextId).toBe('context-2');
  });

  it('forces new tabs into the session window and owns only the returned tab', async () => {
    const harness = createAdapter();
    const scope = new BrowserSessionContextScope(harness.adapter);

    const result = await scope.run(
      request('chat-a', 'exec-1', 'browser-a', 'createTab', {
        url: 'https://session.test',
        windowId: 999,
      }),
      async (params) => harness.createOwnedTab(params),
    );

    expect(result.data).toMatchObject({
      url: 'https://session.test',
      windowId: result.windowId,
    });
    expect(result.ownedTabIds).toContain(result.activeTabId);
    expect(result.ownedTabIds).toHaveLength(2);
    expect(harness.createIsolatedBrowserTab).toHaveBeenCalledWith(result.browserContextId, {
      url: 'https://session.test',
      active: undefined,
    });
  });

  it('rejects forged tab ownership and browser-session reuse', async () => {
    const harness = createAdapter();
    const scope = new BrowserSessionContextScope(harness.adapter);
    const invoke = vi.fn().mockResolvedValue(undefined);
    const first = await scope.run(request('chat-a', 'exec-1', 'browser-a'), invoke);

    await expect(
      scope.run(
        request('chat-b', 'exec-2', 'browser-b', 'closeTab', {
          tabId: first.activeTabId,
        }),
        invoke,
      ),
    ).rejects.toMatchObject<Partial<BrowserSessionScopeError>>({
      code: 'SESSION_TAB_CONFLICT',
    });
    await expect(scope.run(request('chat-b', 'exec-2', 'browser-a'), invoke)).rejects.toMatchObject<
      Partial<BrowserSessionScopeError>
    >({
      code: 'SESSION_CONTEXT_MISMATCH',
    });
  });

  it('closes only the released session context and leaves the other active', async () => {
    const harness = createAdapter();
    const scope = new BrowserSessionContextScope(harness.adapter);
    const first = await scope.run(request('chat-a', 'exec-1', 'browser-a'), async () => 'a');
    const second = await scope.run(request('chat-b', 'exec-2', 'browser-b'), async () => 'b');

    await scope.release('browser-a');

    expect(harness.closeIsolatedBrowserContext).toHaveBeenCalledWith(first.browserContextId);
    expect(harness.closeIsolatedBrowserContext).not.toHaveBeenCalledWith(second.browserContextId);
    expect(harness.closeTab).not.toHaveBeenCalled();
    await scope.run(request('chat-b', 'exec-2', 'browser-b'), async () => 'still-b');
    expect(harness.activateIsolatedBrowserTab).toHaveBeenLastCalledWith(
      second.browserContextId,
      second.activeTabId,
    );
  });

  it('fails explicitly when the adapter cannot isolate browser state', async () => {
    const scope = new BrowserSessionContextScope({
      closeTab: vi.fn(),
    });

    await expect(
      scope.run(request('chat-a', 'exec-1', 'browser-a'), async () => undefined),
    ).rejects.toMatchObject<Partial<BrowserSessionScopeError>>({
      code: 'SESSION_ISOLATION_UNAVAILABLE',
    });
  });
});
