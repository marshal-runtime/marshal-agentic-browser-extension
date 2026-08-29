import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  createListBookmarksHandler,
  createCreateBookmarkHandler,
  createSearchBookmarksHandler,
  createSearchHistoryHandler,
  createGetHistoryEntriesHandler,
  createGetDownloadItemsHandler,
  createMonitorDownloadsHandler,
} from '../../../src/tools/browser-apis.js';
import type { IBrowserAdapter, BookmarkNode, HistoryEntry, DownloadItem } from '@agentic-browser/shared';
import { ok, err, ErrorCode } from '@agentic-browser/shared';

const BOOKMARK_FIXTURE: BookmarkNode = {
  id: '1',
  parentId: '0',
  title: 'Example',
  url: 'https://example.com',
  dateAdded: 1700000000000,
};

const HISTORY_FIXTURE: HistoryEntry = {
  id: '1',
  url: 'https://example.com',
  title: 'Example',
  lastVisitTime: 1700000000000,
  visitCount: 5,
};

const DOWNLOAD_FIXTURE: DownloadItem = {
  id: 1,
  url: 'https://example.com/file.zip',
  filename: 'file.zip',
  state: 'complete',
  bytesReceived: 1024,
  totalBytes: 1024,
  startTime: '2024-01-01T00:00:00Z',
  mime: 'application/zip',
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
    listBookmarks: vi.fn().mockResolvedValue(ok([BOOKMARK_FIXTURE])),
    createBookmark: vi.fn().mockResolvedValue(ok(BOOKMARK_FIXTURE)),
    searchBookmarks: vi.fn().mockResolvedValue(ok([BOOKMARK_FIXTURE])),
    searchHistory: vi.fn().mockResolvedValue(ok([HISTORY_FIXTURE])),
    getHistoryEntries: vi.fn().mockResolvedValue(ok([HISTORY_FIXTURE])),
    getDownloadItems: vi.fn().mockResolvedValue(ok([DOWNLOAD_FIXTURE])),
    monitorDownloads: vi.fn().mockResolvedValue(ok([DOWNLOAD_FIXTURE])),
    ...overrides,
  } as IBrowserAdapter;
}

describe('Browser APIs handlers', () => {
  let adapter: IBrowserAdapter;

  beforeEach(() => {
    adapter = createMockAdapter();
  });

  describe('createListBookmarksHandler', () => {
    it('should list bookmarks successfully', async () => {
      const listBookmarks = createListBookmarksHandler(adapter);

      const result = await listBookmarks({ action: 'list' });

      expect(result).toEqual({ bookmarks: [BOOKMARK_FIXTURE] });
      expect(adapter.listBookmarks).toHaveBeenCalledWith(undefined);
    });

    it('should pass parentId when provided', async () => {
      const listBookmarks = createListBookmarksHandler(adapter);

      await listBookmarks({ action: 'list', parentId: '5' });

      expect(adapter.listBookmarks).toHaveBeenCalledWith('5');
    });

    it('should throw on adapter error', async () => {
      adapter = createMockAdapter({
        listBookmarks: vi.fn().mockResolvedValue(err({ code: ErrorCode.UNKNOWN, message: 'Failed' })),
      });
      const listBookmarks = createListBookmarksHandler(adapter);

      await expect(listBookmarks({ action: 'list' })).rejects.toThrow('[UNKNOWN] Failed');
    });

    it('should throw on invalid params', async () => {
      const listBookmarks = createListBookmarksHandler(adapter);

      await expect(listBookmarks({ action: 'invalid' })).rejects.toThrow('Invalid bookmarks params');
    });
  });

  describe('createCreateBookmarkHandler', () => {
    it('should create a bookmark successfully', async () => {
      const createBookmark = createCreateBookmarkHandler(adapter);

      const result = await createBookmark({ action: 'create', title: 'Test', url: 'https://test.com' });

      expect(result).toEqual({ bookmark: BOOKMARK_FIXTURE });
      expect(adapter.createBookmark).toHaveBeenCalledWith('Test', 'https://test.com', undefined);
    });

    it('should throw when title is missing', async () => {
      const createBookmark = createCreateBookmarkHandler(adapter);

      await expect(createBookmark({ action: 'create' })).rejects.toThrow('title is required');
    });

    it('should throw on adapter error', async () => {
      adapter = createMockAdapter({
        createBookmark: vi.fn().mockResolvedValue(err({ code: ErrorCode.UNKNOWN, message: 'Failed' })),
      });
      const createBookmark = createCreateBookmarkHandler(adapter);

      await expect(createBookmark({ action: 'create', title: 'Test' })).rejects.toThrow('[UNKNOWN] Failed');
    });
  });

  describe('createSearchBookmarksHandler', () => {
    it('should search bookmarks successfully', async () => {
      const searchBookmarks = createSearchBookmarksHandler(adapter);

      const result = await searchBookmarks({ action: 'search', query: 'example' });

      expect(result).toEqual({ bookmarks: [BOOKMARK_FIXTURE] });
      expect(adapter.searchBookmarks).toHaveBeenCalledWith('example');
    });

    it('should throw when query is missing', async () => {
      const searchBookmarks = createSearchBookmarksHandler(adapter);

      await expect(searchBookmarks({ action: 'search' })).rejects.toThrow('query is required');
    });

    it('should throw on adapter error', async () => {
      adapter = createMockAdapter({
        searchBookmarks: vi.fn().mockResolvedValue(err({ code: ErrorCode.UNKNOWN, message: 'Failed' })),
      });
      const searchBookmarks = createSearchBookmarksHandler(adapter);

      await expect(searchBookmarks({ action: 'search', query: 'test' })).rejects.toThrow('[UNKNOWN] Failed');
    });
  });

  describe('createSearchHistoryHandler', () => {
    it('should search history successfully', async () => {
      const searchHistory = createSearchHistoryHandler(adapter);

      const result = await searchHistory({ action: 'search', text: 'example' });

      expect(result).toEqual({ entries: [HISTORY_FIXTURE] });
      expect(adapter.searchHistory).toHaveBeenCalledWith('example', undefined, undefined, undefined);
    });

    it('should pass time range and maxResults', async () => {
      const searchHistory = createSearchHistoryHandler(adapter);

      await searchHistory({ action: 'search', text: 'test', startTime: 1000, endTime: 2000, maxResults: 10 });

      expect(adapter.searchHistory).toHaveBeenCalledWith('test', 1000, 2000, 10);
    });

    it('should throw on adapter error', async () => {
      adapter = createMockAdapter({
        searchHistory: vi.fn().mockResolvedValue(err({ code: ErrorCode.UNKNOWN, message: 'Failed' })),
      });
      const searchHistory = createSearchHistoryHandler(adapter);

      await expect(searchHistory({ action: 'search' })).rejects.toThrow('[UNKNOWN] Failed');
    });
  });

  describe('createGetHistoryEntriesHandler', () => {
    it('should get history entries successfully', async () => {
      const getEntries = createGetHistoryEntriesHandler(adapter);

      const result = await getEntries({ action: 'getEntries' });

      expect(result).toEqual({ entries: [HISTORY_FIXTURE] });
      expect(adapter.getHistoryEntries).toHaveBeenCalledWith(undefined);
    });

    it('should pass maxResults', async () => {
      const getEntries = createGetHistoryEntriesHandler(adapter);

      await getEntries({ action: 'getEntries', maxResults: 50 });

      expect(adapter.getHistoryEntries).toHaveBeenCalledWith(50);
    });

    it('should throw on adapter error', async () => {
      adapter = createMockAdapter({
        getHistoryEntries: vi.fn().mockResolvedValue(err({ code: ErrorCode.UNKNOWN, message: 'Failed' })),
      });
      const getEntries = createGetHistoryEntriesHandler(adapter);

      await expect(getEntries({ action: 'getEntries' })).rejects.toThrow('[UNKNOWN] Failed');
    });
  });

  describe('createGetDownloadItemsHandler', () => {
    it('should get download items successfully', async () => {
      const getItems = createGetDownloadItemsHandler(adapter);

      const result = await getItems({ action: 'getItems' });

      expect(result).toEqual({ downloads: [DOWNLOAD_FIXTURE] });
      expect(adapter.getDownloadItems).toHaveBeenCalledWith(undefined, undefined, undefined);
    });

    it('should pass query and state filters', async () => {
      const getItems = createGetDownloadItemsHandler(adapter);

      await getItems({ action: 'getItems', query: 'file.zip', state: 'complete', limit: 10 });

      expect(adapter.getDownloadItems).toHaveBeenCalledWith('file.zip', 'complete', 10);
    });

    it('should throw on adapter error', async () => {
      adapter = createMockAdapter({
        getDownloadItems: vi.fn().mockResolvedValue(err({ code: ErrorCode.UNKNOWN, message: 'Failed' })),
      });
      const getItems = createGetDownloadItemsHandler(adapter);

      await expect(getItems({ action: 'getItems' })).rejects.toThrow('[UNKNOWN] Failed');
    });
  });

  describe('createMonitorDownloadsHandler', () => {
    it('should monitor downloads successfully', async () => {
      const monitor = createMonitorDownloadsHandler(adapter);

      const result = await monitor({ action: 'monitor' });

      expect(result).toEqual({ downloads: [DOWNLOAD_FIXTURE] });
      expect(adapter.monitorDownloads).toHaveBeenCalled();
    });

    it('should return empty array when no active downloads', async () => {
      adapter = createMockAdapter({
        monitorDownloads: vi.fn().mockResolvedValue(ok([])),
      });
      const monitor = createMonitorDownloadsHandler(adapter);

      const result = await monitor({ action: 'monitor' });

      expect(result).toEqual({ downloads: [] });
    });

    it('should throw on adapter error', async () => {
      adapter = createMockAdapter({
        monitorDownloads: vi.fn().mockResolvedValue(err({ code: ErrorCode.UNKNOWN, message: 'Failed' })),
      });
      const monitor = createMonitorDownloadsHandler(adapter);

      await expect(monitor({ action: 'monitor' })).rejects.toThrow('[UNKNOWN] Failed');
    });
  });
});
