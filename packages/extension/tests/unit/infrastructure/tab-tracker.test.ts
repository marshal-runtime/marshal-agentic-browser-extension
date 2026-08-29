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

const { TabTracker } = await import('../../../src/infrastructure/tab-tracker.js');

describe('TabTracker', () => {
  let tracker: InstanceType<typeof TabTracker>;

  beforeEach(() => {
    resetChromeMocks();
    tracker = new TabTracker();
  });

  describe('init', () => {
    it('should populate tabs from chrome.tabs.query', async () => {
      chrome.tabs.query.mockResolvedValueOnce([
        { id: 1, url: 'https://example.com', title: 'Example', status: 'complete', favIconUrl: '', windowId: 1, active: true },
        { id: 2, url: 'https://test.com', title: 'Test', status: 'complete', favIconUrl: '', windowId: 1, active: false },
      ]);

      await tracker.init();

      expect(tracker.getAllTabs()).toHaveLength(2);
      expect(tracker.getTab(1)).toBeDefined();
      expect(tracker.getTab(2)).toBeDefined();
    });

    it('should track the active tab', async () => {
      chrome.tabs.query.mockResolvedValueOnce([
        { id: 1, url: 'https://example.com', title: 'Example', status: 'complete', favIconUrl: '', windowId: 1, active: true },
      ]);

      await tracker.init();

      const active = tracker.getActiveTab();
      expect(active).toBeDefined();
      expect(active!.id).toBe(1);
    });

    it('should register event listeners', async () => {
      chrome.tabs.query.mockResolvedValueOnce([]);

      await tracker.init();

      expect(chrome.tabs.onCreated.addListener).toHaveBeenCalledOnce();
      expect(chrome.tabs.onUpdated.addListener).toHaveBeenCalledOnce();
      expect(chrome.tabs.onRemoved.addListener).toHaveBeenCalledOnce();
      expect(chrome.tabs.onActivated.addListener).toHaveBeenCalledOnce();
    });

    it('should be idempotent on multiple calls', async () => {
      chrome.tabs.query.mockResolvedValue([]);

      await tracker.init();
      await tracker.init();

      expect(chrome.tabs.onCreated.addListener).toHaveBeenCalledTimes(1);
    });

    it('should skip tabs without an id', async () => {
      chrome.tabs.query.mockResolvedValueOnce([
        { url: 'chrome://newtab', title: 'New Tab', status: 'complete', favIconUrl: '', windowId: 1, active: false },
      ]);

      await tracker.init();

      expect(tracker.getAllTabs()).toHaveLength(0);
    });

    it('should use safe defaults for missing tab fields', async () => {
      chrome.tabs.query.mockResolvedValueOnce([
        { id: 1, windowId: 1, active: false },
      ]);

      await tracker.init();

      const tab = tracker.getTab(1);
      expect(tab).toBeDefined();
      expect(tab!.url).toBe('');
      expect(tab!.title).toBe('');
      expect(tab!.status).toBe('loading');
      expect(tab!.favIconUrl).toBe('');
    });
  });

  describe('onCreated event', () => {
    it('should add a new tab to tracked tabs', async () => {
      chrome.tabs.query.mockResolvedValueOnce([]);
      await tracker.init();

      const handler = chrome.tabs.onCreated.addListener.mock.calls[0]![0] as (tab: unknown) => void;
      handler({ id: 3, url: 'https://new.com', title: 'New', status: 'loading', favIconUrl: '', windowId: 1, active: false });

      expect(tracker.getTab(3)).toBeDefined();
      expect(tracker.getTab(3)!.url).toBe('https://new.com');
    });

    it('should ignore tabs without an id', async () => {
      chrome.tabs.query.mockResolvedValueOnce([]);
      await tracker.init();

      const handler = chrome.tabs.onCreated.addListener.mock.calls[0]![0] as (tab: unknown) => void;
      handler({ windowId: 1, active: false });

      expect(tracker.getAllTabs()).toHaveLength(0);
    });
  });

  describe('onUpdated event', () => {
    it('should update existing tab state', async () => {
      chrome.tabs.query.mockResolvedValueOnce([
        { id: 1, url: 'https://old.com', title: 'Old', status: 'complete', favIconUrl: '', windowId: 1, active: true },
      ]);
      await tracker.init();

      const handler = chrome.tabs.onUpdated.addListener.mock.calls[0]![0] as (
        tabId: number,
        changeInfo: unknown,
        tab: unknown,
      ) => void;
      handler(1, { url: 'https://new.com' }, {
        id: 1, url: 'https://new.com', title: 'New', status: 'complete', favIconUrl: '', windowId: 1, active: true,
      });

      expect(tracker.getTab(1)!.url).toBe('https://new.com');
      expect(tracker.getTab(1)!.title).toBe('New');
    });
  });

  describe('onRemoved event', () => {
    it('should remove the tab from tracked tabs', async () => {
      chrome.tabs.query.mockResolvedValueOnce([
        { id: 1, url: 'https://example.com', title: 'Example', status: 'complete', favIconUrl: '', windowId: 1, active: false },
      ]);
      await tracker.init();

      const handler = chrome.tabs.onRemoved.addListener.mock.calls[0]![0] as (tabId: number) => void;
      handler(1);

      expect(tracker.getTab(1)).toBeUndefined();
      expect(tracker.getAllTabs()).toHaveLength(0);
    });

    it('should clear activeTabId when active tab is removed', async () => {
      chrome.tabs.query.mockResolvedValueOnce([
        { id: 1, url: 'https://example.com', title: 'Example', status: 'complete', favIconUrl: '', windowId: 1, active: true },
      ]);
      await tracker.init();

      const handler = chrome.tabs.onRemoved.addListener.mock.calls[0]![0] as (tabId: number) => void;
      handler(1);

      expect(tracker.getActiveTab()).toBeUndefined();
    });
  });

  describe('onActivated event', () => {
    it('should update the active tab', async () => {
      chrome.tabs.query.mockResolvedValueOnce([
        { id: 1, url: 'https://a.com', title: 'A', status: 'complete', favIconUrl: '', windowId: 1, active: true },
        { id: 2, url: 'https://b.com', title: 'B', status: 'complete', favIconUrl: '', windowId: 1, active: false },
      ]);
      await tracker.init();

      const handler = chrome.tabs.onActivated.addListener.mock.calls[0]![0] as (
        activeInfo: chrome.tabs.TabActiveInfo,
      ) => void;
      handler({ tabId: 2, windowId: 1 });

      const active = tracker.getActiveTab();
      expect(active).toBeDefined();
      expect(active!.id).toBe(2);
      expect(active!.active).toBe(true);

      const prev = tracker.getTab(1);
      expect(prev!.active).toBe(false);
    });
  });

  describe('query helpers', () => {
    it('should return undefined for unknown tab ids', () => {
      expect(tracker.getTab(999)).toBeUndefined();
    });

    it('should return undefined active tab when no tabs are tracked', () => {
      expect(tracker.getActiveTab()).toBeUndefined();
    });
  });
});
