import type {
  BrowserRequestContext,
  CommandName,
  CommandRequest,
  IBrowserAdapter,
} from '@agentic-browser/shared';
import {
  isBrowserIsolationAdapter,
  type BrowserIsolationAdapter,
} from '../adapters/browser-isolation.js';

export interface ScopedCommandResult<T> {
  readonly data: T;
  readonly activeTabId?: number;
  readonly ownedTabIds?: readonly number[];
  readonly browserContextId?: string;
  readonly windowId?: number;
}

type BrowserCommandInvoker<T> = (params?: Record<string, unknown>) => Promise<T>;

export interface BrowserCommandScope {
  run<T>(
    request: CommandRequest,
    invoke: BrowserCommandInvoker<T>,
  ): Promise<ScopedCommandResult<T>>;
  release(browserSessionId: string): Promise<void>;
}

interface BrowserSessionContext {
  readonly context: BrowserRequestContext;
  readonly browserContextId: string;
  readonly windowId: number;
  readonly tabIds: Set<number>;
  activeTabId?: number;
}

type SessionScopeAdapter = Pick<IBrowserAdapter, 'closeTab'> & Partial<BrowserIsolationAdapter>;

const GLOBAL_COMMANDS = new Set<CommandName>([
  'listBookmarks',
  'createBookmark',
  'searchBookmarks',
  'searchHistory',
  'getHistoryEntries',
  'getDownloadItems',
  'monitorDownloads',
  'listTools',
]);

export class BrowserSessionScopeError extends Error {
  constructor(
    readonly code:
      | 'SESSION_CONTEXT_MISMATCH'
      | 'SESSION_TAB_CONFLICT'
      | 'SESSION_CLEANUP_FAILED'
      | 'SESSION_ISOLATION_UNAVAILABLE',
    message: string,
  ) {
    super(message);
    this.name = 'BrowserSessionScopeError';
  }
}

export class BrowserSessionContextScope implements BrowserCommandScope {
  private readonly sessions = new Map<string, BrowserSessionContext>();
  private readonly browserSessionByExecution = new Map<string, string>();
  private operationTail: Promise<void> = Promise.resolve();

  constructor(private readonly adapter: SessionScopeAdapter) {}

  run<T>(
    request: CommandRequest,
    invoke: BrowserCommandInvoker<T>,
  ): Promise<ScopedCommandResult<T>> {
    const context = request.context;
    if (!context) {
      return invoke().then((data) => ({ data }));
    }
    return this.runExclusive(() => this.runScoped(request, context, invoke));
  }

  release(browserSessionId: string): Promise<void> {
    return this.runExclusive(async () => {
      const session = this.sessions.get(browserSessionId);
      if (!session) {
        return;
      }

      const isolationAdapter = this.requireIsolationAdapter();
      const result = await isolationAdapter.closeIsolatedBrowserContext(session.browserContextId);
      if (!result.ok) {
        throw new BrowserSessionScopeError(
          'SESSION_CLEANUP_FAILED',
          `Failed to close isolated browser context ${session.browserContextId} for session ${browserSessionId}: ${result.error.message}`,
        );
      }

      this.sessions.delete(browserSessionId);
      this.browserSessionByExecution.delete(executionKey(session.context));
    });
  }

  private async runScoped<T>(
    request: CommandRequest,
    context: BrowserRequestContext,
    invoke: BrowserCommandInvoker<T>,
  ): Promise<ScopedCommandResult<T>> {
    const session = await this.resolveSession(context);

    if (request.command === 'createTab') {
      const isolationAdapter = this.requireIsolationAdapter();
      const created = await isolationAdapter.createIsolatedBrowserTab(session.browserContextId, {
        url: typeof request.params['url'] === 'string' ? request.params['url'] : undefined,
        active: typeof request.params['active'] === 'boolean' ? request.params['active'] : undefined,
      });
      if (!created.ok) {
        throw new BrowserSessionScopeError(
          'SESSION_ISOLATION_UNAVAILABLE',
          `Failed to create a tab in the isolated context for session ${context.browserSessionId}: ${created.error.message}`,
        );
      }
      const data = created.value as T;
      const tabId = resultTabId(data);
      const windowId = resultWindowId(data);
      if (tabId === undefined || windowId !== session.windowId) {
        if (tabId !== undefined) {
          await this.closeRejectedTab(tabId, context.browserSessionId);
        }
        throw new BrowserSessionScopeError(
          'SESSION_TAB_CONFLICT',
          `Created browser tab was not placed in the isolated window for session ${context.browserSessionId}`,
        );
      }
      const ownership = await isolationAdapter.isTabInIsolatedBrowserContext(
        session.browserContextId,
        tabId,
      );
      if (!ownership.ok || !ownership.value) {
        await this.closeRejectedTab(tabId, context.browserSessionId);
        throw new BrowserSessionScopeError(
          'SESSION_TAB_CONFLICT',
          `Created browser tab ${String(tabId)} is outside the isolated context for session ${context.browserSessionId}`,
        );
      }
      session.tabIds.add(tabId);
      if (resultTabActive(data)) {
        session.activeTabId = tabId;
      }
      return this.result(session, data);
    }

    if (request.command === 'listTabs') {
      const data = filterOwnedTabs(await invoke(), session.tabIds);
      return this.result(session, data);
    }

    if (GLOBAL_COMMANDS.has(request.command)) {
      return this.result(session, await invoke());
    }

    const requestedTabId = request.params['tabId'];
    if (typeof requestedTabId === 'number' && !session.tabIds.has(requestedTabId)) {
      throw new BrowserSessionScopeError(
        'SESSION_TAB_CONFLICT',
        `Browser tab ${String(requestedTabId)} is not owned by session ${context.browserSessionId}`,
      );
    }

    if (request.command === 'switchTab' || request.command === 'closeTab') {
      if (typeof requestedTabId !== 'number' || !session.tabIds.has(requestedTabId)) {
        throw new BrowserSessionScopeError(
          'SESSION_TAB_CONFLICT',
          `Browser tab ${String(requestedTabId)} is not owned by session ${context.browserSessionId}`,
        );
      }
      if (request.command === 'closeTab' && session.tabIds.size === 1) {
        throw new BrowserSessionScopeError(
          'SESSION_TAB_CONFLICT',
          `Cannot close the final tab in isolated session ${context.browserSessionId}; release the session instead`,
        );
      }
      if (request.command === 'switchTab') {
        await this.activateOwnedTab(session, requestedTabId);
      }
    } else {
      if (session.activeTabId !== undefined) {
        await this.activateOwnedTab(session, session.activeTabId);
      }
    }

    const data = await invoke();
    if (request.command === 'switchTab' && typeof requestedTabId === 'number') {
      session.activeTabId = requestedTabId;
    } else if (request.command === 'closeTab' && typeof requestedTabId === 'number') {
      session.tabIds.delete(requestedTabId);
      if (session.activeTabId === requestedTabId) {
        session.activeTabId = session.tabIds.values().next().value;
      }
    }
    return this.result(session, data);
  }

  private async resolveSession(context: BrowserRequestContext): Promise<BrowserSessionContext> {
    const key = executionKey(context);
    const registeredBrowserSession = this.browserSessionByExecution.get(key);
    if (
      registeredBrowserSession !== undefined &&
      registeredBrowserSession !== context.browserSessionId
    ) {
      throw new BrowserSessionScopeError(
        'SESSION_CONTEXT_MISMATCH',
        `Execution ${context.chatId}/${context.executionId} is already bound to browser session ${registeredBrowserSession}`,
      );
    }

    const existing = this.sessions.get(context.browserSessionId);
    if (existing) {
      if (executionKey(existing.context) !== key) {
        throw new BrowserSessionScopeError(
          'SESSION_CONTEXT_MISMATCH',
          `Browser session ${context.browserSessionId} cannot be reused by ${context.chatId}/${context.executionId}`,
        );
      }
      return existing;
    }

    const isolationAdapter = this.requireIsolationAdapter();
    const allocated = await isolationAdapter.createIsolatedBrowserContext(context.browserSessionId);
    if (!allocated.ok) {
      throw new BrowserSessionScopeError(
        'SESSION_ISOLATION_UNAVAILABLE',
        `Failed to allocate an isolated browser context for session ${context.browserSessionId}: ${allocated.error.message}`,
      );
    }
    const collision = [...this.sessions.values()].find(
      (session) =>
        session.browserContextId === allocated.value.browserContextId ||
        session.windowId === allocated.value.windowId ||
        session.tabIds.has(allocated.value.initialTab.tabId),
    );
    if (collision) {
      await this.disposeRejectedAllocation(
        isolationAdapter,
        allocated.value.browserContextId,
        context.browserSessionId,
      );
      throw new BrowserSessionScopeError(
        'SESSION_ISOLATION_UNAVAILABLE',
        `Browser reused isolation resources from session ${collision.context.browserSessionId} for session ${context.browserSessionId}`,
      );
    }
    if (
      allocated.value.initialTab.windowId !== allocated.value.windowId ||
      allocated.value.initialTab.tabId < 0
    ) {
      await this.disposeRejectedAllocation(
        isolationAdapter,
        allocated.value.browserContextId,
        context.browserSessionId,
      );
      throw new BrowserSessionScopeError(
        'SESSION_ISOLATION_UNAVAILABLE',
        `Browser returned an invalid isolated context for session ${context.browserSessionId}`,
      );
    }

    const session: BrowserSessionContext = {
      context,
      browserContextId: allocated.value.browserContextId,
      windowId: allocated.value.windowId,
      tabIds: new Set([allocated.value.initialTab.tabId]),
      activeTabId: allocated.value.initialTab.tabId,
    };
    this.sessions.set(context.browserSessionId, session);
    this.browserSessionByExecution.set(key, context.browserSessionId);
    return session;
  }

  private async activateOwnedTab(session: BrowserSessionContext, tabId: number): Promise<void> {
    const isolationAdapter = this.requireIsolationAdapter();
    const activated = await isolationAdapter.activateIsolatedBrowserTab(
      session.browserContextId,
      tabId,
    );
    if (!activated.ok) {
      throw new BrowserSessionScopeError(
        'SESSION_TAB_CONFLICT',
        `Failed to activate browser tab ${String(tabId)} for session ${session.context.browserSessionId}: ${activated.error.message}`,
      );
    }
  }

  private async closeRejectedTab(tabId: number, browserSessionId: string): Promise<void> {
    const closed = await this.adapter.closeTab(tabId);
    if (!closed.ok) {
      throw new BrowserSessionScopeError(
        'SESSION_CLEANUP_FAILED',
        `Failed to close rejected browser tab ${String(tabId)} for session ${browserSessionId}: ${closed.error.message}`,
      );
    }
  }

  private async disposeRejectedAllocation(
    isolationAdapter: BrowserIsolationAdapter,
    browserContextId: string,
    browserSessionId: string,
  ): Promise<void> {
    const closed = await isolationAdapter.closeIsolatedBrowserContext(browserContextId);
    if (!closed.ok) {
      throw new BrowserSessionScopeError(
        'SESSION_CLEANUP_FAILED',
        `Failed to dispose rejected browser context ${browserContextId} for session ${browserSessionId}: ${closed.error.message}`,
      );
    }
  }

  private result<T>(session: BrowserSessionContext, data: T): ScopedCommandResult<T> {
    return {
      data,
      activeTabId: session.activeTabId,
      ownedTabIds: [...session.tabIds],
      browserContextId: session.browserContextId,
      windowId: session.windowId,
    };
  }

  private requireIsolationAdapter(): BrowserIsolationAdapter {
    if (!isBrowserIsolationAdapter(this.adapter)) {
      throw new BrowserSessionScopeError(
        'SESSION_ISOLATION_UNAVAILABLE',
        'The active browser adapter cannot create isolated browser contexts',
      );
    }
    return this.adapter;
  }

  private runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.operationTail;
    let release!: () => void;
    this.operationTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    return previous.then(operation).finally(release);
  }
}

export class BrowserSessionTabScope extends BrowserSessionContextScope {}

function executionKey(context: BrowserRequestContext): string {
  return `${context.chatId}\u0000${context.executionId}`;
}

function resultTabId(value: unknown): number | undefined {
  return isRecord(value) && typeof value['tabId'] === 'number' ? value['tabId'] : undefined;
}

function resultWindowId(value: unknown): number | undefined {
  return isRecord(value) && typeof value['windowId'] === 'number' ? value['windowId'] : undefined;
}

function resultTabActive(value: unknown): boolean {
  return !isRecord(value) || value['active'] !== false;
}

function filterOwnedTabs<T>(value: T, ownedTabIds: ReadonlySet<number>): T {
  if (!isRecord(value) || !Array.isArray(value['tabs'])) {
    return value;
  }
  return {
    ...value,
    tabs: value['tabs'].filter(
      (tab) => isRecord(tab) && typeof tab['tabId'] === 'number' && ownedTabIds.has(tab['tabId']),
    ),
  } as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
