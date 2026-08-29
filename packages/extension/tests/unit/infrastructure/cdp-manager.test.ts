import { describe, it, expect, vi, beforeEach } from 'vitest';
import { chrome, resetChromeMocks } from '../../__mocks__/chrome.js';

vi.stubGlobal('chrome', chrome);

vi.mock('../../../src/infrastructure/logger.js', () => {
  const noop = () => {};
  return {
    Logger: {
      getInstance: () => ({
        debug: noop,
        info: noop,
        warn: noop,
        error: noop,
      }),
    },
  };
});

const { CDPManager, CDPError } = await import('../../../src/infrastructure/cdp-manager.js');
const { ErrorCode } = await import('@agentic-browser/shared');

describe('CDPManager', () => {
  let cdp: InstanceType<typeof CDPManager>;

  beforeEach(() => {
    resetChromeMocks();
    cdp = new CDPManager();
  });

  describe('attach', () => {
    it('does not break extension startup when optional debugger permission is absent', async () => {
      vi.stubGlobal('chrome', { ...chrome, debugger: undefined });

      try {
        const manager = new CDPManager();
        await expect(manager.attach(1)).rejects.toMatchObject({
          code: ErrorCode.PERMISSION_DENIED,
          message: 'Chrome debugger permission is not granted',
        });
      } finally {
        vi.stubGlobal('chrome', chrome);
      }
    });

    it('should attach the debugger to a tab', async () => {
      await cdp.attach(1);

      expect(chrome.debugger.attach).toHaveBeenCalledWith(
        { tabId: 1 },
        '1.3',
        expect.any(Function),
      );
      expect(cdp.isAttached(1)).toBe(true);
    });

    it('should no-op when already attached', async () => {
      await cdp.attach(1);
      chrome.debugger.attach.mockClear();

      await cdp.attach(1);

      expect(chrome.debugger.attach).not.toHaveBeenCalled();
    });

    it('should throw CDPError with PERMISSION_DENIED on failure', async () => {
      chrome.debugger.attach.mockImplementationOnce(
        (_target: unknown, _version: string, cb?: () => void) => {
          chrome.runtime.lastError = { message: 'Cannot access' };
          cb?.();
          chrome.runtime.lastError = null;
        },
      );

      await expect(cdp.attach(1)).rejects.toThrow(CDPError);
    });

    it('should include PERMISSION_DENIED error code on failure', async () => {
      chrome.debugger.attach.mockImplementationOnce(
        (_target: unknown, _version: string, cb?: () => void) => {
          chrome.runtime.lastError = { message: 'Cannot access' };
          cb?.();
          chrome.runtime.lastError = null;
        },
      );

      await expect(cdp.attach(1)).rejects.toMatchObject({
        code: ErrorCode.PERMISSION_DENIED,
      });
    });

    it('should not track tab on failure', async () => {
      chrome.debugger.attach.mockImplementationOnce(
        (_target: unknown, _version: string, cb?: () => void) => {
          chrome.runtime.lastError = { message: 'Cannot access' };
          cb?.();
          chrome.runtime.lastError = null;
        },
      );

      try {
        await cdp.attach(1);
      } catch {
        /* expected */
      }

      expect(cdp.isAttached(1)).toBe(false);
    });
  });

  describe('detach', () => {
    it('should detach the debugger from a tab', async () => {
      await cdp.attach(1);

      await cdp.detach(1);

      expect(chrome.debugger.detach).toHaveBeenCalledWith({ tabId: 1 }, expect.any(Function));
      expect(cdp.isAttached(1)).toBe(false);
    });

    it('should no-op when not attached', async () => {
      await cdp.detach(99);

      expect(chrome.debugger.detach).not.toHaveBeenCalled();
    });

    it('should clean up even when detach has lastError', async () => {
      await cdp.attach(1);
      chrome.debugger.detach.mockImplementationOnce((_target: unknown, cb?: () => void) => {
        chrome.runtime.lastError = { message: 'Already detached' };
        cb?.();
        chrome.runtime.lastError = null;
      });

      await cdp.detach(1);

      expect(cdp.isAttached(1)).toBe(false);
    });
  });

  describe('sendCommand', () => {
    it('should send a CDP command and return result', async () => {
      await cdp.attach(1);
      chrome.debugger.sendCommand.mockImplementationOnce(
        (_target: unknown, _method: string, _params: unknown, cb?: (result: unknown) => void) => {
          cb?.({ frameId: 'main' });
        },
      );

      const result = await cdp.sendCommand(1, 'Page.navigate', { url: 'https://example.com' });

      expect(result).toEqual({ frameId: 'main' });
      expect(chrome.debugger.sendCommand).toHaveBeenCalledWith(
        { tabId: 1 },
        'Page.navigate',
        { url: 'https://example.com' },
        expect.any(Function),
      );
    });

    it('should throw NOT_CONNECTED when debugger not attached', async () => {
      await expect(cdp.sendCommand(1, 'Page.navigate')).rejects.toThrow(CDPError);
      await expect(cdp.sendCommand(1, 'Page.navigate')).rejects.toMatchObject({
        code: ErrorCode.NOT_CONNECTED,
      });
    });

    it('should throw CDP_ERROR on command failure', async () => {
      await cdp.attach(1);
      chrome.debugger.sendCommand.mockImplementationOnce(
        (_target: unknown, _method: string, _params: unknown, cb?: (result: unknown) => void) => {
          chrome.runtime.lastError = { message: 'Protocol error' };
          cb?.(undefined);
          chrome.runtime.lastError = null;
        },
      );

      await expect(cdp.sendCommand(1, 'Page.navigate')).rejects.toThrow(CDPError);
    });

    it('should pass empty object when no params provided', async () => {
      await cdp.attach(1);

      await cdp.sendCommand(1, 'Page.reload');

      expect(chrome.debugger.sendCommand).toHaveBeenCalledWith(
        { tabId: 1 },
        'Page.reload',
        {},
        expect.any(Function),
      );
    });
  });

  describe('event listeners', () => {
    it('should register and invoke event listeners', async () => {
      await cdp.attach(1);
      const listener = vi.fn();
      cdp.onEvent(1, listener);

      const eventHandler = chrome.debugger.onEvent.addListener.mock.calls[0]![0] as (
        source: { tabId?: number },
        method: string,
        params?: object,
      ) => void;
      eventHandler({ tabId: 1 }, 'Page.loadEventFired', { timestamp: 123 });

      expect(listener).toHaveBeenCalledWith('Page.loadEventFired', { timestamp: 123 });
    });

    it('should not invoke listeners for other tabs', async () => {
      const listener = vi.fn();
      cdp.onEvent(1, listener);

      const eventHandler = chrome.debugger.onEvent.addListener.mock.calls[0]![0] as (
        source: { tabId?: number },
        method: string,
        params?: object,
      ) => void;
      eventHandler({ tabId: 2 }, 'Page.loadEventFired', {});

      expect(listener).not.toHaveBeenCalled();
    });

    it('should remove event listeners with offEvent', async () => {
      const listener = vi.fn();
      cdp.onEvent(1, listener);

      cdp.offEvent(1, listener);

      const eventHandler = chrome.debugger.onEvent.addListener.mock.calls[0]![0] as (
        source: { tabId?: number },
        method: string,
        params?: object,
      ) => void;
      eventHandler({ tabId: 1 }, 'Page.loadEventFired', {});

      expect(listener).not.toHaveBeenCalled();
    });

    it('should ignore events with undefined tabId', async () => {
      const listener = vi.fn();
      cdp.onEvent(1, listener);

      const eventHandler = chrome.debugger.onEvent.addListener.mock.calls[0]![0] as (
        source: { tabId?: number },
        method: string,
        params?: object,
      ) => void;
      eventHandler({}, 'Page.loadEventFired', {});

      expect(listener).not.toHaveBeenCalled();
    });
  });

  describe('external detach', () => {
    it('should clean up on external detach', async () => {
      await cdp.attach(1);

      const detachHandler = chrome.debugger.onDetach.addListener.mock.calls[0]![0] as (
        source: { tabId?: number },
        reason: string,
      ) => void;
      detachHandler({ tabId: 1 }, 'target_closed');

      expect(cdp.isAttached(1)).toBe(false);
    });

    it('should ignore detach events with undefined tabId', async () => {
      await cdp.attach(1);

      const detachHandler = chrome.debugger.onDetach.addListener.mock.calls[0]![0] as (
        source: { tabId?: number },
        reason: string,
      ) => void;
      detachHandler({}, 'target_closed');

      expect(cdp.isAttached(1)).toBe(true);
    });
  });

  describe('getAttachedTabs', () => {
    it('should return all attached tab IDs', async () => {
      await cdp.attach(1);
      await cdp.attach(2);

      const tabs = cdp.getAttachedTabs();

      expect(tabs).toContain(1);
      expect(tabs).toContain(2);
      expect(tabs).toHaveLength(2);
    });

    it('should return empty array when no tabs attached', () => {
      expect(cdp.getAttachedTabs()).toHaveLength(0);
    });
  });
});
