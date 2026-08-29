/**
 * Browser APIs tool handler.
 *
 * Routes bookmarks, browser history, and downloads commands to the
 * browser adapter's native API methods. Returns structured data or errors.
 */

import type { IBrowserAdapter, BookmarkNode, HistoryEntry, DownloadItem } from '@agentic-browser/shared';
import {
  BookmarksParamsSchema,
  BrowserHistoryParamsSchema,
  DownloadsParamsSchema,
} from '@agentic-browser/shared';

/** Response data for bookmarks operations. */
export interface BookmarksResponseData {
  readonly bookmarks: readonly BookmarkNode[];
}

/** Response data for a single bookmark creation. */
export interface BookmarkCreatedResponseData {
  readonly bookmark: BookmarkNode;
}

/** Response data for browser history operations. */
export interface BrowserHistoryResponseData {
  readonly entries: readonly HistoryEntry[];
}

/** Response data for downloads operations. */
export interface DownloadsResponseData {
  readonly downloads: readonly DownloadItem[];
}

/** Creates a listBookmarks command handler bound to the given browser adapter. */
export function createListBookmarksHandler(adapter: IBrowserAdapter) {
  return async (params: unknown): Promise<BookmarksResponseData> => {
    const parsed = BookmarksParamsSchema.safeParse(params);

    if (!parsed.success) {
      throw new Error(`Invalid bookmarks params: ${parsed.error.issues.map((i) => i.message).join(', ')}`);
    }

    const result = await adapter.listBookmarks(parsed.data.parentId);

    if (!result.ok) {
      throw new Error(`[${result.error.code}] ${result.error.message}`);
    }

    return { bookmarks: result.value };
  };
}

/** Creates a createBookmark command handler bound to the given browser adapter. */
export function createCreateBookmarkHandler(adapter: IBrowserAdapter) {
  return async (params: unknown): Promise<BookmarkCreatedResponseData> => {
    const parsed = BookmarksParamsSchema.safeParse(params);

    if (!parsed.success) {
      throw new Error(`Invalid bookmarks params: ${parsed.error.issues.map((i) => i.message).join(', ')}`);
    }

    if (!parsed.data.title) {
      throw new Error('Invalid bookmarks params: title is required for create action');
    }

    const result = await adapter.createBookmark(
      parsed.data.title,
      parsed.data.url,
      parsed.data.parentId,
    );

    if (!result.ok) {
      throw new Error(`[${result.error.code}] ${result.error.message}`);
    }

    return { bookmark: result.value };
  };
}

/** Creates a searchBookmarks command handler bound to the given browser adapter. */
export function createSearchBookmarksHandler(adapter: IBrowserAdapter) {
  return async (params: unknown): Promise<BookmarksResponseData> => {
    const parsed = BookmarksParamsSchema.safeParse(params);

    if (!parsed.success) {
      throw new Error(`Invalid bookmarks params: ${parsed.error.issues.map((i) => i.message).join(', ')}`);
    }

    if (!parsed.data.query) {
      throw new Error('Invalid bookmarks params: query is required for search action');
    }

    const result = await adapter.searchBookmarks(parsed.data.query);

    if (!result.ok) {
      throw new Error(`[${result.error.code}] ${result.error.message}`);
    }

    return { bookmarks: result.value };
  };
}

/** Creates a searchHistory command handler bound to the given browser adapter. */
export function createSearchHistoryHandler(adapter: IBrowserAdapter) {
  return async (params: unknown): Promise<BrowserHistoryResponseData> => {
    const parsed = BrowserHistoryParamsSchema.safeParse(params);

    if (!parsed.success) {
      throw new Error(`Invalid history params: ${parsed.error.issues.map((i) => i.message).join(', ')}`);
    }

    const result = await adapter.searchHistory(
      parsed.data.text ?? '',
      parsed.data.startTime,
      parsed.data.endTime,
      parsed.data.maxResults,
    );

    if (!result.ok) {
      throw new Error(`[${result.error.code}] ${result.error.message}`);
    }

    return { entries: result.value };
  };
}

/** Creates a getHistoryEntries command handler bound to the given browser adapter. */
export function createGetHistoryEntriesHandler(adapter: IBrowserAdapter) {
  return async (params: unknown): Promise<BrowserHistoryResponseData> => {
    const parsed = BrowserHistoryParamsSchema.safeParse(params);

    if (!parsed.success) {
      throw new Error(`Invalid history params: ${parsed.error.issues.map((i) => i.message).join(', ')}`);
    }

    const result = await adapter.getHistoryEntries(parsed.data.maxResults);

    if (!result.ok) {
      throw new Error(`[${result.error.code}] ${result.error.message}`);
    }

    return { entries: result.value };
  };
}

/** Creates a getDownloadItems command handler bound to the given browser adapter. */
export function createGetDownloadItemsHandler(adapter: IBrowserAdapter) {
  return async (params: unknown): Promise<DownloadsResponseData> => {
    const parsed = DownloadsParamsSchema.safeParse(params);

    if (!parsed.success) {
      throw new Error(`Invalid downloads params: ${parsed.error.issues.map((i) => i.message).join(', ')}`);
    }

    const result = await adapter.getDownloadItems(
      parsed.data.query,
      parsed.data.state,
      parsed.data.limit,
    );

    if (!result.ok) {
      throw new Error(`[${result.error.code}] ${result.error.message}`);
    }

    return { downloads: result.value };
  };
}

/** Creates a monitorDownloads command handler bound to the given browser adapter. */
export function createMonitorDownloadsHandler(adapter: IBrowserAdapter) {
  return async (params: unknown): Promise<DownloadsResponseData> => {
    const parsed = DownloadsParamsSchema.safeParse(params);

    if (!parsed.success) {
      throw new Error(`Invalid downloads params: ${parsed.error.issues.map((i) => i.message).join(', ')}`);
    }

    const result = await adapter.monitorDownloads();

    if (!result.ok) {
      throw new Error(`[${result.error.code}] ${result.error.message}`);
    }

    return { downloads: result.value };
  };
}
