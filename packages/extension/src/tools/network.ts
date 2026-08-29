/**
 * Network interception tool handler.
 *
 * Validates incoming parameters via {@link InterceptNetworkParamsSchema},
 * delegates to the browser adapter's CDP commands for Fetch domain
 * operations, and manages per-tab interception state.
 */

import type { IBrowserAdapter } from '@agentic-browser/shared';
import { InterceptNetworkParamsSchema, ErrorCode } from '@agentic-browser/shared';

/** Intercepted request stored in memory. */
interface InterceptedRequest {
  readonly requestId: string;
  readonly url: string;
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly tabId: number;
}

/** Per-tab interception state. */
interface TabInterceptionState {
  enabled: boolean;
  patterns: readonly string[];
  interceptedRequests: InterceptedRequest[];
}

/** Tracks interception state per tab. */
const tabStates = new Map<number, TabInterceptionState>();

/** Checks whether a URL matches any of the given glob patterns. */
function matchesPatterns(url: string, patterns: readonly string[]): boolean {
  if (patterns.length === 0) return true;
  return patterns.some((pattern) => {
    const escaped = pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*')
      .replace(/\?/g, '.');
    return new RegExp(`^${escaped}$`).test(url);
  });
}

/** Response shape returned by the intercept network handler. */
interface InterceptNetworkResult {
  readonly success: boolean;
  readonly action: string;
  readonly tabId?: number;
  readonly interceptedRequests?: readonly InterceptedRequest[];
  readonly message?: string;
}

/**
 * Creates a network interception handler bound to the given browser adapter.
 *
 * The returned function validates raw params with Zod and dispatches
 * to the appropriate CDP Fetch domain command based on the action.
 */
export function createInterceptNetworkHandler(adapter: IBrowserAdapter) {
  return async (params: unknown): Promise<InterceptNetworkResult> => {
    const parsed = InterceptNetworkParamsSchema.safeParse(params);

    if (!parsed.success) {
      throw new Error(
        `Invalid intercept_network params: ${parsed.error.issues.map((i: { message: string }) => i.message).join(', ')}`,
      );
    }

    const { action, tabId, patterns, requestId, headers, responseHeaders, body, responseCode } =
      parsed.data;

    switch (action) {
      case 'enableInterception':
        return enableInterception(adapter, tabId, patterns);
      case 'disableInterception':
        return disableInterception(adapter, tabId);
      case 'getInterceptedRequests':
        return getInterceptedRequests(tabId);
      case 'modifyRequest':
        return modifyRequest(adapter, tabId, requestId, headers, responseHeaders, body, responseCode);
      case 'blockRequest':
        return blockRequest(adapter, tabId, requestId);
      default:
        throw new Error(`Unknown action: ${action as string}`);
    }
  };
}

async function enableInterception(
  adapter: IBrowserAdapter,
  tabId?: number,
  patterns?: readonly string[],
): Promise<InterceptNetworkResult> {
  const resolvedTabId = await resolveTabId(adapter, tabId);
  const resolvedPatterns = patterns ?? ['*'];

  const requestPatterns = resolvedPatterns.map((urlPattern) => ({
    urlPattern,
    requestStage: 'Request',
  }));

  const result = await adapter.sendCdpCommand({
    method: 'Fetch.enable',
    params: { patterns: requestPatterns, handleAuthRequests: false },
    tabId: resolvedTabId,
  });

  if (!result.ok) {
    throw new Error(`[${result.error.code}] ${result.error.message}`);
  }

  tabStates.set(resolvedTabId, {
    enabled: true,
    patterns: resolvedPatterns,
    interceptedRequests: [],
  });

  return {
    success: true,
    action: 'enableInterception',
    tabId: resolvedTabId,
    message: `Network interception enabled for tab ${resolvedTabId}`,
  };
}

async function disableInterception(
  adapter: IBrowserAdapter,
  tabId?: number,
): Promise<InterceptNetworkResult> {
  const resolvedTabId = await resolveTabId(adapter, tabId);

  const result = await adapter.sendCdpCommand({
    method: 'Fetch.disable',
    tabId: resolvedTabId,
  });

  if (!result.ok) {
    throw new Error(`[${result.error.code}] ${result.error.message}`);
  }

  tabStates.delete(resolvedTabId);

  return {
    success: true,
    action: 'disableInterception',
    tabId: resolvedTabId,
    message: `Network interception disabled for tab ${resolvedTabId}`,
  };
}

function getInterceptedRequests(tabId?: number): InterceptNetworkResult {
  if (tabId !== undefined) {
    const state = tabStates.get(tabId);
    return {
      success: true,
      action: 'getInterceptedRequests',
      tabId,
      interceptedRequests: state?.interceptedRequests ?? [],
    };
  }

  const allRequests: InterceptedRequest[] = [];
  for (const state of tabStates.values()) {
    allRequests.push(...state.interceptedRequests);
  }

  return {
    success: true,
    action: 'getInterceptedRequests',
    interceptedRequests: allRequests,
  };
}

async function modifyRequest(
  adapter: IBrowserAdapter,
  tabId?: number,
  requestId?: string,
  reqHeaders?: Readonly<Record<string, string>>,
  respHeaders?: Readonly<Record<string, string>>,
  body?: string,
  responseCode?: number,
): Promise<InterceptNetworkResult> {
  if (!requestId) {
    throw new Error('requestId is required for modifyRequest action');
  }

  const resolvedTabId = await resolveTabId(adapter, tabId);

  if (respHeaders || body || responseCode) {
    const fulfillParams: Record<string, unknown> = {
      requestId,
      responseCode: responseCode ?? 200,
    };

    if (respHeaders) {
      fulfillParams.responseHeaders = Object.entries(respHeaders).map(([name, value]) => ({
        name,
        value,
      }));
    }

    if (body) {
      fulfillParams.body = btoa(body);
    }

    const result = await adapter.sendCdpCommand({
      method: 'Fetch.fulfillRequest',
      params: fulfillParams,
      tabId: resolvedTabId,
    });

    if (!result.ok) {
      throw new Error(`[${result.error.code}] ${result.error.message}`);
    }
  } else {
    const continueParams: Record<string, unknown> = { requestId };

    if (reqHeaders) {
      continueParams.headers = Object.entries(reqHeaders).map(([name, value]) => ({
        name,
        value,
      }));
    }

    const result = await adapter.sendCdpCommand({
      method: 'Fetch.continueRequest',
      params: continueParams,
      tabId: resolvedTabId,
    });

    if (!result.ok) {
      throw new Error(`[${result.error.code}] ${result.error.message}`);
    }
  }

  return {
    success: true,
    action: 'modifyRequest',
    tabId: resolvedTabId,
    message: `Request ${requestId} modified`,
  };
}

async function blockRequest(
  adapter: IBrowserAdapter,
  tabId?: number,
  requestId?: string,
): Promise<InterceptNetworkResult> {
  if (!requestId) {
    throw new Error('requestId is required for blockRequest action');
  }

  const resolvedTabId = await resolveTabId(adapter, tabId);

  const result = await adapter.sendCdpCommand({
    method: 'Fetch.failRequest',
    params: { requestId, errorReason: 'BlockedByClient' },
    tabId: resolvedTabId,
  });

  if (!result.ok) {
    throw new Error(`[${result.error.code}] ${result.error.message}`);
  }

  return {
    success: true,
    action: 'blockRequest',
    tabId: resolvedTabId,
    message: `Request ${requestId} blocked`,
  };
}

async function resolveTabId(adapter: IBrowserAdapter, tabId?: number): Promise<number> {
  if (tabId !== undefined) return tabId;

  const tabResult = await adapter.getActiveTab();
  if (!tabResult.ok) {
    throw new Error(`[${ErrorCode.TAB_NOT_FOUND}] No active tab found`);
  }

  return tabResult.value.tabId;
}

export { matchesPatterns, tabStates };
export type { InterceptedRequest, TabInterceptionState, InterceptNetworkResult };
