/**
 * Central tool registry.
 *
 * Maps command names to handler functions and registers them with
 * the {@link CommandRouter}. All Phase 2 tools (navigate, interact,
 * tabs, dialog, wait) and Phase 3 tools (screenshot, accessibility)
 * are registered here. Also provides tool discovery via {@link getToolRegistry}.
 */

import type { z } from 'zod';
import type { IBrowserAdapter, CommandName } from '@agentic-browser/shared';
import {
  NavigateParamsSchema,
  ClickParamsSchema,
  TypeParamsSchema,
  SelectParamsSchema,
  HoverParamsSchema,
  ScrollParamsSchema,
  ScreenshotParamsSchema,
  CreateTabParamsSchema,
  CloseTabParamsSchema,
  SwitchTabParamsSchema,
  ListTabsParamsSchema,
  HandleDialogParamsSchema,
  GetDialogInfoParamsSchema,
  WaitForSelectorParamsSchema,
  WaitForNavigationParamsSchema,
  WaitForNetworkIdleParamsSchema,
  WaitForConditionParamsSchema,
  GetAccessibilityTreeParamsSchema,
  GetHTMLParamsSchema,
  ExtractDataParamsSchema,
  ExecuteScriptParamsSchema,
  ExecuteConsoleCommandParamsSchema,
  ExecuteScriptFileParamsSchema,
  ExecuteValidationParamsSchema,
  ModifyHTMLParamsSchema,
  ModifyCSSParamsSchema,
  InterceptNetworkParamsSchema,
  MetadataParamsSchema,
  StorageParamsSchema,
  FileOpsParamsSchema,
  HistoryParamsSchema,
  BookmarksParamsSchema,
  BrowserHistoryParamsSchema,
  DownloadsParamsSchema,
  EmulationParamsSchema,
  UndoRevertParamsSchema,
} from '@agentic-browser/shared';
import type { CommandRouter } from '../background/command-router.js';
import { createNavigateHandler } from './navigate.js';
import { createInteractHandler } from './interact.js';
import {
  createCreateTabHandler,
  createCloseTabHandler,
  createSwitchTabHandler,
  createListTabsHandler,
} from './tabs.js';
import { createHandleDialogHandler, createGetDialogInfoHandler } from './dialog.js';
import {
  createWaitForElementHandler,
  createWaitForNavigationHandler,
  createWaitForNetworkIdleHandler,
  createWaitForConditionHandler,
} from './wait.js';
import { createScreenshotHandler } from './screenshot.js';
import { createGetAccessibilityTreeHandler } from './accessibility.js';
import { createGetHTMLHandler } from './html.js';
import { createExtractDataHandler } from './extract-data.js';
import { createExecuteScriptHandler, createExecuteConsoleHandler, createExecuteScriptFileHandler, createExecuteValidationHandler } from './execute-script.js';
import { createModifyHTMLHandler, createUndoHTMLHandler } from './modify-html.js';
import { createModifyCSSHandler, createUndoCSSHandler } from './modify-css.js';
import { createInterceptNetworkHandler } from './network.js';
import { createMetadataHandler } from './metadata.js';
import { createStorageHandler } from './storage.js';
import { createFileOpsHandler } from './file-ops.js';
import { createHistoryHandler } from './history.js';
import {
  createListBookmarksHandler,
  createCreateBookmarkHandler,
  createSearchBookmarksHandler,
  createSearchHistoryHandler,
  createGetHistoryEntriesHandler,
  createGetDownloadItemsHandler,
  createMonitorDownloadsHandler,
} from './browser-apis.js';
import { createEmulationHandler } from './emulation.js';

/** Entry pairing a command name with its Zod schema and handler factory. */
interface ToolRegistration<T = unknown> {
  readonly command: CommandName;
  readonly schema: z.ZodType<T>;
  readonly createHandler: (adapter: IBrowserAdapter) => (params: T) => Promise<unknown>;
}

/** Descriptor exposed by tool discovery. */
export interface ToolRegistryEntry {
  readonly command: CommandName;
  readonly description: string;
  readonly supportedBackends: readonly ('chrome' | 'edge' | 'remote')[];
}

/** All tools common to every backend. */
const COMMON_BACKENDS: readonly ('chrome' | 'edge' | 'remote')[] = ['chrome', 'edge', 'remote'];

/** Tools restricted to local (chrome/edge) backends. */
const LOCAL_BACKENDS: readonly ('chrome' | 'edge')[] = ['chrome', 'edge'];

/**
 * Builds the list of tool registrations for all Phase 2 and Phase 3 commands.
 *
 * Interact commands (click, type, select, hover, scroll) are registered
 * individually by wrapping the shared interact handler with the action
 * pre-injected into the params.
 */
/** Static tool metadata for discovery. */
const TOOL_REGISTRY: readonly ToolRegistryEntry[] = [
  { command: 'navigate', description: 'Navigate to a URL', supportedBackends: COMMON_BACKENDS },
  { command: 'click', description: 'Click an element by CSS selector', supportedBackends: COMMON_BACKENDS },
  { command: 'type', description: 'Type text into an element', supportedBackends: COMMON_BACKENDS },
  { command: 'select', description: 'Select an option in a <select> element', supportedBackends: COMMON_BACKENDS },
  { command: 'hover', description: 'Hover over an element', supportedBackends: COMMON_BACKENDS },
  { command: 'scroll', description: 'Scroll the page or an element', supportedBackends: COMMON_BACKENDS },
  { command: 'captureScreenshot', description: 'Capture a screenshot', supportedBackends: COMMON_BACKENDS },
  { command: 'getAccessibilityTree', description: 'Get accessibility tree', supportedBackends: COMMON_BACKENDS },
  { command: 'createTab', description: 'Create a new tab', supportedBackends: COMMON_BACKENDS },
  { command: 'closeTab', description: 'Close a tab', supportedBackends: COMMON_BACKENDS },
  { command: 'switchTab', description: 'Switch to a tab', supportedBackends: COMMON_BACKENDS },
  { command: 'listTabs', description: 'List open tabs', supportedBackends: COMMON_BACKENDS },
  { command: 'handleDialog', description: 'Handle a JS dialog', supportedBackends: COMMON_BACKENDS },
  { command: 'getDialogInfo', description: 'Get the current JS dialog', supportedBackends: COMMON_BACKENDS },
  { command: 'waitForSelector', description: 'Wait for an element', supportedBackends: COMMON_BACKENDS },
  { command: 'waitForNavigation', description: 'Wait for navigation', supportedBackends: COMMON_BACKENDS },
  { command: 'waitForNetworkIdle', description: 'Wait for network idle', supportedBackends: COMMON_BACKENDS },
  { command: 'waitForCondition', description: 'Wait for a JS condition', supportedBackends: COMMON_BACKENDS },
  { command: 'getHTML', description: 'Get HTML content', supportedBackends: COMMON_BACKENDS },
  { command: 'extractData', description: 'Extract structured data', supportedBackends: COMMON_BACKENDS },
  { command: 'executeScript', description: 'Execute JavaScript', supportedBackends: COMMON_BACKENDS },
  { command: 'executeConsoleCommand', description: 'Execute a console command', supportedBackends: COMMON_BACKENDS },
  { command: 'executeScriptFile', description: 'Execute a JavaScript file from a URL', supportedBackends: COMMON_BACKENDS },
  { command: 'executeValidation', description: 'Run a validation script with structured results', supportedBackends: COMMON_BACKENDS },
  { command: 'modifyHTML', description: 'Modify HTML content', supportedBackends: COMMON_BACKENDS },
  { command: 'modifyCSS', description: 'Modify CSS styles', supportedBackends: COMMON_BACKENDS },
  { command: 'interceptNetwork', description: 'Intercept network requests', supportedBackends: COMMON_BACKENDS },
  { command: 'getStorage', description: 'Get browser storage', supportedBackends: LOCAL_BACKENDS },
  { command: 'setStorage', description: 'Set browser storage', supportedBackends: LOCAL_BACKENDS },
  { command: 'clearStorage', description: 'Clear browser storage', supportedBackends: LOCAL_BACKENDS },
  { command: 'uploadFile', description: 'Upload files to an input', supportedBackends: LOCAL_BACKENDS },
  { command: 'downloadStatus', description: 'Check download status', supportedBackends: LOCAL_BACKENDS },
  { command: 'startDownload', description: 'Start a download', supportedBackends: LOCAL_BACKENDS },
  { command: 'goBack', description: 'Navigate back in history', supportedBackends: COMMON_BACKENDS },
  { command: 'goForward', description: 'Navigate forward in history', supportedBackends: COMMON_BACKENDS },
  { command: 'reload', description: 'Reload the page', supportedBackends: COMMON_BACKENDS },
  { command: 'listBookmarks', description: 'List bookmarks', supportedBackends: LOCAL_BACKENDS },
  { command: 'createBookmark', description: 'Create a bookmark', supportedBackends: LOCAL_BACKENDS },
  { command: 'searchBookmarks', description: 'Search bookmarks', supportedBackends: LOCAL_BACKENDS },
  { command: 'searchHistory', description: 'Search browser history', supportedBackends: LOCAL_BACKENDS },
  { command: 'getHistoryEntries', description: 'Get history entries', supportedBackends: LOCAL_BACKENDS },
  { command: 'getDownloadItems', description: 'Get download items', supportedBackends: LOCAL_BACKENDS },
  { command: 'monitorDownloads', description: 'Monitor active downloads', supportedBackends: LOCAL_BACKENDS },
  { command: 'getMetadata', description: 'Extract page metadata', supportedBackends: COMMON_BACKENDS },
  { command: 'emulateDevice', description: 'Emulate a mobile device or reset to desktop', supportedBackends: COMMON_BACKENDS },
  { command: 'undoModification', description: 'Undo last HTML or CSS modification', supportedBackends: COMMON_BACKENDS },
  { command: 'revertAll', description: 'Revert all HTML or CSS modifications', supportedBackends: COMMON_BACKENDS },
];

/**
 * Returns available tools filtered by backend type.
 *
 * @param backend - If provided, only return tools supporting that backend.
 * @returns Array of tool registry entries.
 */
export function getToolRegistry(
  backend?: 'chrome' | 'edge' | 'remote',
): readonly ToolRegistryEntry[] {
  if (!backend) {
    return TOOL_REGISTRY;
  }
  return TOOL_REGISTRY.filter((entry) => entry.supportedBackends.includes(backend));
}

function buildRegistrations(adapter: IBrowserAdapter): readonly ToolRegistration[] {
  const interactHandler = createInteractHandler(adapter);
  const undoHtmlHandler = createUndoHTMLHandler(adapter);
  const undoCssHandler = createUndoCSSHandler(adapter);

  const wrapInteract = (action: string) => {
    return (params: unknown): Promise<unknown> => {
      return interactHandler({ ...(params as Record<string, unknown>), action });
    };
  };
  const undoModification = (params: unknown): Promise<unknown> => {
    const parsed = UndoRevertParamsSchema.parse(params);
    return parsed.action.endsWith('CSS') ? undoCssHandler(parsed) : undoHtmlHandler(parsed);
  };

  return [
    { command: 'navigate', schema: NavigateParamsSchema, createHandler: () => createNavigateHandler(adapter) },
    { command: 'click', schema: ClickParamsSchema, createHandler: () => wrapInteract('click') },
    { command: 'type', schema: TypeParamsSchema, createHandler: () => wrapInteract('type') },
    { command: 'select', schema: SelectParamsSchema, createHandler: () => wrapInteract('select') },
    { command: 'hover', schema: HoverParamsSchema, createHandler: () => wrapInteract('hover') },
    { command: 'scroll', schema: ScrollParamsSchema, createHandler: () => wrapInteract('scroll') },
    { command: 'captureScreenshot', schema: ScreenshotParamsSchema, createHandler: () => createScreenshotHandler(adapter) },
    { command: 'getAccessibilityTree', schema: GetAccessibilityTreeParamsSchema, createHandler: () => createGetAccessibilityTreeHandler(adapter) },
    { command: 'createTab', schema: CreateTabParamsSchema, createHandler: () => createCreateTabHandler(adapter) },
    { command: 'closeTab', schema: CloseTabParamsSchema, createHandler: () => createCloseTabHandler(adapter) },
    { command: 'switchTab', schema: SwitchTabParamsSchema, createHandler: () => createSwitchTabHandler(adapter) },
    { command: 'listTabs', schema: ListTabsParamsSchema, createHandler: () => createListTabsHandler(adapter) },
    { command: 'handleDialog', schema: HandleDialogParamsSchema, createHandler: () => createHandleDialogHandler(adapter) },
    { command: 'getDialogInfo', schema: GetDialogInfoParamsSchema, createHandler: () => createGetDialogInfoHandler(adapter) },
    { command: 'waitForSelector', schema: WaitForSelectorParamsSchema, createHandler: () => createWaitForElementHandler(adapter) },
    { command: 'waitForNavigation', schema: WaitForNavigationParamsSchema, createHandler: () => createWaitForNavigationHandler(adapter) },
    { command: 'waitForNetworkIdle', schema: WaitForNetworkIdleParamsSchema, createHandler: () => createWaitForNetworkIdleHandler(adapter) },
    { command: 'waitForCondition', schema: WaitForConditionParamsSchema, createHandler: () => createWaitForConditionHandler(adapter) },
    { command: 'getHTML', schema: GetHTMLParamsSchema, createHandler: () => createGetHTMLHandler(adapter) },
    { command: 'extractData', schema: ExtractDataParamsSchema, createHandler: () => createExtractDataHandler(adapter) },
    { command: 'executeScript', schema: ExecuteScriptParamsSchema, createHandler: () => createExecuteScriptHandler(adapter) },
    { command: 'executeConsoleCommand', schema: ExecuteConsoleCommandParamsSchema, createHandler: () => createExecuteConsoleHandler(adapter) },
    { command: 'executeScriptFile', schema: ExecuteScriptFileParamsSchema, createHandler: () => createExecuteScriptFileHandler(adapter) },
    { command: 'executeValidation', schema: ExecuteValidationParamsSchema, createHandler: () => createExecuteValidationHandler(adapter) },
    { command: 'modifyHTML', schema: ModifyHTMLParamsSchema, createHandler: () => createModifyHTMLHandler(adapter) },
    { command: 'modifyCSS', schema: ModifyCSSParamsSchema, createHandler: () => createModifyCSSHandler(adapter) },
    { command: 'interceptNetwork', schema: InterceptNetworkParamsSchema, createHandler: () => createInterceptNetworkHandler(adapter) },
    { command: 'getStorage', schema: StorageParamsSchema, createHandler: () => createStorageHandler(adapter) },
    { command: 'setStorage', schema: StorageParamsSchema, createHandler: () => createStorageHandler(adapter) },
    { command: 'clearStorage', schema: StorageParamsSchema, createHandler: () => createStorageHandler(adapter) },
    { command: 'uploadFile', schema: FileOpsParamsSchema, createHandler: () => createFileOpsHandler(adapter) },
    { command: 'downloadStatus', schema: FileOpsParamsSchema, createHandler: () => createFileOpsHandler(adapter) },
    { command: 'startDownload', schema: FileOpsParamsSchema, createHandler: () => createFileOpsHandler(adapter) },
    { command: 'goBack', schema: HistoryParamsSchema, createHandler: () => createHistoryHandler(adapter) },
    { command: 'goForward', schema: HistoryParamsSchema, createHandler: () => createHistoryHandler(adapter) },
    { command: 'reload', schema: HistoryParamsSchema, createHandler: () => createHistoryHandler(adapter) },
    { command: 'listBookmarks', schema: BookmarksParamsSchema, createHandler: () => createListBookmarksHandler(adapter) },
    { command: 'createBookmark', schema: BookmarksParamsSchema, createHandler: () => createCreateBookmarkHandler(adapter) },
    { command: 'searchBookmarks', schema: BookmarksParamsSchema, createHandler: () => createSearchBookmarksHandler(adapter) },
    { command: 'searchHistory', schema: BrowserHistoryParamsSchema, createHandler: () => createSearchHistoryHandler(adapter) },
    { command: 'getHistoryEntries', schema: BrowserHistoryParamsSchema, createHandler: () => createGetHistoryEntriesHandler(adapter) },
    { command: 'getDownloadItems', schema: DownloadsParamsSchema, createHandler: () => createGetDownloadItemsHandler(adapter) },
    { command: 'monitorDownloads', schema: DownloadsParamsSchema, createHandler: () => createMonitorDownloadsHandler(adapter) },
    { command: 'getMetadata', schema: MetadataParamsSchema, createHandler: () => createMetadataHandler(adapter) },
    {
      command: 'emulateDevice',
      schema: EmulationParamsSchema,
      createHandler: () => (params: unknown) =>
        createEmulationHandler(adapter)(EmulationParamsSchema.parse(params)),
    },
    { command: 'undoModification', schema: UndoRevertParamsSchema, createHandler: () => undoModification },
    { command: 'revertAll', schema: UndoRevertParamsSchema, createHandler: () => undoModification },
  ];
}

/**
 * Registers all Phase 2 and Phase 3 tool handlers with the command router.
 *
 * @param router - The command router to register handlers on.
 * @param adapter - The browser adapter that handlers delegate to.
 */
export function registerTools(router: CommandRouter, adapter: IBrowserAdapter): void {
  const registrations = buildRegistrations(adapter);

  for (const reg of registrations) {
    router.registerHandler(reg.command, reg.schema, reg.createHandler(adapter));
  }
}
