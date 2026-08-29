import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createStorageHandler } from '../../../src/tools/storage.js';
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
    getCookies: vi.fn().mockResolvedValue(ok([])),
    setCookie: vi.fn().mockResolvedValue(ok(undefined)),
    waitForSelector: vi.fn(),
    waitForNavigation: vi.fn(),
    waitForCondition: vi.fn(),
    executeSteps: vi.fn(),
    deleteCookie: vi.fn().mockResolvedValue(ok(undefined)),
    getStorage: vi.fn().mockResolvedValue(ok({ key: 'testKey', value: 'testValue' })),
    setStorage: vi.fn().mockResolvedValue(ok(undefined)),
    clearStorage: vi.fn().mockResolvedValue(ok(undefined)),
    ...overrides,
  } as IBrowserAdapter;
}

describe('createStorageHandler', () => {
  let adapter: IBrowserAdapter;
  let handler: ReturnType<typeof createStorageHandler>;

  beforeEach(() => {
    adapter = createMockAdapter();
    handler = createStorageHandler(adapter);
  });

  it('should reject invalid params', async () => {
    await expect(handler({})).rejects.toThrow('Invalid storage params');
  });

  describe('getCookies', () => {
    it('should get cookies for a domain', async () => {
      const cookies = [
        { name: 'session', value: 'abc123', domain: '.example.com', path: '/' },
      ];
      (adapter.getCookies as ReturnType<typeof vi.fn>).mockResolvedValue(ok(cookies));

      const result = await handler({ action: 'getCookies', domain: '.example.com' });

      expect(result.success).toBe(true);
      expect(result.action).toBe('getCookies');
      expect(result.data).toEqual(cookies);
      expect(adapter.getCookies).toHaveBeenCalledWith({ domain: '.example.com', url: undefined });
    });

    it('should propagate adapter errors', async () => {
      (adapter.getCookies as ReturnType<typeof vi.fn>).mockResolvedValue(
        err({ code: ErrorCode.UNKNOWN, message: 'Cookies API unavailable' }),
      );

      await expect(handler({ action: 'getCookies' })).rejects.toThrow('Cookies API unavailable');
    });
  });

  describe('setCookie', () => {
    it('should set a cookie with full details', async () => {
      const cookie = {
        name: 'token',
        value: 'xyz',
        domain: '.example.com',
        path: '/',
        secure: true,
        httpOnly: true,
        sameSite: 'strict' as const,
      };

      const result = await handler({ action: 'setCookie', cookie });

      expect(result.success).toBe(true);
      expect(result.action).toBe('setCookie');
      expect(adapter.setCookie).toHaveBeenCalledWith({
        name: 'token',
        value: 'xyz',
        domain: '.example.com',
        path: '/',
        secure: true,
        httpOnly: true,
        sameSite: 'strict',
        expirationDate: undefined,
      });
    });

    it('should throw when cookie details are missing', async () => {
      await expect(handler({ action: 'setCookie' })).rejects.toThrow(
        'cookie details are required',
      );
    });
  });

  describe('deleteCookie', () => {
    it('should delete a cookie by name and URL', async () => {
      const result = await handler({
        action: 'deleteCookie',
        cookieName: 'session',
        url: 'https://example.com/',
      });

      expect(result.success).toBe(true);
      expect(result.action).toBe('deleteCookie');
      expect((adapter as any).deleteCookie).toHaveBeenCalledWith(
        'https://example.com/',
        'session',
      );
    });

    it('should derive URL from domain when URL is not provided', async () => {
      const result = await handler({
        action: 'deleteCookie',
        cookieName: 'session',
        domain: 'example.com',
      });

      expect(result.success).toBe(true);
      expect((adapter as any).deleteCookie).toHaveBeenCalledWith(
        'https://example.com/',
        'session',
      );
    });

    it('should throw when cookieName is missing', async () => {
      await expect(handler({ action: 'deleteCookie' })).rejects.toThrow(
        'cookieName is required',
      );
    });
  });

  describe('getLocalStorage', () => {
    it('should get a localStorage item', async () => {
      const result = await handler({
        action: 'getLocalStorage',
        key: 'testKey',
      });

      expect(result.success).toBe(true);
      expect(result.action).toBe('getLocalStorage');
      expect(result.data).toEqual({ key: 'testKey', value: 'testValue' });
      expect((adapter as any).getStorage).toHaveBeenCalledWith(1, 'local', 'testKey');
    });

    it('should throw when key is missing', async () => {
      await expect(handler({ action: 'getLocalStorage' })).rejects.toThrow(
        'key is required',
      );
    });
  });

  describe('setLocalStorage', () => {
    it('should set a localStorage item', async () => {
      const result = await handler({
        action: 'setLocalStorage',
        key: 'myKey',
        value: 'myValue',
      });

      expect(result.success).toBe(true);
      expect(result.action).toBe('setLocalStorage');
      expect((adapter as any).setStorage).toHaveBeenCalledWith(1, 'local', 'myKey', 'myValue');
    });

    it('should throw when key is missing', async () => {
      await expect(handler({ action: 'setLocalStorage', value: 'v' })).rejects.toThrow(
        'key is required',
      );
    });

    it('should throw when value is missing', async () => {
      await expect(handler({ action: 'setLocalStorage', key: 'k' })).rejects.toThrow(
        'value is required',
      );
    });
  });

  describe('getSessionStorage', () => {
    it('should get a sessionStorage item', async () => {
      const result = await handler({
        action: 'getSessionStorage',
        key: 'sessionKey',
      });

      expect(result.success).toBe(true);
      expect(result.action).toBe('getSessionStorage');
      expect((adapter as any).getStorage).toHaveBeenCalledWith(1, 'session', 'sessionKey');
    });
  });

  describe('setSessionStorage', () => {
    it('should set a sessionStorage item', async () => {
      const result = await handler({
        action: 'setSessionStorage',
        key: 'sKey',
        value: 'sValue',
      });

      expect(result.success).toBe(true);
      expect(result.action).toBe('setSessionStorage');
      expect((adapter as any).setStorage).toHaveBeenCalledWith(1, 'session', 'sKey', 'sValue');
    });
  });

  describe('clearStorage', () => {
    it('should clear all storage', async () => {
      const result = await handler({ action: 'clearStorage' });

      expect(result.success).toBe(true);
      expect(result.action).toBe('clearStorage');
      expect((adapter as any).clearStorage).toHaveBeenCalledWith(1);
    });

    it('should propagate adapter errors', async () => {
      (adapter as any).clearStorage = vi.fn().mockResolvedValue(
        err({ code: ErrorCode.UNKNOWN, message: 'Failed to clear' }),
      );
      handler = createStorageHandler(adapter);

      await expect(handler({ action: 'clearStorage' })).rejects.toThrow('Failed to clear');
    });
  });
});
