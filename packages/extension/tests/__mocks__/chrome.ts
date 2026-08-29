import { vi } from 'vitest';

function createStorageMock() {
  let store: Record<string, unknown> = {};

  return {
    get: vi.fn((keys: string | string[] | null) => {
      if (keys === null) return Promise.resolve({ ...store });
      const requested = Array.isArray(keys) ? keys : [keys];
      const result: Record<string, unknown> = {};
      for (const key of requested) {
        if (key in store) result[key] = store[key];
      }
      return Promise.resolve(result);
    }),
    set: vi.fn((items: Record<string, unknown>) => {
      Object.assign(store, items);
      return Promise.resolve();
    }),
    remove: vi.fn((keys: string | string[]) => {
      const toRemove = Array.isArray(keys) ? keys : [keys];
      for (const key of toRemove) {
        delete store[key];
      }
      return Promise.resolve();
    }),
    clear: vi.fn(() => {
      store = {};
      return Promise.resolve();
    }),
    _getStore: () => store,
    _reset: () => {
      store = {};
    },
  };
}

function createEventMock() {
  return {
    addListener: vi.fn(),
    removeListener: vi.fn(),
    hasListener: vi.fn().mockReturnValue(false),
    hasListeners: vi.fn().mockReturnValue(false),
  };
}

export const chrome = {
  runtime: {
    sendMessage: vi.fn().mockResolvedValue(undefined),
    onMessage: createEventMock(),
    onInstalled: createEventMock(),
    onStartup: createEventMock(),
    getManifest: vi.fn().mockReturnValue({
      manifest_version: 3,
      name: 'Agentic Browser',
      version: '0.1.0',
    }),
    getURL: vi.fn((path: string) => `chrome-extension://mock-id/${path}`),
    id: 'mock-extension-id',
    lastError: null as chrome.runtime.LastError | null,
    connect: vi.fn().mockReturnValue({
      onMessage: createEventMock(),
      onDisconnect: createEventMock(),
      postMessage: vi.fn(),
      disconnect: vi.fn(),
    }),
  },

  storage: {
    local: createStorageMock(),
    session: createStorageMock(),
    onChanged: createEventMock(),
  },

  tabs: {
    query: vi.fn().mockResolvedValue([]),
    get: vi.fn().mockResolvedValue({ id: 1, url: 'about:blank', active: true }),
    update: vi.fn().mockResolvedValue({ id: 1, url: 'about:blank', active: true }),
    create: vi.fn().mockResolvedValue({ id: 2, url: 'about:blank', active: true }),
    remove: vi.fn().mockResolvedValue(undefined),
    onCreated: createEventMock(),
    onUpdated: createEventMock(),
    onRemoved: createEventMock(),
    onActivated: createEventMock(),
  },

  debugger: {
    attach: vi.fn(
      (_target: unknown, _version: string, cb?: () => void) => cb?.(),
    ),
    detach: vi.fn((_target: unknown, cb?: () => void) => cb?.()),
    sendCommand: vi.fn(
      (_target: unknown, _method: string, _params?: unknown, cb?: (result: unknown) => void) =>
        cb?.({}),
    ),
    onDetach: createEventMock(),
    onEvent: createEventMock(),
  },

  scripting: {
    executeScript: vi.fn().mockResolvedValue([{ result: undefined }]),
    insertCSS: vi.fn().mockResolvedValue(undefined),
    removeCSS: vi.fn().mockResolvedValue(undefined),
  },
};

/** Reset all mock function call history without clearing implementations. */
export function resetChromeMocks(): void {
  const resetObj = (obj: Record<string, unknown>) => {
    for (const value of Object.values(obj)) {
      if (typeof value === 'function' && 'mockClear' in value) {
        (value as ReturnType<typeof vi.fn>).mockClear();
      } else if (value && typeof value === 'object' && !Array.isArray(value)) {
        resetObj(value as Record<string, unknown>);
      }
    }
  };
  resetObj(chrome);
  chrome.storage.local._reset();
  chrome.storage.session._reset();
  chrome.runtime.lastError = null;
}

export default chrome;
