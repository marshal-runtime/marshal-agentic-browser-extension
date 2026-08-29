/**
 * Chrome browser adapter implementing {@link IBrowserAdapter}.
 *
 * Delegates tab management to {@link TabTracker} and chrome.tabs APIs.
 * DOM interaction methods delegate to the content script via
 * chrome.tabs.sendMessage, falling back to chrome.scripting.executeScript.
 * Dialog handling uses CDP Page domain events and commands.
 * Unimplemented methods return a NOT_IMPLEMENTED error result until their
 * feature area is built out.
 */

import type {
  IBrowserAdapter,
  ConnectOptions,
  ConnectionStatus,
  NavigateOptions,
  WaitUntilCondition,
  ClickOptions,
  TypeOptions,
  HoverOptions,
  ScrollOptions,
  SelectOptions,
  FocusOptions,
  CreateTabOptions,
  TabInfo,
  HandleDialogOptions,
  DialogInfo,
  DialogType,
  ScreenshotOptions,
  ScreenshotResult,
  AccessibilityNode,
  ExecuteScriptOptions,
  ConsoleCommandOptions,
  ExecuteScriptFileOptions,
  ExecuteValidationOptions,
  ValidationResult,
  CommandRequest,
  CommandResponse,
  CdpCommandOptions,
  ErrorResponse,
  Result,
} from '@agentic-browser/shared';
import {
  ErrorCode,
  DEFAULT_NAVIGATION_TIMEOUT,
  DEFAULT_SCREENSHOT_FORMAT,
  DEFAULT_SCREENSHOT_QUALITY,
  DEFAULT_SCRIPT_TIMEOUT,
  ok,
  err,
} from '@agentic-browser/shared';
import type { TabTracker } from '../infrastructure/tab-tracker.js';
import type { CDPManager } from '../infrastructure/cdp-manager.js';
import type { CDPEventListener } from '../infrastructure/cdp-manager.js';
import type { Logger } from '../infrastructure/logger.js';
import type { IsolatedBrowserContext } from './browser-isolation.js';

const CHROME_INCOGNITO_CONTEXT_ID = 'chrome-incognito';

/**
 * Builds a NOT_IMPLEMENTED {@link ErrorResponse} for a given method name.
 */
function notImplemented(method: string): Result<never, ErrorResponse> {
  return err({
    code: ErrorCode.UNKNOWN,
    message: `NOT_IMPLEMENTED: ${method} is not yet implemented in ChromeAdapter`,
  });
}

/** Maps screenshot format to chrome.tabs.captureVisibleTab format string. */
function toChromeImageFormat(format: string): 'png' | 'jpeg' {
  return format === 'jpeg' ? 'jpeg' : 'png';
}

/** Returns the MIME type for a screenshot format. */
function toMimeType(format: string): string {
  switch (format) {
    case 'jpeg':
      return 'image/jpeg';
    case 'webp':
      return 'image/webp';
    default:
      return 'image/png';
  }
}

/** CDP event params for Page.javascriptDialogOpening. */
interface JavaScriptDialogOpeningParams {
  readonly url: string;
  readonly message: string;
  readonly type: string;
  readonly hasBrowserHandler: boolean;
  readonly defaultPrompt?: string;
}

/** CDP Page.captureScreenshot response. */
interface CdpScreenshotResponse {
  readonly data: string;
}

/** CDP Accessibility.getFullAXTree node. */
interface CdpAXNode {
  readonly nodeId: string;
  readonly role?: { readonly value: string };
  readonly name?: { readonly value: string };
  readonly value?: { readonly value: string };
  readonly description?: { readonly value: string };
  readonly childIds?: readonly string[];
  readonly properties?: ReadonlyArray<{
    readonly name: string;
    readonly value: { readonly value: unknown };
  }>;
  readonly ignored?: boolean;
  readonly backendDOMNodeId?: number;
}

/** CDP Accessibility.getFullAXTree response. */
interface CdpAXTreeResponse {
  readonly nodes: readonly CdpAXNode[];
}

/** Wrapper result returned from the injected script function. */
interface ScriptResultWrapper {
  readonly ok: boolean;
  readonly value?: unknown;
  readonly error?: string;
  readonly stack?: string;
}

/** CDP Runtime.evaluate response. */
interface CdpEvaluateResponse {
  readonly result: {
    readonly type: string;
    readonly subtype?: string;
    readonly value?: unknown;
    readonly description?: string;
    readonly className?: string;
  };
  readonly exceptionDetails?: {
    readonly text: string;
    readonly exception?: {
      readonly description?: string;
    };
  };
}

/** CDP Runtime.consoleAPICalled event params. */
interface ConsoleAPICalledParams {
  readonly type: string;
  readonly args: ReadonlyArray<{
    readonly type: string;
    readonly value?: unknown;
    readonly description?: string;
    readonly preview?: unknown;
  }>;
  readonly timestamp: number;
}

/** Captured console entry used internally before returning results. */
interface CapturedConsoleEntry {
  readonly level: 'log' | 'warn' | 'error' | 'info' | 'debug';
  readonly args: unknown[];
  readonly timestamp: number;
}

/**
 * Chrome extension adapter that bridges the {@link IBrowserAdapter} interface
 * to the Chrome Extensions API.
 *
 * Implemented methods: {@link connect}, {@link disconnect},
 * {@link createTab}, {@link closeTab}, {@link listTabs},
 * {@link switchTab}, {@link getActiveTab}, {@link handleDialog},
 * {@link getDialogInfo}, {@link captureScreenshot},
 * {@link captureFullPageScreenshot}, {@link getAccessibilityTree},
 * {@link executeScript}, {@link executeConsoleCommand}.
 * All remaining methods return a descriptive NOT_IMPLEMENTED error result.
 */
class ChromeAdapter implements IBrowserAdapter {
  readonly isolationCapabilities = {
    resource: 'incognito-profile',
    concurrentContexts: false,
    cookieIsolation: true,
    webStorageIsolation: true,
  } as const;
  private readonly tabTracker: TabTracker;
  private readonly cdpManager: CDPManager;
  private readonly logger: Logger;
  private connected = false;
  private currentDialog: DialogInfo | null = null;
  private autoDismiss = true;
  private dialogListenerAttachedTabs = new Set<number>();
  private readonly isolatedBrowserContexts = new Map<string, number>();
  private windowRemovalListenerRegistered = false;

  constructor(tabTracker: TabTracker, cdpManager: CDPManager, logger: Logger) {
    this.tabTracker = tabTracker;
    this.cdpManager = cdpManager;
    this.logger = logger;
  }

  // -- Lifecycle -------------------------------------------------------------

  /** Connects the adapter and initialises the tab tracker. */
  async connect(options?: ConnectOptions): Promise<Result<ConnectionStatus, ErrorResponse>> {
    try {
      await this.tabTracker.init();
      this.connected = true;

      const manifest = chrome.runtime.getManifest();
      const platformInfo = await chrome.runtime.getPlatformInfo();

      const status: ConnectionStatus = {
        connected: true,
        browserName: 'Chrome',
        browserVersion: manifest.version,
      };

      this.logger.info('ChromeAdapter connected', {
        version: manifest.version,
        platform: platformInfo.os,
        timeout: options?.timeout,
      });

      return ok(status);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown connection error';
      this.logger.error('ChromeAdapter connection failed', { error: message });
      return err({ code: ErrorCode.CONNECTION_FAILED, message });
    }
  }

  /** Disconnects the adapter. */
  disconnect(): Promise<Result<void, ErrorResponse>> {
    this.connected = false;
    this.currentDialog = null;
    this.dialogListenerAttachedTabs.clear();
    if (this.windowRemovalListenerRegistered) {
      chrome.windows.onRemoved.removeListener(this.handleWindowRemoved);
      this.windowRemovalListenerRegistered = false;
    }
    this.logger.info('ChromeAdapter disconnected');
    return Promise.resolve(ok(undefined));
  }

  /** Returns whether the adapter is currently connected. */
  isConnected(): boolean {
    return this.connected;
  }

  async createIsolatedBrowserContext(
    browserSessionId: string,
  ): Promise<Result<IsolatedBrowserContext, ErrorResponse>> {
    this.registerWindowRemovalListener();
    if (this.isolatedBrowserContexts.size > 0) {
      return err({
        code: ErrorCode.PERMISSION_DENIED,
        message:
          'Chrome exposes one shared incognito storage context to extensions; release the active Marshal browser session before starting another',
      });
    }

    try {
      const incognitoAccess = await this.hasIncognitoAccess();
      if (!incognitoAccess) {
        return err({
          code: ErrorCode.PERMISSION_DENIED,
          message:
            'Incognito access is required for Marshal session isolation; enable "Allow in Incognito" for the extension',
        });
      }

      const existingWindows = await chrome.windows.getAll({
        populate: false,
        windowTypes: ['normal'],
      });
      if (existingWindows.some((window) => window.incognito)) {
        return err({
          code: ErrorCode.PERMISSION_DENIED,
          message:
            'Close existing incognito windows before starting a Marshal browser session so cookies and web storage cannot be shared',
        });
      }

      const window = await chrome.windows.create({
        url: 'about:blank',
        focused: true,
        incognito: true,
        type: 'normal',
      });
      const windowId = window.id;
      if (windowId === undefined) {
        return err({
          code: ErrorCode.UNKNOWN,
          message: 'Chrome created an incognito window without a usable ID',
        });
      }
      if (!window.incognito) {
        await chrome.windows.remove(windowId);
        return err({
          code: ErrorCode.PERMISSION_DENIED,
          message: 'Chrome did not create the required incognito window',
        });
      }

      const tabs = await chrome.tabs.query({ windowId });
      const initialTab = tabs.find((tab) => tab.id !== undefined);
      if (!initialTab || initialTab.id === undefined) {
        await chrome.windows.remove(windowId);
        return err({
          code: ErrorCode.TAB_NOT_FOUND,
          message: 'The isolated Chrome window did not contain an initial tab',
        });
      }

      this.isolatedBrowserContexts.set(CHROME_INCOGNITO_CONTEXT_ID, windowId);
      this.logger.info('Isolated browser window created', {
        browserSessionId,
        browserContextId: CHROME_INCOGNITO_CONTEXT_ID,
        windowId,
      });
      return ok({
        browserContextId: CHROME_INCOGNITO_CONTEXT_ID,
        windowId,
        initialTab: this.toTabInfo(initialTab),
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Failed to create an isolated browser window';
      this.logger.error('createIsolatedBrowserContext failed', {
        browserSessionId,
        error: message,
      });
      return err({ code: ErrorCode.PERMISSION_DENIED, message });
    }
  }

  async closeIsolatedBrowserContext(
    browserContextId: string,
  ): Promise<Result<void, ErrorResponse>> {
    const windowId = this.isolatedBrowserContexts.get(browserContextId);
    if (windowId === undefined) {
      return ok(undefined);
    }

    try {
      await chrome.windows.remove(windowId);
      this.isolatedBrowserContexts.delete(browserContextId);
      this.logger.info('Isolated browser window closed', {
        browserContextId,
        windowId,
      });
      return ok(undefined);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Failed to close isolated browser window';
      this.logger.error('closeIsolatedBrowserContext failed', {
        browserContextId,
        windowId,
        error: message,
      });
      return err({ code: ErrorCode.UNKNOWN, message });
    }
  }

  private readonly handleWindowRemoved = (windowId: number): void => {
    for (const [browserContextId, ownedWindowId] of this.isolatedBrowserContexts) {
      if (ownedWindowId === windowId) {
        this.isolatedBrowserContexts.delete(browserContextId);
      }
    }
  };

  private registerWindowRemovalListener(): void {
    if (!this.windowRemovalListenerRegistered) {
      chrome.windows.onRemoved.addListener(this.handleWindowRemoved);
      this.windowRemovalListenerRegistered = true;
    }
  }

  async isTabInIsolatedBrowserContext(
    browserContextId: string,
    tabId: number,
  ): Promise<Result<boolean, ErrorResponse>> {
    const windowId = this.isolatedBrowserContexts.get(browserContextId);
    if (windowId === undefined) {
      return err({
        code: ErrorCode.UNKNOWN,
        message: `Unknown isolated browser context: ${browserContextId}`,
      });
    }

    try {
      const tab = await chrome.tabs.get(tabId);
      return ok(tab.windowId === windowId && tab.incognito);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to inspect browser tab';
      return err({ code: ErrorCode.TAB_NOT_FOUND, message });
    }
  }

  async createIsolatedBrowserTab(
    browserContextId: string,
    options?: CreateTabOptions,
  ): Promise<Result<TabInfo, ErrorResponse>> {
    const windowId = this.isolatedBrowserContexts.get(browserContextId);
    if (windowId === undefined) {
      return err({
        code: ErrorCode.UNKNOWN,
        message: `Unknown isolated browser context: ${browserContextId}`,
      });
    }
    return this.createTab({ ...options, windowId });
  }

  async activateIsolatedBrowserTab(
    browserContextId: string,
    tabId: number,
  ): Promise<Result<void, ErrorResponse>> {
    const ownership = await this.isTabInIsolatedBrowserContext(browserContextId, tabId);
    if (!ownership.ok) {
      return ownership;
    }
    if (!ownership.value) {
      return err({
        code: ErrorCode.PERMISSION_DENIED,
        message: `Browser tab ${String(tabId)} is outside isolated context ${browserContextId}`,
      });
    }

    const windowId = this.isolatedBrowserContexts.get(browserContextId);
    if (windowId === undefined) {
      return err({
        code: ErrorCode.UNKNOWN,
        message: `Unknown isolated browser context: ${browserContextId}`,
      });
    }

    try {
      await chrome.tabs.update(tabId, { active: true });
      await chrome.windows.update(windowId, { focused: true });
      return ok(undefined);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to activate browser tab';
      return err({ code: ErrorCode.TAB_NOT_FOUND, message });
    }
  }

  private hasIncognitoAccess(): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      chrome.extension.isAllowedIncognitoAccess(resolve);
    });
  }

  private toTabInfo(tab: chrome.tabs.Tab): TabInfo {
    return {
      tabId: tab.id ?? -1,
      url: tab.url ?? '',
      title: tab.title ?? '',
      active: tab.active,
      windowId: tab.windowId,
    };
  }

  // -- Navigation ------------------------------------------------------------

  /** Navigates the active tab to a URL and waits for the specified load condition. */
  async navigate(options: NavigateOptions): Promise<Result<string, ErrorResponse>> {
    const { url, waitUntil = 'load', timeout = DEFAULT_NAVIGATION_TIMEOUT } = options;

    try {
      new URL(url);
    } catch {
      return err({
        code: ErrorCode.NAVIGATION_FAILED,
        message: `Invalid URL: ${url}`,
      });
    }

    const activeTab = this.tabTracker.getActiveTab();
    if (!activeTab) {
      return err({ code: ErrorCode.TAB_NOT_FOUND, message: 'No active tab found' });
    }

    const tabId = activeTab.id;

    try {
      const finalUrl = await this.navigateWithWait(tabId, url, waitUntil, timeout);
      this.logger.debug('Navigation completed', { tabId, url: finalUrl, waitUntil });
      return ok(finalUrl);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Navigation failed';
      if (message.includes('timeout')) {
        return err({ code: ErrorCode.TIMEOUT, message });
      }
      this.logger.error('navigate failed', { tabId, url, error: message });
      return err({ code: ErrorCode.NAVIGATION_FAILED, message });
    }
  }

  /**
   * Performs the actual navigation and waits for the specified load condition.
   * Uses chrome.tabs.update to initiate and chrome.webNavigation.onCompleted
   * to detect completion.
   */
  private navigateWithWait(
    tabId: number,
    url: string,
    waitUntil: WaitUntilCondition,
    timeout: number,
  ): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      let settled = false;

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new Error(`Navigation timeout after ${timeout}ms for ${url}`));
      }, timeout);

      const cleanup = (): void => {
        clearTimeout(timer);
        if (waitUntil === 'domcontentloaded') {
          chrome.webNavigation.onDOMContentLoaded.removeListener(onDOMContentLoaded);
        } else {
          chrome.webNavigation.onCompleted.removeListener(onCompleted);
        }
      };

      const settle = (finalUrl: string): void => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(finalUrl);
      };

      const onCompleted = (
        details: chrome.webNavigation.WebNavigationFramedCallbackDetails,
      ): void => {
        if (details.tabId === tabId && details.frameId === 0) {
          settle(details.url);
        }
      };

      const onDOMContentLoaded = (
        details: chrome.webNavigation.WebNavigationFramedCallbackDetails,
      ): void => {
        if (details.tabId === tabId && details.frameId === 0) {
          settle(details.url);
        }
      };

      if (waitUntil === 'domcontentloaded') {
        chrome.webNavigation.onDOMContentLoaded.addListener(onDOMContentLoaded);
      } else {
        chrome.webNavigation.onCompleted.addListener(onCompleted);
      }

      chrome.tabs.update(tabId, { url }).catch((error: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        const message = error instanceof Error ? error.message : 'Failed to update tab URL';
        reject(new Error(message));
      });
    });
  }

  waitForLoad: IBrowserAdapter['waitForLoad'] = () =>
    Promise.resolve(notImplemented('waitForLoad'));

  /** Navigates the active tab back in history via chrome.tabs.goBack. */
  async goBack(): Promise<Result<string, ErrorResponse>> {
    const activeTab = this.tabTracker.getActiveTab();
    if (!activeTab) {
      return err({ code: ErrorCode.TAB_NOT_FOUND, message: 'No active tab found' });
    }

    try {
      await chrome.tabs.goBack(activeTab.id);
      const tab = await chrome.tabs.get(activeTab.id);
      const url = tab.url ?? '';
      this.logger.debug('goBack completed', { tabId: activeTab.id, url });
      return ok(url);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to go back';
      this.logger.error('goBack failed', { tabId: activeTab.id, error: message });
      return err({ code: ErrorCode.NAVIGATION_FAILED, message });
    }
  }

  /** Navigates the active tab forward in history via chrome.tabs.goForward. */
  async goForward(): Promise<Result<string, ErrorResponse>> {
    const activeTab = this.tabTracker.getActiveTab();
    if (!activeTab) {
      return err({ code: ErrorCode.TAB_NOT_FOUND, message: 'No active tab found' });
    }

    try {
      await chrome.tabs.goForward(activeTab.id);
      const tab = await chrome.tabs.get(activeTab.id);
      const url = tab.url ?? '';
      this.logger.debug('goForward completed', { tabId: activeTab.id, url });
      return ok(url);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to go forward';
      this.logger.error('goForward failed', { tabId: activeTab.id, error: message });
      return err({ code: ErrorCode.NAVIGATION_FAILED, message });
    }
  }

  /** Reloads the active tab via chrome.tabs.reload with optional cache bypass. */
  async reload(hard?: boolean): Promise<Result<string, ErrorResponse>> {
    const activeTab = this.tabTracker.getActiveTab();
    if (!activeTab) {
      return err({ code: ErrorCode.TAB_NOT_FOUND, message: 'No active tab found' });
    }

    try {
      await chrome.tabs.reload(activeTab.id, { bypassCache: hard ?? false });
      const tab = await chrome.tabs.get(activeTab.id);
      const url = tab.url ?? '';
      this.logger.debug('reload completed', { tabId: activeTab.id, url, hard });
      return ok(url);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to reload';
      this.logger.error('reload failed', { tabId: activeTab.id, error: message });
      return err({ code: ErrorCode.NAVIGATION_FAILED, message });
    }
  }

  /** Sets file paths on a file input element via CDP DOM.setFileInputFiles. */
  async setFileInput(
    tabId: number,
    selector: string,
    filePaths: readonly string[],
  ): Promise<Result<void, ErrorResponse>> {
    try {
      if (!this.cdpManager.isAttached(tabId)) {
        await this.cdpManager.attach(tabId);
      }

      await this.cdpManager.sendCommand(tabId, 'DOM.enable');

      const docResult = await this.cdpManager.sendCommand<{ root: { nodeId: number } }>(
        tabId,
        'DOM.getDocument',
      );

      const queryResult = await this.cdpManager.sendCommand<{ nodeId: number }>(
        tabId,
        'DOM.querySelector',
        { nodeId: docResult.root.nodeId, selector },
      );

      if (!queryResult.nodeId) {
        return err({
          code: ErrorCode.UNKNOWN,
          message: `No element found for selector: ${selector}`,
        });
      }

      await this.cdpManager.sendCommand(tabId, 'DOM.setFileInputFiles', {
        nodeId: queryResult.nodeId,
        files: [...filePaths],
      });

      this.logger.debug('setFileInput completed', { tabId, selector, fileCount: filePaths.length });
      return ok(undefined);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to set file input';
      this.logger.error('setFileInput failed', { tabId, selector, error: message });
      return err({ code: ErrorCode.UNKNOWN, message });
    }
  }

  /** Queries the status of a download by ID via chrome.downloads API. */
  async getDownloadStatus(
    downloadId: number,
  ): Promise<
    Result<
      { state: string; bytesReceived: number; totalBytes: number; filename: string },
      ErrorResponse
    >
  > {
    try {
      const downloads = await chrome.downloads.search({ id: downloadId });
      if (downloads.length === 0) {
        return err({ code: ErrorCode.UNKNOWN, message: `Download not found: ${downloadId}` });
      }

      const [dl] = downloads;
      if (!dl) {
        return err({ code: ErrorCode.UNKNOWN, message: `Download not found: ${downloadId}` });
      }
      this.logger.debug('getDownloadStatus completed', { downloadId, state: dl.state });
      return ok({
        state: dl.state,
        bytesReceived: dl.bytesReceived,
        totalBytes: dl.totalBytes,
        filename: dl.filename,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to get download status';
      this.logger.error('getDownloadStatus failed', { downloadId, error: message });
      return err({ code: ErrorCode.UNKNOWN, message });
    }
  }

  /** Initiates a download for a given URL via chrome.downloads API. */
  async startDownload(url: string): Promise<Result<{ downloadId: number }, ErrorResponse>> {
    try {
      const downloadId = await chrome.downloads.download({ url });
      this.logger.debug('startDownload completed', { url, downloadId });
      return ok({ downloadId });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to start download';
      this.logger.error('startDownload failed', { url, error: message });
      return err({ code: ErrorCode.UNKNOWN, message });
    }
  }

  // -- DOM Interaction -------------------------------------------------------

  /** Clicks an element via the content script message bridge, or at raw x,y coordinates via CDP. */
  async click(options: ClickOptions): Promise<Result<void, ErrorResponse>> {
    // Coordinate-based click via CDP Input.dispatchMouseEvent (bypasses content script)
    if (options.x !== undefined && options.y !== undefined && !options.selector) {
      const activeTab = this.tabTracker.getActiveTab();
      if (!activeTab) {
        return err({ code: ErrorCode.TAB_NOT_FOUND, message: 'No active tab found' });
      }
      const tabId = activeTab.id;
      try {
        if (!this.cdpManager.isAttached(tabId)) {
          await this.cdpManager.attach(tabId);
        }
        const button = options.button ?? 'left';
        const clickCount = options.clickCount ?? 1;
        for (let i = 0; i < clickCount; i++) {
          await this.cdpManager.sendCommand(tabId, 'Input.dispatchMouseEvent', {
            type: 'mousePressed',
            x: options.x,
            y: options.y,
            button,
            clickCount: i + 1,
          });
          await this.cdpManager.sendCommand(tabId, 'Input.dispatchMouseEvent', {
            type: 'mouseReleased',
            x: options.x,
            y: options.y,
            button,
            clickCount: i + 1,
          });
        }
        return ok(undefined);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Coordinate click failed';
        this.logger.error('click (coordinate) failed', { error: message });
        return err({ code: ErrorCode.UNKNOWN, message });
      }
    }
    return this.sendDomCommand('click', { ...options });
  }

  /** Types text into an element via the content script message bridge. */
  async type(options: TypeOptions): Promise<Result<void, ErrorResponse>> {
    return this.sendDomCommand('type', { ...options });
  }

  /** Hovers over an element via the content script message bridge. */
  async hover(options: HoverOptions): Promise<Result<void, ErrorResponse>> {
    return this.sendDomCommand('hover', { ...options });
  }

  /** Scrolls to an element or position via the content script message bridge. */
  async scroll(options: ScrollOptions): Promise<Result<void, ErrorResponse>> {
    return this.sendDomCommand('scroll', { ...options });
  }

  /** Selects an option in a `<select>` element via the content script message bridge. */
  async select(options: SelectOptions): Promise<Result<readonly string[], ErrorResponse>> {
    const response = await this.sendDomCommandRaw('select', { ...options });

    if (!response.success) {
      return err({
        code: ErrorCode.UNKNOWN,
        message: response.error?.message ?? 'Select operation failed',
      });
    }

    const selected = Array.isArray(response.data) ? (response.data as string[]) : [];
    return ok(selected);
  }

  /** Focuses an element via the content script message bridge. */
  async focus(options: FocusOptions): Promise<Result<void, ErrorResponse>> {
    return this.sendDomCommand('focus', { ...options });
  }

  getAttribute: IBrowserAdapter['getAttribute'] = () =>
    Promise.resolve(notImplemented('getAttribute'));

  getProperty: IBrowserAdapter['getProperty'] = () =>
    Promise.resolve(notImplemented('getProperty'));

  // -- Tab Management --------------------------------------------------------

  /** Creates a new browser tab via the chrome.tabs API. */
  async createTab(options?: CreateTabOptions): Promise<Result<TabInfo, ErrorResponse>> {
    try {
      const tab = await chrome.tabs.create({
        url: options?.url,
        active: options?.active,
        windowId: options?.windowId,
      });

      const tabInfo: TabInfo = {
        tabId: tab.id ?? -1,
        url: tab.url ?? '',
        title: tab.title ?? '',
        active: tab.active,
        windowId: tab.windowId,
      };

      this.logger.debug('Tab created', { tabId: tabInfo.tabId });
      return ok(tabInfo);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to create tab';
      this.logger.error('createTab failed', { error: message });
      return err({ code: ErrorCode.UNKNOWN, message });
    }
  }

  /** Closes a tab by ID via the chrome.tabs API. */
  async closeTab(tabId: number): Promise<Result<void, ErrorResponse>> {
    try {
      await chrome.tabs.remove(tabId);
      this.logger.debug('Tab closed', { tabId });
      return ok(undefined);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to close tab';
      this.logger.error('closeTab failed', { tabId, error: message });
      return err({ code: ErrorCode.TAB_NOT_FOUND, message });
    }
  }

  /** Switches to a tab by activating it via the chrome.tabs API. */
  async switchTab(tabId: number): Promise<Result<void, ErrorResponse>> {
    try {
      await chrome.tabs.update(tabId, { active: true });
      this.logger.debug('Tab switched', { tabId });
      return ok(undefined);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to switch tab';
      this.logger.error('switchTab failed', { tabId, error: message });
      return err({ code: ErrorCode.TAB_NOT_FOUND, message });
    }
  }

  /** Lists all tracked tabs via the {@link TabTracker}. */
  listTabs(): Promise<Result<readonly TabInfo[], ErrorResponse>> {
    const tabs = this.tabTracker.getAllTabs();
    const tabInfos: TabInfo[] = tabs.map((tab) => ({
      tabId: tab.id,
      url: tab.url,
      title: tab.title,
      active: tab.active,
      windowId: tab.windowId,
    }));
    return Promise.resolve(ok(tabInfos));
  }

  /** Returns the currently active tab from the {@link TabTracker}. */
  getActiveTab(): Promise<Result<TabInfo, ErrorResponse>> {
    const tab = this.tabTracker.getActiveTab();
    if (!tab) {
      return Promise.resolve(
        err({ code: ErrorCode.TAB_NOT_FOUND, message: 'No active tab found' }),
      );
    }
    return Promise.resolve(
      ok({
        tabId: tab.id,
        url: tab.url,
        title: tab.title,
        active: tab.active,
        windowId: tab.windowId,
      }),
    );
  }

  // -- Dialog Handling -------------------------------------------------------

  /**
   * Ensures CDP Page domain events are enabled and a dialog listener
   * is registered for the given tab.
   */
  private async ensureDialogListener(tabId: number): Promise<void> {
    if (this.dialogListenerAttachedTabs.has(tabId)) {
      return;
    }

    if (!this.cdpManager.isAttached(tabId)) {
      await this.cdpManager.attach(tabId);
    }

    await this.cdpManager.sendCommand(tabId, 'Page.enable');

    this.cdpManager.onEvent<JavaScriptDialogOpeningParams>(tabId, (method, params) => {
      if (method === 'Page.javascriptDialogOpening') {
        this.currentDialog = {
          type: params.type as DialogType,
          message: params.message,
          defaultPrompt: params.defaultPrompt,
        };

        this.logger.debug('Dialog detected', {
          type: params.type,
          message: params.message,
        });

        if (this.autoDismiss) {
          this.cdpManager
            .sendCommand(tabId, 'Page.handleJavaScriptDialog', { accept: false })
            .then(() => {
              this.logger.debug('Dialog auto-dismissed', { type: params.type });
              this.currentDialog = null;
            })
            .catch((error: unknown) => {
              const msg = error instanceof Error ? error.message : String(error);
              this.logger.warn('Auto-dismiss failed', { error: msg });
            });
        }
      }
    });

    this.dialogListenerAttachedTabs.add(tabId);
  }

  /** Handles (accepts or dismisses) the current browser dialog via CDP. */
  async handleDialog(options: HandleDialogOptions): Promise<Result<void, ErrorResponse>> {
    const activeTab = this.tabTracker.getActiveTab();
    if (!activeTab) {
      return err({ code: ErrorCode.TAB_NOT_FOUND, message: 'No active tab found' });
    }

    const tabId = activeTab.id;

    try {
      await this.ensureDialogListener(tabId);

      this.autoDismiss = false;

      await this.cdpManager.sendCommand(tabId, 'Page.handleJavaScriptDialog', {
        accept: options.accept,
        promptText: options.promptText,
      });

      this.logger.debug('Dialog handled', {
        accept: options.accept,
        promptText: options.promptText,
      });

      this.currentDialog = null;
      return ok(undefined);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to handle dialog';
      this.logger.error('handleDialog failed', { error: message });
      return err({ code: ErrorCode.DIALOG_NOT_FOUND, message });
    }
  }

  /** Returns information about the currently open dialog, if any. */
  async getDialogInfo(): Promise<Result<DialogInfo | null, ErrorResponse>> {
    const activeTab = this.tabTracker.getActiveTab();
    if (!activeTab) {
      return err({ code: ErrorCode.TAB_NOT_FOUND, message: 'No active tab found' });
    }

    try {
      await this.ensureDialogListener(activeTab.id);
      return ok(this.currentDialog);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to get dialog info';
      this.logger.error('getDialogInfo failed', { error: message });
      return err({ code: ErrorCode.UNKNOWN, message });
    }
  }

  // -- Screenshot ------------------------------------------------------------

  /** Captures a viewport or element screenshot. When selector is provided, crops to element bounding box via CDP. */
  async captureScreenshot(
    options?: ScreenshotOptions,
  ): Promise<Result<ScreenshotResult, ErrorResponse>> {
    const format = options?.format ?? DEFAULT_SCREENSHOT_FORMAT;
    const quality = format === 'png' ? undefined : (options?.quality ?? DEFAULT_SCREENSHOT_QUALITY);

    if (options?.fullPage) {
      return this.captureFullPageScreenshot(options);
    }

    if (options?.selector) {
      return this.captureElementScreenshot(options.selector, format, quality);
    }

    const activeTab = this.tabTracker.getActiveTab();
    if (!activeTab) {
      return err({ code: ErrorCode.TAB_NOT_FOUND, message: 'No active tab found' });
    }

    try {
      const dataUrl = await chrome.tabs.captureVisibleTab(activeTab.windowId, {
        format: toChromeImageFormat(format),
        quality,
      });

      const base64Data = dataUrl.replace(/^data:image\/\w+;base64,/, '');
      const mimeType = toMimeType(format);

      this.logger.debug('Viewport screenshot captured', {
        format,
        tabId: activeTab.id,
      });

      return ok({
        data: base64Data,
        mimeType,
        width: 0,
        height: 0,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Screenshot capture failed';
      this.logger.error('captureScreenshot failed', { error: message });
      return err({ code: ErrorCode.UNKNOWN, message });
    }
  }

  /** Captures a screenshot of a specific element by selector using CDP clip parameter. */
  private async captureElementScreenshot(
    selector: string,
    format: string,
    quality: number | undefined,
  ): Promise<Result<ScreenshotResult, ErrorResponse>> {
    const activeTab = this.tabTracker.getActiveTab();
    if (!activeTab) {
      return err({ code: ErrorCode.TAB_NOT_FOUND, message: 'No active tab found' });
    }

    const tabId = activeTab.id;

    try {
      if (!this.cdpManager.isAttached(tabId)) {
        await this.cdpManager.attach(tabId);
      }

      const boxResult = await this.cdpManager.sendCommand<{
        result: { type: string; subtype?: string; value?: unknown };
      }>(tabId, 'Runtime.evaluate', {
        expression: `(function() {
          var el = document.querySelector(${JSON.stringify(selector)});
          if (!el) return null;
          var rect = el.getBoundingClientRect();
          return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
        })()`,
        returnByValue: true,
      });

      const box = boxResult.result.value as {
        x: number;
        y: number;
        width: number;
        height: number;
      } | null;
      if (!box) {
        return err({
          code: ErrorCode.UNKNOWN,
          message: `No element found for selector: ${selector}`,
        });
      }

      const clipX = Math.max(0, box.x);
      const clipY = Math.max(0, box.y);
      const clipWidth = box.width > 0 ? box.width : 1;
      const clipHeight = box.height > 0 ? box.height : 1;

      const cdpFormat = format === 'jpeg' ? 'jpeg' : format === 'webp' ? 'webp' : 'png';
      const cdpParams: Record<string, unknown> = {
        format: cdpFormat,
        clip: { x: clipX, y: clipY, width: clipWidth, height: clipHeight, scale: 1 },
      };
      if (quality !== undefined) {
        cdpParams.quality = quality;
      }

      const result = await this.cdpManager.sendCommand<CdpScreenshotResponse>(
        tabId,
        'Page.captureScreenshot',
        cdpParams,
      );

      const mimeType = toMimeType(format);
      this.logger.debug('Element screenshot captured', { format, tabId, selector });

      return ok({
        data: result.data,
        mimeType,
        width: Math.round(clipWidth),
        height: Math.round(clipHeight),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Element screenshot failed';
      this.logger.error('captureElementScreenshot failed', { selector, error: message });
      return err({ code: ErrorCode.UNKNOWN, message });
    }
  }

  /** Captures a full-page screenshot via CDP Page.captureScreenshot. */
  async captureFullPageScreenshot(
    options?: Omit<ScreenshotOptions, 'fullPage' | 'selector'>,
  ): Promise<Result<ScreenshotResult, ErrorResponse>> {
    const format = options?.format ?? DEFAULT_SCREENSHOT_FORMAT;
    const quality = format === 'png' ? undefined : (options?.quality ?? DEFAULT_SCREENSHOT_QUALITY);

    const activeTab = this.tabTracker.getActiveTab();
    if (!activeTab) {
      return err({ code: ErrorCode.TAB_NOT_FOUND, message: 'No active tab found' });
    }

    const tabId = activeTab.id;

    try {
      if (!this.cdpManager.isAttached(tabId)) {
        await this.cdpManager.attach(tabId);
      }

      const cdpFormat = format === 'jpeg' ? 'jpeg' : format === 'webp' ? 'webp' : 'png';

      const cdpParams: Record<string, unknown> = {
        format: cdpFormat,
        captureBeyondViewport: true,
      };
      if (quality !== undefined) {
        cdpParams.quality = quality;
      }

      const result = await this.cdpManager.sendCommand<CdpScreenshotResponse>(
        tabId,
        'Page.captureScreenshot',
        cdpParams,
      );

      const mimeType = toMimeType(format);

      this.logger.debug('Full-page screenshot captured', {
        format,
        tabId,
      });

      return ok({
        data: result.data,
        mimeType,
        width: 0,
        height: 0,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Full-page screenshot failed';
      this.logger.error('captureFullPageScreenshot failed', { error: message });
      return err({ code: ErrorCode.UNKNOWN, message });
    }
  }

  // -- Accessibility ---------------------------------------------------------

  /**
   * Retrieves the accessibility tree via CDP Accessibility.getFullAXTree,
   * falling back to DOM-walking via the content script when CDP is unavailable.
   *
   * When CDP is available, also calls DOMSnapshot.captureSnapshot to resolve
   * bounding boxes for each node (correlated via backendDOMNodeId).
   */
  async getAccessibilityTree(): Promise<Result<AccessibilityNode, ErrorResponse>> {
    const activeTab = this.tabTracker.getActiveTab();
    if (!activeTab) {
      return err({ code: ErrorCode.TAB_NOT_FOUND, message: 'No active tab found' });
    }

    const tabId = activeTab.id;

    // Strategy 1 (preferred): DOM-walking via content script.
    // This eliminates Chrome-internal pseudo-nodes (InlineTextBox, StaticText)
    // that bloat the tree without adding value for agent consumption.
    try {
      const response = await this.sendDomCommandRaw('getAccessibilityTree', {});

      if (response.success) {
        const data = response.data as { tree: AccessibilityNode; nodeCount: number } | undefined;
        if (data?.tree) {
          this.logger.debug('Accessibility tree extracted via DOM walking', {
            tabId,
            nodeCount: data.nodeCount,
          });
          return ok(data.tree);
        }
      }

      this.logger.warn('DOM walking returned empty tree, falling back to CDP', { tabId });
    } catch (domError) {
      this.logger.warn('DOM walking failed, falling back to CDP', {
        tabId,
        error: domError instanceof Error ? domError.message : String(domError),
      });
    }

    // Strategy 2 (fallback): CDP Accessibility.getFullAXTree
    try {
      if (!this.cdpManager.isAttached(tabId)) {
        await this.cdpManager.attach(tabId);
      }

      await this.cdpManager.sendCommand(tabId, 'Accessibility.enable');

      const axTree = await this.cdpManager.sendCommand<CdpAXTreeResponse>(
        tabId,
        'Accessibility.getFullAXTree',
      );

      const tree = this.buildTreeFromCdpNodes(axTree.nodes);
      this.logger.debug('Accessibility tree extracted via CDP', {
        tabId,
        nodeCount: axTree.nodes.length,
      });
      return ok(tree);
    } catch (cdpError) {
      const message =
        cdpError instanceof Error ? cdpError.message : 'Accessibility tree extraction failed';
      this.logger.error('getAccessibilityTree failed', { error: message });
      return err({ code: ErrorCode.UNKNOWN, message });
    }
  }

  /**
   * Builds an AccessibilityNode tree from flat CDP AX node array.
   *
   * CDP returns nodes as a flat list with parent-child references via childIds.
   * This method reconstructs the hierarchy. Used only as a fallback when
   * DOM-walking is unavailable.
   */
  private buildTreeFromCdpNodes(nodes: readonly CdpAXNode[]): AccessibilityNode {
    if (nodes.length === 0) {
      return { role: 'document', name: '', children: [] };
    }

    const nodeMap = new Map<string, CdpAXNode>();
    for (const node of nodes) {
      nodeMap.set(node.nodeId, node);
    }

    const convertNode = (cdpNode: CdpAXNode): AccessibilityNode => {
      const children: AccessibilityNode[] = [];
      if (cdpNode.childIds) {
        for (const childId of cdpNode.childIds) {
          const childCdp = nodeMap.get(childId);
          if (childCdp && !childCdp.ignored) {
            children.push(convertNode(childCdp));
          }
        }
      }

      const result: AccessibilityNode = {
        role: cdpNode.role?.value ?? 'none',
        name: cdpNode.name?.value ?? '',
        ...(cdpNode.value?.value ? { value: cdpNode.value.value } : {}),
        ...(cdpNode.description?.value ? { description: cdpNode.description.value } : {}),
        ...(children.length > 0 ? { children } : {}),
      };

      return result;
    };

    const rootNode = nodes[0];
    return rootNode ? convertNode(rootNode) : { role: 'document', name: '', children: [] };
  }

  // -- HTML Content ----------------------------------------------------------

  /** Retrieves the full page HTML via chrome.scripting.executeScript. */
  async getPageContent(): Promise<Result<string, ErrorResponse>> {
    const activeTab = this.tabTracker.getActiveTab();
    if (!activeTab) {
      return err({ code: ErrorCode.TAB_NOT_FOUND, message: 'No active tab found' });
    }

    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId: activeTab.id },
        func: () => document.documentElement.outerHTML,
      });

      const html = results[0]?.result;
      if (html === undefined) {
        return err({ code: ErrorCode.UNKNOWN, message: 'executeScript returned no result' });
      }

      this.logger.debug('getPageContent completed', { tabId: activeTab.id, length: html.length });
      return ok(html);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to get page content';
      this.logger.error('getPageContent failed', { error: message });
      return err({ code: ErrorCode.UNKNOWN, message });
    }
  }

  /** Retrieves the outerHTML of a specific element via chrome.scripting.executeScript. */
  async getOuterHtml(selector: string): Promise<Result<string, ErrorResponse>> {
    const activeTab = this.tabTracker.getActiveTab();
    if (!activeTab) {
      return err({ code: ErrorCode.TAB_NOT_FOUND, message: 'No active tab found' });
    }

    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId: activeTab.id },
        func: (sel: string) => {
          const el = document.querySelector(sel);
          return el ? el.outerHTML : null;
        },
        args: [selector],
      });

      const html = results[0]?.result;
      if (html === null || html === undefined) {
        return err({
          code: ErrorCode.UNKNOWN,
          message: `No element found for selector: ${selector}`,
        });
      }

      this.logger.debug('getOuterHtml completed', { tabId: activeTab.id, selector });
      return ok(html);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to get outer HTML';
      this.logger.error('getOuterHtml failed', { error: message });
      return err({ code: ErrorCode.UNKNOWN, message });
    }
  }

  /** Retrieves the innerHTML of a specific element via chrome.scripting.executeScript. */
  async getInnerHtml(selector: string): Promise<Result<string, ErrorResponse>> {
    const activeTab = this.tabTracker.getActiveTab();
    if (!activeTab) {
      return err({ code: ErrorCode.TAB_NOT_FOUND, message: 'No active tab found' });
    }

    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId: activeTab.id },
        func: (sel: string) => {
          const el = document.querySelector(sel);
          return el ? el.innerHTML : null;
        },
        args: [selector],
      });

      const html = results[0]?.result;
      if (html === null || html === undefined) {
        return err({
          code: ErrorCode.UNKNOWN,
          message: `No element found for selector: ${selector}`,
        });
      }

      this.logger.debug('getInnerHtml completed', { tabId: activeTab.id, selector });
      return ok(html);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to get inner HTML';
      this.logger.error('getInnerHtml failed', { error: message });
      return err({ code: ErrorCode.UNKNOWN, message });
    }
  }

  // -- DOM Querying ----------------------------------------------------------

  querySelector: IBrowserAdapter['querySelector'] = () =>
    Promise.resolve(notImplemented('querySelector'));

  querySelectorAll: IBrowserAdapter['querySelectorAll'] = () =>
    Promise.resolve(notImplemented('querySelectorAll'));

  /** Retrieves all attributes of an element via chrome.scripting.executeScript. */
  async getAttributes(
    selector: string,
  ): Promise<Result<Readonly<Record<string, string>>, ErrorResponse>> {
    const activeTab = this.tabTracker.getActiveTab();
    if (!activeTab) {
      return err({ code: ErrorCode.TAB_NOT_FOUND, message: 'No active tab found' });
    }

    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId: activeTab.id },
        func: (sel: string) => {
          const el = document.querySelector(sel);
          if (!el) return null;
          const attrs: Record<string, string> = {};
          for (const attr of el.attributes) {
            attrs[attr.name] = attr.value;
          }
          return attrs;
        },
        args: [selector],
      });

      const attrs = results[0]?.result;
      if (attrs === null || attrs === undefined) {
        return err({
          code: ErrorCode.UNKNOWN,
          message: `No element found for selector: ${selector}`,
        });
      }

      this.logger.debug('getAttributes completed', { tabId: activeTab.id, selector });
      return ok(attrs);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to get attributes';
      this.logger.error('getAttributes failed', { error: message });
      return err({ code: ErrorCode.UNKNOWN, message });
    }
  }

  // -- Script Execution ------------------------------------------------------

  /** Executes JavaScript in the page context via CDP Runtime.evaluate. */
  async executeScript(options: ExecuteScriptOptions): Promise<Result<unknown, ErrorResponse>> {
    const activeTab = this.tabTracker.getActiveTab();
    if (!activeTab) {
      return err({ code: ErrorCode.TAB_NOT_FOUND, message: 'No active tab found' });
    }

    const tabId = activeTab.id;
    const timeout = options.timeout ?? DEFAULT_SCRIPT_TIMEOUT;

    try {
      if (!this.cdpManager.isAttached(tabId)) {
        await this.cdpManager.attach(tabId);
      }

      await this.cdpManager.sendCommand(tabId, 'Runtime.enable');

      const serialisedArgs = JSON.stringify(options.args ?? []);
      const expression =
        `(async () => {\n` +
        `  const args = ${serialisedArgs};\n` +
        `  ${options.script}\n` +
        `})()`;

      const evaluatePromise = this.cdpManager.sendCommand<CdpEvaluateResponse>(
        tabId,
        'Runtime.evaluate',
        {
          expression,
          returnByValue: true,
          awaitPromise: true,
        },
      );

      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => {
          reject(new Error('Script execution timed out after ' + timeout + 'ms'));
        }, timeout),
      );

      const response = await Promise.race([evaluatePromise, timeoutPromise]);

      if (response.exceptionDetails) {
        const errorMessage =
          response.exceptionDetails.exception?.description ?? response.exceptionDetails.text;
        return err({
          code: ErrorCode.SCRIPT_EXECUTION_FAILED,
          message: errorMessage,
          details: response.exceptionDetails.exception?.description
            ? { stack: response.exceptionDetails.exception.description }
            : undefined,
        });
      }

      const value = response.result.value ?? null;

      if (value !== null && value !== undefined && typeof value === 'object') {
        try {
          const serialised = JSON.parse(JSON.stringify(value));
          this.logger.debug('executeScript completed', { tabId });
          return ok(serialised);
        } catch {
          this.logger.debug('executeScript completed (non-serialisable result)', { tabId });
          return ok(String(value));
        }
      }

      this.logger.debug('executeScript completed', { tabId });
      return ok(value ?? null);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Script execution failed';
      const stack = error instanceof Error ? error.stack : undefined;

      if (message.includes('timed out')) {
        return err({ code: ErrorCode.TIMEOUT, message });
      }

      this.logger.error('executeScript failed', { tabId, error: message });
      return err({
        code: ErrorCode.SCRIPT_EXECUTION_FAILED,
        message,
        details: stack ? { stack } : undefined,
      });
    }
  }

  evaluateExpression: IBrowserAdapter['evaluateExpression'] = () =>
    Promise.resolve(notImplemented('evaluateExpression'));

  // -- Custom JS File Execution (FR-034) -------------------------------------

  /** Loads and executes a JavaScript file in the page context via CDP Runtime.evaluate with fetch(). */
  async executeScriptFile(
    options: ExecuteScriptFileOptions,
  ): Promise<Result<unknown, ErrorResponse>> {
    const activeTab = this.tabTracker.getActiveTab();
    if (!activeTab) {
      return err({ code: ErrorCode.TAB_NOT_FOUND, message: 'No active tab found' });
    }

    const tabId = activeTab.id;
    const timeout = options.timeout ?? DEFAULT_SCRIPT_TIMEOUT;

    try {
      if (!this.cdpManager.isAttached(tabId)) {
        await this.cdpManager.attach(tabId);
      }

      await this.cdpManager.sendCommand(tabId, 'Runtime.enable');

      const fileUrl = JSON.stringify(options.file);
      const expression =
        `(async () => {\n` +
        `  const response = await fetch(${fileUrl});\n` +
        `  if (!response.ok) throw new Error('Failed to load script file: ' + response.status + ' ' + response.statusText + ' for ' + ${fileUrl});\n` +
        `  const scriptContent = await response.text();\n` +
        `  const result = (0, eval)(scriptContent);\n` +
        `  return result;\n` +
        `})()`;

      const evaluatePromise = this.cdpManager.sendCommand<CdpEvaluateResponse>(
        tabId,
        'Runtime.evaluate',
        {
          expression,
          returnByValue: true,
          awaitPromise: true,
        },
      );

      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => {
          reject(new Error('Script file execution timed out after ' + timeout + 'ms'));
        }, timeout),
      );

      const response = await Promise.race([evaluatePromise, timeoutPromise]);

      if (response.exceptionDetails) {
        const errorMessage =
          response.exceptionDetails.exception?.description ?? response.exceptionDetails.text;
        return err({
          code: ErrorCode.SCRIPT_EXECUTION_FAILED,
          message: errorMessage,
        });
      }

      const value = response.result.value ?? null;
      this.logger.debug('executeScriptFile completed', { tabId, file: options.file });
      return ok(value);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Script file execution failed';

      if (message.includes('timed out')) {
        return err({ code: ErrorCode.TIMEOUT, message });
      }

      this.logger.error('executeScriptFile failed', { tabId, file: options.file, error: message });
      return err({
        code: ErrorCode.SCRIPT_EXECUTION_FAILED,
        message,
      });
    }
  }

  // -- Validation Scripts (FR-035) -------------------------------------------

  /** Executes a validation script wrapped in a harness that collects assertion results. */
  async executeValidation(
    options: ExecuteValidationOptions,
  ): Promise<Result<ValidationResult, ErrorResponse>> {
    const activeTab = this.tabTracker.getActiveTab();
    if (!activeTab) {
      return err({ code: ErrorCode.TAB_NOT_FOUND, message: 'No active tab found' });
    }

    const tabId = activeTab.id;
    const timeout = options.timeout ?? DEFAULT_SCRIPT_TIMEOUT;

    try {
      if (!this.cdpManager.isAttached(tabId)) {
        await this.cdpManager.attach(tabId);
      }

      await this.cdpManager.sendCommand(tabId, 'Runtime.enable');

      const expression =
        `(async () => {\n` +
        `  const __assertions = [];\n` +
        `  function assert(name, condition, message) {\n` +
        `    __assertions.push({\n` +
        `      name: name,\n` +
        `      status: condition ? 'passed' : 'failed',\n` +
        `      message: message || (condition ? 'Passed' : 'Failed')\n` +
        `    });\n` +
        `  }\n` +
        `  function skip(name, message) {\n` +
        `    __assertions.push({ name: name, status: 'skipped', message: message || 'Skipped' });\n` +
        `  }\n` +
        `  try {\n` +
        `    ${options.script}\n` +
        `  } catch (e) {\n` +
        `    __assertions.push({ name: 'Uncaught error', status: 'failed', message: e.message || String(e) });\n` +
        `  }\n` +
        `  const passed = __assertions.filter(a => a.status === 'passed').length;\n` +
        `  const failed = __assertions.filter(a => a.status === 'failed').length;\n` +
        `  const skipped = __assertions.filter(a => a.status === 'skipped').length;\n` +
        `  return { passed, failed, skipped, assertions: __assertions };\n` +
        `})()`;

      const evaluatePromise = this.cdpManager.sendCommand<CdpEvaluateResponse>(
        tabId,
        'Runtime.evaluate',
        {
          expression,
          returnByValue: true,
          awaitPromise: true,
        },
      );

      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => {
          reject(new Error('Validation execution timed out after ' + timeout + 'ms'));
        }, timeout),
      );

      const response = await Promise.race([evaluatePromise, timeoutPromise]);

      if (response.exceptionDetails) {
        const errorMessage =
          response.exceptionDetails.exception?.description ?? response.exceptionDetails.text;
        return err({
          code: ErrorCode.SCRIPT_EXECUTION_FAILED,
          message: errorMessage,
        });
      }

      const value = response.result.value as ValidationResult;
      this.logger.debug('executeValidation completed', {
        tabId,
        passed: value.passed,
        failed: value.failed,
        skipped: value.skipped,
      });
      return ok(value);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Validation execution failed';

      if (message.includes('timed out')) {
        return err({ code: ErrorCode.TIMEOUT, message });
      }

      this.logger.error('executeValidation failed', { tabId, error: message });
      return err({
        code: ErrorCode.SCRIPT_EXECUTION_FAILED,
        message,
      });
    }
  }

  // -- Console Command -------------------------------------------------------

  /**
   * Executes a command in the page's console context via CDP Runtime.evaluate,
   * capturing console output (log/warn/error/info/debug) via Runtime.consoleAPICalled.
   *
   * Returns both the expression's return value and any console output
   * produced during evaluation, with levels distinguished.
   */
  async executeConsoleCommand(
    options: ConsoleCommandOptions,
  ): Promise<Result<unknown, ErrorResponse>> {
    const activeTab = this.tabTracker.getActiveTab();
    if (!activeTab) {
      return err({ code: ErrorCode.TAB_NOT_FOUND, message: 'No active tab found' });
    }

    const tabId = activeTab.id;
    const timeout = options.timeout ?? DEFAULT_SCRIPT_TIMEOUT;

    try {
      if (!this.cdpManager.isAttached(tabId)) {
        await this.cdpManager.attach(tabId);
      }

      await this.cdpManager.sendCommand(tabId, 'Runtime.enable');

      const consoleEntries: CapturedConsoleEntry[] = [];

      const consoleListener: CDPEventListener = (method, params) => {
        if (method === 'Runtime.consoleAPICalled') {
          const consoleParams = params as unknown as ConsoleAPICalledParams;
          const level = this.mapConsoleType(consoleParams.type);
          const args = consoleParams.args.map((arg) =>
            arg.value !== undefined ? arg.value : (arg.description ?? `[${arg.type}]`),
          );
          consoleEntries.push({
            level,
            args,
            timestamp: consoleParams.timestamp,
          });
        }
      };

      this.cdpManager.onEvent(tabId, consoleListener);

      try {
        const evaluatePromise = this.cdpManager.sendCommand<CdpEvaluateResponse>(
          tabId,
          'Runtime.evaluate',
          {
            expression: options.command,
            includeCommandLineAPI: true,
            returnByValue: true,
            awaitPromise: true,
          },
        );

        const timeoutPromise = new Promise<never>((_, reject) =>
          setTimeout(() => {
            reject(new Error('Console command timed out after ' + timeout + 'ms'));
          }, timeout),
        );

        const response = await Promise.race([evaluatePromise, timeoutPromise]);

        if (response.exceptionDetails) {
          const errorMessage =
            response.exceptionDetails.exception?.description ?? response.exceptionDetails.text;
          return err({
            code: ErrorCode.SCRIPT_EXECUTION_FAILED,
            message: errorMessage,
          });
        }

        const returnValue = response.result.value ?? null;

        this.logger.debug('executeConsoleCommand completed', {
          tabId,
          consoleEntries: consoleEntries.length,
        });

        return ok({
          returnValue,
          consoleOutput: consoleEntries,
        });
      } finally {
        this.cdpManager.offEvent(tabId, consoleListener);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Console command execution failed';

      if (message.includes('timed out')) {
        return err({ code: ErrorCode.TIMEOUT, message });
      }

      this.logger.error('executeConsoleCommand failed', { tabId, error: message });
      return err({
        code: ErrorCode.SCRIPT_EXECUTION_FAILED,
        message,
      });
    }
  }

  /** Maps CDP console API type strings to normalised level names. */
  private mapConsoleType(type: string): CapturedConsoleEntry['level'] {
    switch (type) {
      case 'warning':
        return 'warn';
      case 'error':
        return 'error';
      case 'info':
        return 'info';
      case 'debug':
        return 'debug';
      default:
        return 'log';
    }
  }

  // -- Content Script Injection (stub) ---------------------------------------

  injectScript: IBrowserAdapter['injectScript'] = () =>
    Promise.resolve(notImplemented('injectScript'));

  removeScript: IBrowserAdapter['removeScript'] = () =>
    Promise.resolve(notImplemented('removeScript'));

  // -- CDP (stub) ------------------------------------------------------------

  /** Sends a raw CDP command to the specified tab via the CDP manager. */
  async sendCdpCommand(options: CdpCommandOptions): Promise<Result<unknown, ErrorResponse>> {
    const tabId = options.tabId ?? this.tabTracker.getActiveTab()?.id;
    if (tabId === undefined) {
      return err({ code: ErrorCode.TAB_NOT_FOUND, message: 'No active tab found' });
    }

    try {
      if (!this.cdpManager.isAttached(tabId)) {
        await this.cdpManager.attach(tabId);
      }

      const result = await this.cdpManager.sendCommand(tabId, options.method, options.params);

      this.logger.debug('sendCdpCommand completed', { tabId, method: options.method });
      return ok(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'CDP command failed';
      this.logger.error('sendCdpCommand failed', { tabId, method: options.method, error: message });
      return err({ code: ErrorCode.UNKNOWN, message });
    }
  }

  attachDebugger: IBrowserAdapter['attachDebugger'] = () =>
    Promise.resolve(notImplemented('attachDebugger'));

  detachDebugger: IBrowserAdapter['detachDebugger'] = () =>
    Promise.resolve(notImplemented('detachDebugger'));

  // -- Live HTML Modification (stub) -----------------------------------------

  setOuterHtml: IBrowserAdapter['setOuterHtml'] = () =>
    Promise.resolve(notImplemented('setOuterHtml'));

  setInnerHtml: IBrowserAdapter['setInnerHtml'] = () =>
    Promise.resolve(notImplemented('setInnerHtml'));

  insertAdjacentHtml: IBrowserAdapter['insertAdjacentHtml'] = () =>
    Promise.resolve(notImplemented('insertAdjacentHtml'));

  // -- Live CSS Modification (stub) ------------------------------------------

  addStyleSheet: IBrowserAdapter['addStyleSheet'] = () =>
    Promise.resolve(notImplemented('addStyleSheet'));

  modifyStyle: IBrowserAdapter['modifyStyle'] = () =>
    Promise.resolve(notImplemented('modifyStyle'));

  getComputedStyle: IBrowserAdapter['getComputedStyle'] = () =>
    Promise.resolve(notImplemented('getComputedStyle'));

  // -- Cookies ---------------------------------------------------------------

  /** Retrieves cookies matching the specified options via chrome.cookies API. */
  async getCookies(options?: {
    url?: string;
    domain?: string;
    name?: string;
  }): Promise<Result<readonly import('@agentic-browser/shared').CookieData[], ErrorResponse>> {
    try {
      const query: chrome.cookies.GetAllDetails = {};
      if (options?.url) query.url = options.url;
      if (options?.domain) query.domain = options.domain;
      if (options?.name) query.name = options.name;

      const cookies = await chrome.cookies.getAll(query);

      const mapped = cookies.map((c) => ({
        name: c.name,
        value: c.value,
        domain: c.domain,
        path: c.path,
        secure: c.secure,
        httpOnly: c.httpOnly,
        sameSite:
          c.sameSite === 'strict'
            ? ('strict' as const)
            : c.sameSite === 'lax'
              ? ('lax' as const)
              : ('none' as const),
        expirationDate: c.expirationDate,
      }));

      this.logger.debug('getCookies completed', { count: mapped.length });
      return ok(mapped);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to get cookies';
      this.logger.error('getCookies failed', { error: message });
      return err({ code: ErrorCode.UNKNOWN, message });
    }
  }

  /** Sets a cookie via chrome.cookies API. */
  async setCookie(
    cookie: import('@agentic-browser/shared').CookieData,
  ): Promise<Result<void, ErrorResponse>> {
    try {
      const url = cookie.domain
        ? `http${cookie.secure ? 's' : ''}://${cookie.domain.replace(/^\./, '')}${cookie.path ?? '/'}`
        : undefined;

      await chrome.cookies.set({
        url: url ?? '',
        name: cookie.name,
        value: cookie.value,
        domain: cookie.domain,
        path: cookie.path,
        secure: cookie.secure,
        httpOnly: cookie.httpOnly,
        sameSite:
          cookie.sameSite === 'strict'
            ? 'strict'
            : cookie.sameSite === 'lax'
              ? 'lax'
              : 'no_restriction',
        expirationDate: cookie.expirationDate,
      });

      this.logger.debug('setCookie completed', { name: cookie.name });
      return ok(undefined);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to set cookie';
      this.logger.error('setCookie failed', { error: message });
      return err({ code: ErrorCode.UNKNOWN, message });
    }
  }

  /** Deletes a cookie by URL and name via chrome.cookies API. */
  async deleteCookie(url: string, name: string): Promise<Result<void, ErrorResponse>> {
    try {
      await chrome.cookies.remove({ url, name });
      this.logger.debug('deleteCookie completed', { url, name });
      return ok(undefined);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to delete cookie';
      this.logger.error('deleteCookie failed', { error: message });
      return err({ code: ErrorCode.UNKNOWN, message });
    }
  }

  // -- Storage ---------------------------------------------------------------

  /** Gets a storage item via chrome.scripting.executeScript. */
  async getStorage(
    tabId: number,
    storageType: 'local' | 'session',
    key: string,
  ): Promise<Result<{ key: string; value: string | null }, ErrorResponse>> {
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        func: (type: string, k: string) => {
          const storage = type === 'session' ? sessionStorage : localStorage;
          return { key: k, value: storage.getItem(k) };
        },
        args: [storageType, key],
      });

      const data = results[0]?.result as { key: string; value: string | null } | undefined;
      if (!data) {
        return err({ code: ErrorCode.UNKNOWN, message: 'executeScript returned no result' });
      }

      this.logger.debug('getStorage completed', { tabId, storageType, key });
      return ok(data);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to get storage';
      this.logger.error('getStorage failed', { error: message });
      return err({ code: ErrorCode.UNKNOWN, message });
    }
  }

  /** Sets a storage item via chrome.scripting.executeScript. */
  async setStorage(
    tabId: number,
    storageType: 'local' | 'session',
    key: string,
    value: string,
  ): Promise<Result<void, ErrorResponse>> {
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        func: (type: string, k: string, v: string) => {
          const storage = type === 'session' ? sessionStorage : localStorage;
          storage.setItem(k, v);
        },
        args: [storageType, key, value],
      });

      this.logger.debug('setStorage completed', { tabId, storageType, key });
      return ok(undefined);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to set storage';
      this.logger.error('setStorage failed', { error: message });
      return err({ code: ErrorCode.UNKNOWN, message });
    }
  }

  /** Clears all storage types for the active tab via chrome.scripting.executeScript. */
  async clearStorage(tabId: number): Promise<Result<void, ErrorResponse>> {
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
          localStorage.clear();
          sessionStorage.clear();
        },
      });

      this.logger.debug('clearStorage completed', { tabId });
      return ok(undefined);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to clear storage';
      this.logger.error('clearStorage failed', { error: message });
      return err({ code: ErrorCode.UNKNOWN, message });
    }
  }

  // -- Wait / Polling (stub) -------------------------------------------------

  waitForSelector: IBrowserAdapter['waitForSelector'] = () =>
    Promise.resolve(notImplemented('waitForSelector'));

  waitForNavigation: IBrowserAdapter['waitForNavigation'] = () =>
    Promise.resolve(notImplemented('waitForNavigation'));

  waitForCondition: IBrowserAdapter['waitForCondition'] = () =>
    Promise.resolve(notImplemented('waitForCondition'));

  // -- Multi-Step Execution (stub) -------------------------------------------

  executeSteps: IBrowserAdapter['executeSteps'] = () =>
    Promise.resolve(notImplemented('executeSteps'));

  // -- Bookmarks (FR-012) ----------------------------------------------------

  /** Lists bookmarks, optionally filtered by parent folder ID. */
  async listBookmarks(
    parentId?: string,
  ): Promise<Result<readonly import('@agentic-browser/shared').BookmarkNode[], ErrorResponse>> {
    try {
      const nodes = parentId
        ? await chrome.bookmarks.getChildren(parentId)
        : await chrome.bookmarks.getTree();

      const mapped = this.mapBookmarkNodes(parentId ? nodes : nodes);
      this.logger.debug('listBookmarks completed', { parentId, count: mapped.length });
      return ok(mapped);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to list bookmarks';
      this.logger.error('listBookmarks failed', { parentId, error: message });
      return err({ code: ErrorCode.UNKNOWN, message });
    }
  }

  /** Creates a new bookmark or bookmark folder. */
  async createBookmark(
    title: string,
    url?: string,
    parentId?: string,
  ): Promise<Result<import('@agentic-browser/shared').BookmarkNode, ErrorResponse>> {
    try {
      const node = await chrome.bookmarks.create({ title, url, parentId });
      const mapped: import('@agentic-browser/shared').BookmarkNode = {
        id: node.id,
        parentId: node.parentId,
        title: node.title,
        url: node.url,
        dateAdded: node.dateAdded,
      };
      this.logger.debug('createBookmark completed', { id: node.id, title });
      return ok(mapped);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to create bookmark';
      this.logger.error('createBookmark failed', { title, error: message });
      return err({ code: ErrorCode.UNKNOWN, message });
    }
  }

  /** Searches bookmarks by query string. */
  async searchBookmarks(
    query: string,
  ): Promise<Result<readonly import('@agentic-browser/shared').BookmarkNode[], ErrorResponse>> {
    try {
      const nodes = await chrome.bookmarks.search(query);
      const mapped = this.mapBookmarkNodes(nodes);
      this.logger.debug('searchBookmarks completed', { query, count: mapped.length });
      return ok(mapped);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to search bookmarks';
      this.logger.error('searchBookmarks failed', { query, error: message });
      return err({ code: ErrorCode.UNKNOWN, message });
    }
  }

  /** Maps chrome.bookmarks.BookmarkTreeNode array to BookmarkNode array. */
  private mapBookmarkNodes(
    nodes: chrome.bookmarks.BookmarkTreeNode[],
  ): import('@agentic-browser/shared').BookmarkNode[] {
    return nodes.map((n) => ({
      id: n.id,
      parentId: n.parentId,
      title: n.title,
      url: n.url,
      dateAdded: n.dateAdded,
      ...(n.children ? { children: this.mapBookmarkNodes(n.children) } : {}),
    }));
  }

  // -- Browser History (FR-012) ----------------------------------------------

  /** Searches browser history by text query. */
  async searchHistory(
    text: string,
    startTime?: number,
    endTime?: number,
    maxResults?: number,
  ): Promise<Result<readonly import('@agentic-browser/shared').HistoryEntry[], ErrorResponse>> {
    try {
      const items = await chrome.history.search({
        text,
        startTime,
        endTime,
        maxResults: maxResults ?? 100,
      });

      const mapped = items.map((item) => ({
        id: item.id,
        url: item.url ?? '',
        title: item.title ?? '',
        lastVisitTime: item.lastVisitTime,
        visitCount: item.visitCount,
      }));

      this.logger.debug('searchHistory completed', { text, count: mapped.length });
      return ok(mapped);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to search history';
      this.logger.error('searchHistory failed', { text, error: message });
      return err({ code: ErrorCode.UNKNOWN, message });
    }
  }

  /** Retrieves recent browser history entries. */
  async getHistoryEntries(
    maxResults?: number,
  ): Promise<Result<readonly import('@agentic-browser/shared').HistoryEntry[], ErrorResponse>> {
    try {
      const items = await chrome.history.search({
        text: '',
        maxResults: maxResults ?? 100,
      });

      const mapped = items.map((item) => ({
        id: item.id,
        url: item.url ?? '',
        title: item.title ?? '',
        lastVisitTime: item.lastVisitTime,
        visitCount: item.visitCount,
      }));

      this.logger.debug('getHistoryEntries completed', { count: mapped.length });
      return ok(mapped);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to get history entries';
      this.logger.error('getHistoryEntries failed', { error: message });
      return err({ code: ErrorCode.UNKNOWN, message });
    }
  }

  // -- Downloads (FR-012) ----------------------------------------------------

  /** Retrieves download items, optionally filtered. */
  async getDownloadItems(
    query?: string,
    state?: string,
    limit?: number,
  ): Promise<Result<readonly import('@agentic-browser/shared').DownloadItem[], ErrorResponse>> {
    try {
      const searchQuery: chrome.downloads.DownloadQuery = {};
      if (query) searchQuery.query = [query];
      if (state) searchQuery.state = state as chrome.downloads.DownloadState;
      if (limit) searchQuery.limit = limit;

      const items = await chrome.downloads.search(searchQuery);
      const mapped = items.map((item) => ({
        id: item.id,
        url: item.url,
        filename: item.filename,
        state: item.state,
        bytesReceived: item.bytesReceived,
        totalBytes: item.totalBytes,
        startTime: item.startTime,
        mime: item.mime,
      }));

      this.logger.debug('getDownloadItems completed', { count: mapped.length });
      return ok(mapped);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to get download items';
      this.logger.error('getDownloadItems failed', { error: message });
      return err({ code: ErrorCode.UNKNOWN, message });
    }
  }

  /** Monitors active downloads by returning in-progress items. */
  async monitorDownloads(): Promise<
    Result<readonly import('@agentic-browser/shared').DownloadItem[], ErrorResponse>
  > {
    try {
      const items = await chrome.downloads.search({
        state: 'in_progress' as chrome.downloads.DownloadState,
      });
      const mapped = items.map((item) => ({
        id: item.id,
        url: item.url,
        filename: item.filename,
        state: item.state,
        bytesReceived: item.bytesReceived,
        totalBytes: item.totalBytes,
        startTime: item.startTime,
        mime: item.mime,
      }));

      this.logger.debug('monitorDownloads completed', { count: mapped.length });
      return ok(mapped);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to monitor downloads';
      this.logger.error('monitorDownloads failed', { error: message });
      return err({ code: ErrorCode.UNKNOWN, message });
    }
  }

  // -- Private helpers -------------------------------------------------------

  /**
   * Sends a DOM command to the content script via chrome.tabs.sendMessage.
   *
   * Falls back to chrome.scripting.executeScript if sendMessage fails
   * (e.g. content script not injected).
   */
  private async sendDomCommandRaw(
    command: string,
    params: Record<string, unknown>,
  ): Promise<CommandResponse> {
    const activeTab = this.tabTracker.getActiveTab();
    if (!activeTab) {
      return {
        id: '',
        success: false,
        error: { code: ErrorCode.TAB_NOT_FOUND, message: 'No active tab found' },
      };
    }

    const tabId = activeTab.id;
    const request: CommandRequest = {
      id: crypto.randomUUID(),
      command: command as CommandRequest['command'],
      params,
      timestamp: Date.now(),
    };

    try {
      const response = await chrome.tabs.sendMessage(tabId, request);
      this.logger.debug('DOM command response via message bridge', {
        command,
        tabId,
        success: response.success,
      });
      return response;
    } catch (messageBridgeError) {
      this.logger.warn('Message bridge failed, falling back to executeScript', {
        command,
        tabId,
        error: String(messageBridgeError),
      });
      return this.sendDomCommandViaScript(tabId, request);
    }
  }

  /**
   * Fallback: executes the DOM command via chrome.scripting.executeScript
   * when the message bridge is unavailable.
   */
  private async sendDomCommandViaScript(
    tabId: number,
    request: CommandRequest,
  ): Promise<CommandResponse> {
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        func: (req: CommandRequest) => {
          const event = new CustomEvent('agentic-browser-command', { detail: req });
          document.dispatchEvent(event);
          return { id: req.id, success: true } as CommandResponse;
        },
        args: [request],
      });

      const result = results[0]?.result;
      if (result) {
        this.logger.debug('DOM command response via executeScript', {
          command: request.command,
          tabId,
          success: result.success,
        });
        return result;
      }

      return {
        id: request.id,
        success: false,
        error: { code: ErrorCode.UNKNOWN, message: 'executeScript returned no result' },
      };
    } catch (scriptError) {
      const message = scriptError instanceof Error ? scriptError.message : String(scriptError);
      this.logger.error('executeScript fallback failed', {
        command: request.command,
        tabId,
        error: message,
      });
      return {
        id: request.id,
        success: false,
        error: { code: ErrorCode.UNKNOWN, message },
      };
    }
  }

  /**
   * Sends a DOM command and returns a Result<void>.
   *
   * Wraps {@link sendDomCommandRaw} converting the CommandResponse
   * into the standard Result type.
   */
  private async sendDomCommand(
    command: string,
    params: Record<string, unknown>,
  ): Promise<Result<void, ErrorResponse>> {
    const response = await this.sendDomCommandRaw(command, params);

    if (!response.success) {
      return err({
        code: ErrorCode.UNKNOWN,
        message: response.error?.message ?? `${command} failed`,
      });
    }

    return ok(undefined);
  }
}

export { ChromeAdapter };
