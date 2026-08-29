import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createInterceptNetworkHandler, tabStates, matchesPatterns } from '../../../src/tools/network.js';
import type { IBrowserAdapter } from '@agentic-browser/shared';
import { ok, err, ErrorCode } from '@agentic-browser/shared';

function createMockAdapter(overrides: Partial<IBrowserAdapter> = {}): IBrowserAdapter {
  return {
    connect: vi.fn(),
    disconnect: vi.fn(),
    isConnected: vi.fn().mockReturnValue(true),
    navigate: vi.fn(),
    waitForLoad: vi.fn(),
    goBack: vi.fn(),
    goForward: vi.fn(),
    reload: vi.fn(),
    click: vi.fn(),
    type: vi.fn(),
    hover: vi.fn(),
    scroll: vi.fn(),
    select: vi.fn(),
    focus: vi.fn(),
    getAttribute: vi.fn(),
    getProperty: vi.fn(),
    createTab: vi.fn(),
    closeTab: vi.fn(),
    switchTab: vi.fn(),
    listTabs: vi.fn(),
    getActiveTab: vi.fn().mockResolvedValue(ok({ tabId: 1, url: 'https://example.com', title: 'Example', active: true, windowId: 1 })),
    handleDialog: vi.fn(),
    getDialogInfo: vi.fn(),
    captureScreenshot: vi.fn(),
    captureFullPageScreenshot: vi.fn(),
    getAccessibilityTree: vi.fn(),
    getPageContent: vi.fn(),
    getOuterHtml: vi.fn(),
    getInnerHtml: vi.fn(),
    querySelector: vi.fn(),
    querySelectorAll: vi.fn(),
    getAttributes: vi.fn(),
    executeScript: vi.fn(),
    evaluateExpression: vi.fn(),
    executeConsoleCommand: vi.fn(),
    injectScript: vi.fn(),
    removeScript: vi.fn(),
    sendCdpCommand: vi.fn().mockResolvedValue(ok({})),
    attachDebugger: vi.fn(),
    detachDebugger: vi.fn(),
    setOuterHtml: vi.fn(),
    setInnerHtml: vi.fn(),
    insertAdjacentHtml: vi.fn(),
    addStyleSheet: vi.fn(),
    modifyStyle: vi.fn(),
    getComputedStyle: vi.fn(),
    getCookies: vi.fn(),
    setCookie: vi.fn(),
    waitForSelector: vi.fn(),
    waitForNavigation: vi.fn(),
    waitForCondition: vi.fn(),
    executeSteps: vi.fn(),
    ...overrides,
  } as IBrowserAdapter;
}

describe('createInterceptNetworkHandler', () => {
  let adapter: IBrowserAdapter;
  let handler: ReturnType<typeof createInterceptNetworkHandler>;

  beforeEach(() => {
    adapter = createMockAdapter();
    handler = createInterceptNetworkHandler(adapter);
    tabStates.clear();
  });

  describe('enableInterception', () => {
    it('should enable interception with default patterns', async () => {
      const result = await handler({ action: 'enableInterception' });

      expect(result.success).toBe(true);
      expect(result.action).toBe('enableInterception');
      expect(result.tabId).toBe(1);
      expect(adapter.sendCdpCommand).toHaveBeenCalledWith({
        method: 'Fetch.enable',
        params: {
          patterns: [{ urlPattern: '*', requestStage: 'Request' }],
          handleAuthRequests: false,
        },
        tabId: 1,
      });
    });

    it('should enable interception with custom patterns', async () => {
      const result = await handler({
        action: 'enableInterception',
        tabId: 2,
        patterns: ['https://api.example.com/*', '*.json'],
      });

      expect(result.success).toBe(true);
      expect(result.tabId).toBe(2);
      expect(adapter.sendCdpCommand).toHaveBeenCalledWith({
        method: 'Fetch.enable',
        params: {
          patterns: [
            { urlPattern: 'https://api.example.com/*', requestStage: 'Request' },
            { urlPattern: '*.json', requestStage: 'Request' },
          ],
          handleAuthRequests: false,
        },
        tabId: 2,
      });
    });

    it('should store tab state after enabling', async () => {
      await handler({ action: 'enableInterception', tabId: 3 });

      const state = tabStates.get(3);
      expect(state).toBeDefined();
      expect(state?.enabled).toBe(true);
      expect(state?.patterns).toEqual(['*']);
      expect(state?.interceptedRequests).toEqual([]);
    });

    it('should throw when CDP command fails', async () => {
      adapter = createMockAdapter({
        sendCdpCommand: vi.fn().mockResolvedValue(
          err({ code: ErrorCode.UNKNOWN, message: 'CDP error' }),
        ),
      });
      handler = createInterceptNetworkHandler(adapter);

      await expect(handler({ action: 'enableInterception', tabId: 1 })).rejects.toThrow(
        'CDP error',
      );
    });
  });

  describe('disableInterception', () => {
    it('should disable interception and clear tab state', async () => {
      tabStates.set(1, { enabled: true, patterns: ['*'], interceptedRequests: [] });

      const result = await handler({ action: 'disableInterception', tabId: 1 });

      expect(result.success).toBe(true);
      expect(result.action).toBe('disableInterception');
      expect(adapter.sendCdpCommand).toHaveBeenCalledWith({
        method: 'Fetch.disable',
        tabId: 1,
      });
      expect(tabStates.has(1)).toBe(false);
    });
  });

  describe('getInterceptedRequests', () => {
    it('should return requests for a specific tab', async () => {
      tabStates.set(5, {
        enabled: true,
        patterns: ['*'],
        interceptedRequests: [
          { requestId: 'r1', url: 'https://example.com', method: 'GET', headers: {}, tabId: 5 },
        ],
      });

      const result = await handler({ action: 'getInterceptedRequests', tabId: 5 });

      expect(result.success).toBe(true);
      expect(result.interceptedRequests).toHaveLength(1);
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      expect(result.interceptedRequests![0]!.requestId).toBe('r1');
    });

    it('should return empty array when no state exists for tab', async () => {
      const result = await handler({ action: 'getInterceptedRequests', tabId: 99 });

      expect(result.success).toBe(true);
      expect(result.interceptedRequests).toEqual([]);
    });

    it('should return all requests when no tabId specified', async () => {
      tabStates.set(1, {
        enabled: true,
        patterns: ['*'],
        interceptedRequests: [
          { requestId: 'r1', url: 'https://a.com', method: 'GET', headers: {}, tabId: 1 },
        ],
      });
      tabStates.set(2, {
        enabled: true,
        patterns: ['*'],
        interceptedRequests: [
          { requestId: 'r2', url: 'https://b.com', method: 'POST', headers: {}, tabId: 2 },
        ],
      });

      const result = await handler({ action: 'getInterceptedRequests' });

      expect(result.success).toBe(true);
      expect(result.interceptedRequests).toHaveLength(2);
    });
  });

  describe('modifyRequest', () => {
    it('should continue request with modified headers', async () => {
      const result = await handler({
        action: 'modifyRequest',
        tabId: 1,
        requestId: 'req-1',
        headers: { 'X-Custom': 'value' },
      });

      expect(result.success).toBe(true);
      expect(result.action).toBe('modifyRequest');
      expect(adapter.sendCdpCommand).toHaveBeenCalledWith({
        method: 'Fetch.continueRequest',
        params: {
          requestId: 'req-1',
          headers: [{ name: 'X-Custom', value: 'value' }],
        },
        tabId: 1,
      });
    });

    it('should fulfill request with response body', async () => {
      const result = await handler({
        action: 'modifyRequest',
        tabId: 1,
        requestId: 'req-2',
        body: '{"mock": true}',
        responseCode: 200,
      });

      expect(result.success).toBe(true);
      expect(adapter.sendCdpCommand).toHaveBeenCalledWith({
        method: 'Fetch.fulfillRequest',
        params: {
          requestId: 'req-2',
          responseCode: 200,
          body: btoa('{"mock": true}'),
        },
        tabId: 1,
      });
    });

    it('should fulfill request with response headers', async () => {
      await handler({
        action: 'modifyRequest',
        tabId: 1,
        requestId: 'req-3',
        responseHeaders: { 'Content-Type': 'application/json' },
        responseCode: 201,
      });

      expect(adapter.sendCdpCommand).toHaveBeenCalledWith({
        method: 'Fetch.fulfillRequest',
        params: {
          requestId: 'req-3',
          responseCode: 201,
          responseHeaders: [{ name: 'Content-Type', value: 'application/json' }],
        },
        tabId: 1,
      });
    });

    it('should throw when requestId is missing', async () => {
      await expect(handler({ action: 'modifyRequest', tabId: 1 })).rejects.toThrow(
        'requestId is required',
      );
    });
  });

  describe('blockRequest', () => {
    it('should block a request with Fetch.failRequest', async () => {
      const result = await handler({
        action: 'blockRequest',
        tabId: 1,
        requestId: 'req-block',
      });

      expect(result.success).toBe(true);
      expect(result.action).toBe('blockRequest');
      expect(adapter.sendCdpCommand).toHaveBeenCalledWith({
        method: 'Fetch.failRequest',
        params: { requestId: 'req-block', errorReason: 'BlockedByClient' },
        tabId: 1,
      });
    });

    it('should throw when requestId is missing', async () => {
      await expect(handler({ action: 'blockRequest', tabId: 1 })).rejects.toThrow(
        'requestId is required',
      );
    });
  });

  describe('validation', () => {
    it('should throw on invalid action', async () => {
      await expect(handler({ action: 'invalidAction' })).rejects.toThrow(
        'Invalid intercept_network params',
      );
    });

    it('should throw on missing action', async () => {
      await expect(handler({})).rejects.toThrow('Invalid intercept_network params');
    });
  });

  describe('tab resolution', () => {
    it('should use active tab when tabId not specified', async () => {
      await handler({ action: 'enableInterception' });

      expect(adapter.getActiveTab).toHaveBeenCalled();
      expect(adapter.sendCdpCommand).toHaveBeenCalledWith(
        expect.objectContaining({ tabId: 1 }),
      );
    });

    it('should throw when no active tab found', async () => {
      adapter = createMockAdapter({
        getActiveTab: vi.fn().mockResolvedValue(
          err({ code: ErrorCode.TAB_NOT_FOUND, message: 'No active tab' }),
        ),
      });
      handler = createInterceptNetworkHandler(adapter);

      await expect(handler({ action: 'enableInterception' })).rejects.toThrow(
        'No active tab found',
      );
    });
  });
});

describe('matchesPatterns', () => {
  it('should match all URLs when patterns are empty', () => {
    expect(matchesPatterns('https://example.com', [])).toBe(true);
  });

  it('should match wildcard pattern', () => {
    expect(matchesPatterns('https://example.com/api/data', ['*'])).toBe(true);
  });

  it('should match URL with glob pattern', () => {
    expect(matchesPatterns('https://api.example.com/v1/users', ['https://api.example.com/*'])).toBe(true);
  });

  it('should not match URL that does not fit pattern', () => {
    expect(matchesPatterns('https://other.com/data', ['https://api.example.com/*'])).toBe(false);
  });

  it('should match against multiple patterns', () => {
    expect(matchesPatterns('https://cdn.example.com/image.png', ['*.json', '*.png'])).toBe(true);
  });

  it('should handle question mark wildcard', () => {
    expect(matchesPatterns('https://example.com/a', ['https://example.com/?'])).toBe(true);
    expect(matchesPatterns('https://example.com/ab', ['https://example.com/?'])).toBe(false);
  });
});
