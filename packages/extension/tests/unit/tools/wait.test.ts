import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  createWaitForElementHandler,
  createWaitForNavigationHandler,
  createWaitForNetworkIdleHandler,
  createWaitForConditionHandler,
} from '../../../src/tools/wait.js';
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
    waitForSelector: vi.fn().mockResolvedValue(ok(undefined)),
    waitForNavigation: vi.fn().mockResolvedValue(ok('https://example.com/page')),
    waitForCondition: vi.fn().mockResolvedValue(ok(undefined)),
    executeSteps: vi.fn(),
    ...overrides,
  } as IBrowserAdapter;
}

describe('Wait handlers', () => {
  let adapter: IBrowserAdapter;

  beforeEach(() => {
    vi.useFakeTimers();
    adapter = createMockAdapter();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('createWaitForElementHandler', () => {
    it('should wait for element to be visible', async () => {
      const waitForElement = createWaitForElementHandler(adapter);

      const result = await waitForElement({ selector: '#target', condition: 'visible' });

      expect(result).toEqual({ success: true });
      expect(adapter.waitForSelector).toHaveBeenCalledWith({
        selector: '#target',
        visible: true,
        hidden: undefined,
        timeout: 30_000,
      });
    });

    it('should wait for element to be hidden', async () => {
      const waitForElement = createWaitForElementHandler(adapter);

      await waitForElement({ selector: '#target', condition: 'hidden' });

      expect(adapter.waitForSelector).toHaveBeenCalledWith({
        selector: '#target',
        visible: undefined,
        hidden: true,
        timeout: 30_000,
      });
    });

    it('should wait for element to be present (default)', async () => {
      const waitForElement = createWaitForElementHandler(adapter);

      await waitForElement({ selector: '#target' });

      expect(adapter.waitForSelector).toHaveBeenCalledWith({
        selector: '#target',
        visible: undefined,
        hidden: undefined,
        timeout: 30_000,
      });
    });

    it('should use custom timeout', async () => {
      const waitForElement = createWaitForElementHandler(adapter);

      await waitForElement({ selector: '#target', timeout: 5000 });

      expect(adapter.waitForSelector).toHaveBeenCalledWith(
        expect.objectContaining({ timeout: 5000 }),
      );
    });

    it('should throw on timeout error', async () => {
      adapter = createMockAdapter({
        waitForSelector: vi.fn().mockResolvedValue(err({ code: ErrorCode.TIMEOUT, message: 'Timed out' })),
      });
      const waitForElement = createWaitForElementHandler(adapter);

      await expect(waitForElement({ selector: '#missing' })).rejects.toThrow('[TIMEOUT]');
    });

    it('should throw on invalid params', async () => {
      const waitForElement = createWaitForElementHandler(adapter);

      await expect(waitForElement({})).rejects.toThrow('Invalid waitForElement params');
    });

    it('should throw on empty selector', async () => {
      const waitForElement = createWaitForElementHandler(adapter);

      await expect(waitForElement({ selector: '' })).rejects.toThrow('Invalid waitForElement params');
    });
  });

  describe('createWaitForNavigationHandler', () => {
    it('should wait for navigation and return url', async () => {
      const waitForNavigation = createWaitForNavigationHandler(adapter);

      const result = await waitForNavigation({});

      expect(result).toEqual({ success: true, url: 'https://example.com/page' });
    });

    it('should pass waitUntil option', async () => {
      const waitForNavigation = createWaitForNavigationHandler(adapter);

      await waitForNavigation({ waitUntil: 'networkidle' });

      expect(adapter.waitForNavigation).toHaveBeenCalledWith({
        waitUntil: 'networkidle',
        timeout: 30_000,
      });
    });

    it('should default waitUntil to load', async () => {
      const waitForNavigation = createWaitForNavigationHandler(adapter);

      await waitForNavigation({});

      expect(adapter.waitForNavigation).toHaveBeenCalledWith({
        waitUntil: 'load',
        timeout: 30_000,
      });
    });

    it('should use custom timeout', async () => {
      const waitForNavigation = createWaitForNavigationHandler(adapter);

      await waitForNavigation({ timeout: 10_000 });

      expect(adapter.waitForNavigation).toHaveBeenCalledWith(
        expect.objectContaining({ timeout: 10_000 }),
      );
    });

    it('should throw on timeout error', async () => {
      adapter = createMockAdapter({
        waitForNavigation: vi.fn().mockResolvedValue(err({ code: ErrorCode.TIMEOUT, message: 'Timed out' })),
      });
      const waitForNavigation = createWaitForNavigationHandler(adapter);

      await expect(waitForNavigation({})).rejects.toThrow('[TIMEOUT]');
    });
  });

  describe('createWaitForNetworkIdleHandler', () => {
    it('should enable Network domain and return success when idle', async () => {
      vi.useRealTimers();

      const sendCdpCommand = vi.fn()
        .mockResolvedValueOnce(ok({}))
        .mockResolvedValueOnce(ok({ result: { value: 0 } }))
        .mockResolvedValueOnce(ok({}));

      adapter = createMockAdapter({ sendCdpCommand });
      const waitForNetworkIdle = createWaitForNetworkIdleHandler(adapter);

      const result = await waitForNetworkIdle({ idleThreshold: 50, timeout: 2000 });

      expect(result).toEqual({ success: true });
      expect(sendCdpCommand).toHaveBeenCalledWith({ method: 'Network.enable' });
    });

    it('should throw when Network.enable fails', async () => {
      vi.useRealTimers();

      adapter = createMockAdapter({
        sendCdpCommand: vi.fn().mockResolvedValue(err({ code: ErrorCode.CDP_ERROR, message: 'CDP failed' })),
      });
      const waitForNetworkIdle = createWaitForNetworkIdleHandler(adapter);

      await expect(waitForNetworkIdle({})).rejects.toThrow('[CDP_ERROR]');
    });

    it('should throw on invalid params', async () => {
      const waitForNetworkIdle = createWaitForNetworkIdleHandler(adapter);

      await expect(waitForNetworkIdle({ timeout: -1 })).rejects.toThrow('Invalid waitForNetworkIdle params');
    });
  });

  describe('createWaitForConditionHandler', () => {
    it('should wait for condition and return success', async () => {
      const waitForCondition = createWaitForConditionHandler(adapter);

      const result = await waitForCondition({ expression: 'document.readyState === "complete"' });

      expect(result).toEqual({ success: true });
      expect(adapter.waitForCondition).toHaveBeenCalledWith({
        expression: 'document.readyState === "complete"',
        pollingInterval: 250,
        timeout: 30_000,
      });
    });

    it('should use custom polling interval and timeout', async () => {
      const waitForCondition = createWaitForConditionHandler(adapter);

      await waitForCondition({ expression: 'true', pollingInterval: 100, timeout: 5000 });

      expect(adapter.waitForCondition).toHaveBeenCalledWith({
        expression: 'true',
        pollingInterval: 100,
        timeout: 5000,
      });
    });

    it('should throw on timeout', async () => {
      adapter = createMockAdapter({
        waitForCondition: vi.fn().mockResolvedValue(err({ code: ErrorCode.TIMEOUT, message: 'Condition timed out' })),
      });
      const waitForCondition = createWaitForConditionHandler(adapter);

      await expect(waitForCondition({ expression: 'false' })).rejects.toThrow('[TIMEOUT]');
    });

    it('should throw on invalid params', async () => {
      const waitForCondition = createWaitForConditionHandler(adapter);

      await expect(waitForCondition({})).rejects.toThrow('Invalid waitForCondition params');
    });

    it('should throw on empty expression', async () => {
      const waitForCondition = createWaitForConditionHandler(adapter);

      await expect(waitForCondition({ expression: '' })).rejects.toThrow('Invalid waitForCondition params');
    });
  });
});
