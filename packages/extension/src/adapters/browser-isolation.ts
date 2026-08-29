import type { CreateTabOptions, ErrorResponse, Result, TabInfo } from '@agentic-browser/shared';

export interface BrowserIsolationCapabilities {
  readonly resource: 'incognito-profile' | 'cdp-browser-context';
  readonly concurrentContexts: boolean;
  readonly cookieIsolation: boolean;
  readonly webStorageIsolation: boolean;
}

export interface IsolatedBrowserContext {
  readonly browserContextId: string;
  readonly windowId: number;
  readonly initialTab: TabInfo;
}

export interface BrowserIsolationAdapter {
  readonly isolationCapabilities: BrowserIsolationCapabilities;
  createIsolatedBrowserContext(
    browserSessionId: string,
  ): Promise<Result<IsolatedBrowserContext, ErrorResponse>>;
  createIsolatedBrowserTab(
    browserContextId: string,
    options?: CreateTabOptions,
  ): Promise<Result<TabInfo, ErrorResponse>>;
  closeIsolatedBrowserContext(browserContextId: string): Promise<Result<void, ErrorResponse>>;
  isTabInIsolatedBrowserContext(
    browserContextId: string,
    tabId: number,
  ): Promise<Result<boolean, ErrorResponse>>;
  activateIsolatedBrowserTab(
    browserContextId: string,
    tabId: number,
  ): Promise<Result<void, ErrorResponse>>;
}

export function isBrowserIsolationAdapter(adapter: object): adapter is BrowserIsolationAdapter {
  const candidate = adapter as Partial<BrowserIsolationAdapter>;
  return (
    candidate.isolationCapabilities !== undefined &&
    typeof candidate.createIsolatedBrowserContext === 'function' &&
    typeof candidate.createIsolatedBrowserTab === 'function' &&
    typeof candidate.closeIsolatedBrowserContext === 'function' &&
    typeof candidate.isTabInIsolatedBrowserContext === 'function' &&
    typeof candidate.activateIsolatedBrowserTab === 'function'
  );
}
