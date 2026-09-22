/**
 * Browser session context resolution, ported from
 * packages/runtime-extension/src/session-registry.ts (read-only reference -
 * that package has other people's uncommitted changes, so this is a copy,
 * not an import).
 *
 * `browser.automation.run` resolves this ONCE, at run creation time, from
 * the CALLER's InvocationContext (the main agent's session), and stores the
 * resulting BrowserRequestContext on the run record. Every other
 * runId-scoped capability (subgoal/check/observe/finish/get) reuses that
 * stored context verbatim - it must never re-resolve from its own caller's
 * InvocationContext, because the planner agent that calls
 * `browser.automation.subgoal` has a different session/executionId than the
 * caller of `browser.automation.run`, and re-resolving would silently split
 * the automation across two different browser sessions.
 */

import type {
  AgenticBrowserRuntimeHost,
  BrowserRequestContext,
  InvocationContext,
} from './contracts.js';

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

/**
 * Resolves the browser context bound to `context` at the moment it is
 * called. Prefers the host's own `resolveBrowserSession` when available
 * (the agentic browser extension's canonical resolution, including any
 * host-side isolation policy); falls back to a locally-derived session
 * scoped by chatId + executionId, mirroring BrowserSessionRegistry.resolve's
 * fallback path.
 */
export function resolveBrowserContext(
  host: AgenticBrowserRuntimeHost,
  context: InvocationContext,
): BrowserRequestContext {
  if (host.resolveBrowserSession) {
    return host.resolveBrowserSession(context).context;
  }
  const chatId = resolveChatId(context);
  const executionId = context.executionId ?? host.createId('execution');
  return {
    chatId,
    executionId,
    browserSessionId: host.createId('browser-session'),
    ...(context.browserInstanceId === undefined
      ? {}
      : { browserInstanceId: context.browserInstanceId }),
  };
}
