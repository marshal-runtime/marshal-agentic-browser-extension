import type {
  BrowserRequestContext,
  InvocationContext,
  MarshalBrowserRuntimeHostModule,
  ResolvedBrowserSession,
} from './contracts.js';

export class BrowserSessionRegistry {
  private readonly sessions = new Map<string, string>();
  private readonly panelExecutions = new Map<string, Promise<void>>();
  private latestPanelExecutionKey: string | undefined;

  constructor(private readonly host: MarshalBrowserRuntimeHostModule) {}

  resolve(context: InvocationContext): ResolvedBrowserSession {
    if (this.host.resolveBrowserSession) {
      const resolved = this.host.resolveBrowserSession(context);
      this.latestPanelExecutionKey = panelExecutionKey(resolved.context);
      return resolved;
    }
    const chatId = resolveChatId(context);
    const executionId = context.executionId ?? this.host.createId('execution');
    const key = buildBrowserIsolationKey(context, chatId, executionId);
    const existing = this.sessions.get(key);
    const browserSessionId = existing ?? this.host.createId('browser-session');

    if (existing === undefined) {
      this.sessions.set(key, browserSessionId);
    }
    this.latestPanelExecutionKey = panelExecutionKey({
      chatId,
      executionId,
      browserSessionId,
      ...(context.browserInstanceId === undefined
        ? {}
        : { browserInstanceId: context.browserInstanceId }),
    });

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

  clear(): void {
    this.sessions.clear();
    this.panelExecutions.clear();
    this.latestPanelExecutionKey = undefined;
  }

  async openOrFocusPanel(
    context: BrowserRequestContext,
    request: () => Promise<void>,
  ): Promise<void> {
    const key = `${context.browserSessionId}\u0000${context.executionId}`;
    if (panelExecutionKey(context) !== this.latestPanelExecutionKey) {
      return;
    }
    const existing = this.panelExecutions.get(key);
    if (existing) {
      await existing;
      return;
    }
    const pending = request();
    this.panelExecutions.set(key, pending);
    try {
      await pending;
    } catch (error: unknown) {
      this.panelExecutions.delete(key);
      throw error;
    }
  }
}

export function resolveChatId(context: InvocationContext): string {
  const metadataChatId = context.metadata?.['chatId'];
  if (typeof metadataChatId === 'string' && metadataChatId.length > 0) {
    return metadataChatId;
  }
  return (
    context.scope?.sessionId ??
    context.scope?.threadId ??
    `principal:${context.principal.kind}:${context.principal.id}`
  );
}

export function buildBrowserIsolationKey(
  context: InvocationContext,
  chatId: string,
  executionId: string,
): string {
  return [
    context.identity?.harnessId ?? '',
    context.identity?.installationId ?? '',
    context.identity?.profileId ?? '',
    context.identity?.userId ?? '',
    context.scope?.workspaceId ?? '',
    context.scope?.projectId ?? '',
    context.browserInstanceId ?? '',
    chatId,
    executionId,
  ].join('|');
}

function panelExecutionKey(context: BrowserRequestContext): string {
  return `${context.chatId}\u0000${context.executionId}\u0000${context.browserSessionId}`;
}
