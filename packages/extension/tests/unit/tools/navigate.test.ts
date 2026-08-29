import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createNavigateHandler } from '../../../src/tools/navigate.js';
import type { IBrowserAdapter } from '@agentic-browser/shared';
import { ok, err, ErrorCode } from '@agentic-browser/shared';
import type { ErrorResponse } from '@agentic-browser/shared';

function createMockAdapter(overrides: Partial<IBrowserAdapter> = {}): IBrowserAdapter {
  return {
    connect: vi.fn(),
    disconnect: vi.fn(),
    isConnected: vi.fn().mockReturnValue(true),
    navigate: vi.fn().mockResolvedValue(ok('https://example.com')),
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
    sendCdpCommand: vi.fn(),
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

describe('createNavigateHandler', () => {
  let adapter: IBrowserAdapter;
  let navigate: ReturnType<typeof createNavigateHandler>;

  beforeEach(() => {
    adapter = createMockAdapter();
    navigate = createNavigateHandler(adapter);
  });

  describe('valid URL', () => {
    it('should navigate and return url, title, and status', async () => {
      const result = await navigate({ url: 'https://example.com' });

      expect(result).toEqual({
        url: 'https://example.com',
        title: 'Example',
        status: 200,
      });
      expect(adapter.navigate).toHaveBeenCalledWith({
        url: 'https://example.com',
        waitUntil: 'load',
        timeout: 30_000,
      });
    });

    it('should pass custom waitUntil and timeout', async () => {
      await navigate({ url: 'https://example.com', waitUntil: 'networkidle', timeout: 5000 });

      expect(adapter.navigate).toHaveBeenCalledWith({
        url: 'https://example.com',
        waitUntil: 'networkidle',
        timeout: 5000,
      });
    });

    it('should return empty title when getActiveTab fails', async () => {
      adapter = createMockAdapter({
        getActiveTab: vi.fn().mockResolvedValue(err({ code: ErrorCode.TAB_NOT_FOUND, message: 'No tab' })),
      });
      navigate = createNavigateHandler(adapter);

      const result = await navigate({ url: 'https://example.com' });

      expect(result.title).toBe('');
    });
  });

  describe('invalid URL', () => {
    it('should throw on missing url', async () => {
      await expect(navigate({})).rejects.toThrow('Invalid navigate params');
    });

    it('should throw on non-URL string', async () => {
      await expect(navigate({ url: 'not-a-url' })).rejects.toThrow('Invalid navigate params');
    });

    it('should throw on empty params', async () => {
      await expect(navigate(null)).rejects.toThrow('Invalid navigate params');
    });
  });

  describe('timeout', () => {
    it('should throw when adapter returns timeout error', async () => {
      adapter = createMockAdapter({
        navigate: vi.fn().mockResolvedValue(err({ code: ErrorCode.TIMEOUT, message: 'Navigation timed out' })),
      });
      navigate = createNavigateHandler(adapter);

      await expect(navigate({ url: 'https://slow.com' })).rejects.toThrow('[TIMEOUT]');
    });
  });

  describe('wait strategies', () => {
    it('should accept domcontentloaded', async () => {
      await navigate({ url: 'https://example.com', waitUntil: 'domcontentloaded' });

      expect(adapter.navigate).toHaveBeenCalledWith(
        expect.objectContaining({ waitUntil: 'domcontentloaded' }),
      );
    });

    it('should accept networkidle', async () => {
      await navigate({ url: 'https://example.com', waitUntil: 'networkidle' });

      expect(adapter.navigate).toHaveBeenCalledWith(
        expect.objectContaining({ waitUntil: 'networkidle' }),
      );
    });

    it('should default to load when waitUntil not specified', async () => {
      await navigate({ url: 'https://example.com' });

      expect(adapter.navigate).toHaveBeenCalledWith(
        expect.objectContaining({ waitUntil: 'load' }),
      );
    });
  });

  describe('navigation failure', () => {
    it('should throw with error code and message from adapter', async () => {
      adapter = createMockAdapter({
        navigate: vi.fn().mockResolvedValue(err({ code: ErrorCode.NAVIGATION_FAILED, message: 'ERR_NAME_NOT_RESOLVED' })),
      });
      navigate = createNavigateHandler(adapter);

      await expect(navigate({ url: 'https://nonexistent.invalid' })).rejects.toThrow('[NAVIGATION_FAILED] ERR_NAME_NOT_RESOLVED');
    });
  });
});
