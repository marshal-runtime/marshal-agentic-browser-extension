import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  createCreateTabHandler,
  createCloseTabHandler,
  createSwitchTabHandler,
  createListTabsHandler,
} from '../../../src/tools/tabs.js';
import type { IBrowserAdapter, TabInfo } from '@agentic-browser/shared';
import { ok, err, ErrorCode } from '@agentic-browser/shared';

const TAB_FIXTURE: TabInfo = {
  tabId: 1,
  url: 'https://example.com',
  title: 'Example',
  active: true,
  windowId: 1,
};

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
    createTab: vi.fn().mockResolvedValue(ok(TAB_FIXTURE)),
    closeTab: vi.fn().mockResolvedValue(ok(undefined)),
    switchTab: vi.fn().mockResolvedValue(ok(undefined)),
    listTabs: vi.fn().mockResolvedValue(ok([TAB_FIXTURE])),
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

describe('Tab handlers', () => {
  let adapter: IBrowserAdapter;

  beforeEach(() => {
    adapter = createMockAdapter();
  });

  describe('createCreateTabHandler', () => {
    it('should create a tab and return tab info', async () => {
      const createTab = createCreateTabHandler(adapter);

      const result = await createTab({});

      expect(result).toEqual({
        tabId: 1,
        url: 'https://example.com',
        title: 'Example',
        active: true,
        windowId: 1,
      });
    });

    it('should pass url and active options', async () => {
      const createTab = createCreateTabHandler(adapter);

      await createTab({ url: 'https://new.com', active: false });

      expect(adapter.createTab).toHaveBeenCalledWith({ url: 'https://new.com', active: false });
    });

    it('should throw on adapter error', async () => {
      adapter = createMockAdapter({
        createTab: vi.fn().mockResolvedValue(err({ code: ErrorCode.UNKNOWN, message: 'Failed' })),
      });
      const createTab = createCreateTabHandler(adapter);

      await expect(createTab({})).rejects.toThrow('[UNKNOWN] Failed');
    });

    it('should throw on invalid params', async () => {
      const createTab = createCreateTabHandler(adapter);

      await expect(createTab({ url: 'not-a-url' })).rejects.toThrow('Invalid createTab params');
    });
  });

  describe('createCloseTabHandler', () => {
    it('should close a tab successfully', async () => {
      const closeTab = createCloseTabHandler(adapter);

      await expect(closeTab({ tabId: 1 })).resolves.toBeUndefined();
      expect(adapter.closeTab).toHaveBeenCalledWith(1);
    });

    it('should throw when tab not found', async () => {
      adapter = createMockAdapter({
        closeTab: vi
          .fn()
          .mockResolvedValue(err({ code: ErrorCode.TAB_NOT_FOUND, message: 'Tab not found' })),
      });
      const closeTab = createCloseTabHandler(adapter);

      await expect(closeTab({ tabId: 999 })).rejects.toThrow('[TAB_NOT_FOUND]');
    });

    it('should throw on invalid params', async () => {
      const closeTab = createCloseTabHandler(adapter);

      await expect(closeTab({})).rejects.toThrow('Invalid closeTab params');
    });
  });

  describe('createSwitchTabHandler', () => {
    it('should switch to a tab successfully', async () => {
      const switchTab = createSwitchTabHandler(adapter);

      await expect(switchTab({ tabId: 2 })).resolves.toBeUndefined();
      expect(adapter.switchTab).toHaveBeenCalledWith(2);
    });

    it('should throw when tab not found', async () => {
      adapter = createMockAdapter({
        switchTab: vi
          .fn()
          .mockResolvedValue(err({ code: ErrorCode.TAB_NOT_FOUND, message: 'Tab not found' })),
      });
      const switchTab = createSwitchTabHandler(adapter);

      await expect(switchTab({ tabId: 999 })).rejects.toThrow('[TAB_NOT_FOUND]');
    });

    it('should throw on invalid params', async () => {
      const switchTab = createSwitchTabHandler(adapter);

      await expect(switchTab({})).rejects.toThrow('Invalid switchTab params');
    });
  });

  describe('createListTabsHandler', () => {
    it('should list all tabs', async () => {
      const listTabs = createListTabsHandler(adapter);

      const result = await listTabs({});

      expect(result).toEqual({
        tabs: [
          {
            tabId: 1,
            url: 'https://example.com',
            title: 'Example',
            active: true,
            windowId: 1,
          },
        ],
      });
    });

    it('should return multiple tabs', async () => {
      const secondTab: TabInfo = {
        tabId: 2,
        url: 'https://other.com',
        title: 'Other',
        active: false,
        windowId: 1,
      };
      adapter = createMockAdapter({
        listTabs: vi.fn().mockResolvedValue(ok([TAB_FIXTURE, secondTab])),
      });
      const listTabs = createListTabsHandler(adapter);

      const result = await listTabs({});

      expect(result.tabs).toHaveLength(2);
      expect(result.tabs[1]).toEqual({
        tabId: 2,
        url: 'https://other.com',
        title: 'Other',
        active: false,
        windowId: 1,
      });
    });

    it('should throw on adapter error', async () => {
      adapter = createMockAdapter({
        listTabs: vi.fn().mockResolvedValue(err({ code: ErrorCode.UNKNOWN, message: 'Failed' })),
      });
      const listTabs = createListTabsHandler(adapter);

      await expect(listTabs({})).rejects.toThrow('[UNKNOWN] Failed');
    });
  });
});
