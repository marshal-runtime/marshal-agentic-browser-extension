export interface SafariTab {
  readonly id?: number;
  readonly url?: string;
  readonly windowId?: number;
}

export interface SafariNativePort {
  readonly onMessage: { addListener(listener: (message: unknown) => void): void };
  readonly onDisconnect: { addListener(listener: () => void): void };
  postMessage(message: unknown): void;
}

export interface SafariBrowserApi {
  readonly runtime: {
    readonly id: string;
    connectNative(applicationId: string): SafariNativePort;
    onMessage: {
      addListener(
        listener: (
          message: unknown,
          sender: unknown,
          sendResponse: (response: unknown) => void,
        ) => boolean | undefined,
      ): void;
    };
  };
  readonly tabs: {
    query(query: { active: boolean; lastFocusedWindow: boolean }): Promise<SafariTab[]>;
    sendMessage(tabId: number, message: unknown): Promise<unknown>;
  };
  readonly storage: {
    readonly local: {
      get(keys?: string[]): Promise<Record<string, unknown>>;
      set(items: Record<string, unknown>): Promise<void>;
    };
  };
}

export function getSafariBrowserApi(): SafariBrowserApi {
  const globals = globalThis as typeof globalThis & { browser?: SafariBrowserApi };
  const browserApi = globals.browser;
  if (browserApi) return browserApi;
  throw new Error('Safari browser extension API is unavailable');
}
