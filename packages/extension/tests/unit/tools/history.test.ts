import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHistoryHandler } from '../../../src/tools/history.js';
import type { IBrowserAdapter } from '@agentic-browser/shared';
import { ok, err, ErrorCode } from '@agentic-browser/shared';

function createMockAdapter(overrides: Partial<IBrowserAdapter> = {}): IBrowserAdapter {
  return {
    connect: vi.fn(),
    disconnect: vi.fn(),
    isConnected: vi.fn().mockReturnValue(true),
    navigate: vi.fn(),
    waitForLoad: vi.fn(),
    goBack: vi.fn().mockResolvedValue(ok('https://example.com/previous')),
    goForward: vi.fn().mockResolvedValue(ok('https://example.com/next')),
    reload: vi.fn().mockResolvedValue(ok('https://example.com/current')),
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
    getActiveTab: vi.fn(),
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

describe('createHistoryHandler', () => {
  let adapter: IBrowserAdapter;
  let history: ReturnType<typeof createHistoryHandler>;

  beforeEach(() => {
    adapter = createMockAdapter();
    history = createHistoryHandler(adapter);
  });

  describe('goBack', () => {
    it('should navigate back and return URL', async () => {
      const result = await history({ action: 'goBack' });

      expect(result).toEqual({
        success: true,
        action: 'goBack',
        url: 'https://example.com/previous',
      });
      expect(adapter.goBack).toHaveBeenCalled();
    });

    it('should throw when adapter goBack fails', async () => {
      adapter = createMockAdapter({
        goBack: vi.fn().mockResolvedValue(err({ code: ErrorCode.NAVIGATION_FAILED, message: 'Cannot go back' })),
      });
      history = createHistoryHandler(adapter);

      await expect(history({ action: 'goBack' })).rejects.toThrow('[NAVIGATION_FAILED] Cannot go back');
    });
  });

  describe('goForward', () => {
    it('should navigate forward and return URL', async () => {
      const result = await history({ action: 'goForward' });

      expect(result).toEqual({
        success: true,
        action: 'goForward',
        url: 'https://example.com/next',
      });
      expect(adapter.goForward).toHaveBeenCalled();
    });

    it('should throw when adapter goForward fails', async () => {
      adapter = createMockAdapter({
        goForward: vi.fn().mockResolvedValue(err({ code: ErrorCode.NAVIGATION_FAILED, message: 'Cannot go forward' })),
      });
      history = createHistoryHandler(adapter);

      await expect(history({ action: 'goForward' })).rejects.toThrow('[NAVIGATION_FAILED] Cannot go forward');
    });
  });

  describe('reload', () => {
    it('should soft reload and return URL', async () => {
      const result = await history({ action: 'reload' });

      expect(result).toEqual({
        success: true,
        action: 'reload',
        url: 'https://example.com/current',
        message: 'Soft reload completed',
      });
      expect(adapter.reload).toHaveBeenCalledWith(undefined);
    });

    it('should hard reload when hard=true', async () => {
      const result = await history({ action: 'reload', hard: true });

      expect(result).toEqual({
        success: true,
        action: 'reload',
        url: 'https://example.com/current',
        message: 'Hard reload completed',
      });
      expect(adapter.reload).toHaveBeenCalledWith(true);
    });

    it('should throw when adapter reload fails', async () => {
      adapter = createMockAdapter({
        reload: vi.fn().mockResolvedValue(err({ code: ErrorCode.NAVIGATION_FAILED, message: 'Reload failed' })),
      });
      history = createHistoryHandler(adapter);

      await expect(history({ action: 'reload' })).rejects.toThrow('[NAVIGATION_FAILED] Reload failed');
    });
  });

  describe('validation', () => {
    it('should throw on invalid params', async () => {
      await expect(history(null)).rejects.toThrow('Invalid history params');
    });

    it('should throw on unknown action', async () => {
      await expect(history({ action: 'unknown' })).rejects.toThrow('Invalid history params');
    });

    it('should throw on missing action', async () => {
      await expect(history({})).rejects.toThrow('Invalid history params');
    });
  });
});
