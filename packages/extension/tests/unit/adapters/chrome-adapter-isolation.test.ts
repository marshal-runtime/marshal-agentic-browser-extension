import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CDPManager } from '../../../src/infrastructure/cdp-manager.js';
import type { Logger } from '../../../src/infrastructure/logger.js';
import type { TabTracker } from '../../../src/infrastructure/tab-tracker.js';
import { ChromeAdapter } from '../../../src/adapters/chrome-adapter.js';

const isAllowedIncognitoAccess = vi.fn();
const createWindow = vi.fn();
const getAllWindows = vi.fn();
const removeWindow = vi.fn();
const updateWindow = vi.fn();
const addWindowRemovedListener = vi.fn();
const removeWindowRemovedListener = vi.fn();
const queryTabs = vi.fn();
const getTab = vi.fn();
const updateTab = vi.fn();

vi.stubGlobal('chrome', {
  extension: {
    isAllowedIncognitoAccess,
  },
  windows: {
    create: createWindow,
    getAll: getAllWindows,
    remove: removeWindow,
    update: updateWindow,
    onRemoved: {
      addListener: addWindowRemovedListener,
      removeListener: removeWindowRemovedListener,
    },
  },
  tabs: {
    query: queryTabs,
    get: getTab,
    update: updateTab,
  },
});

function createAdapter(): ChromeAdapter {
  const tabTracker = {} as TabTracker;
  const cdpManager = {} as CDPManager;
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as Logger;
  return new ChromeAdapter(tabTracker, cdpManager, logger);
}

describe('ChromeAdapter isolated browser contexts', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    isAllowedIncognitoAccess.mockImplementation((callback: (allowed: boolean) => void) => {
      callback(true);
    });
    createWindow.mockResolvedValue({ id: 21, incognito: true });
    getAllWindows.mockResolvedValue([]);
    queryTabs.mockResolvedValue([
      {
        id: 101,
        windowId: 21,
        incognito: true,
        active: true,
        url: 'about:blank',
        title: '',
      },
    ]);
    getTab.mockResolvedValue({
      id: 101,
      windowId: 21,
      incognito: true,
      active: true,
    });
    updateTab.mockResolvedValue(undefined);
    updateWindow.mockResolvedValue(undefined);
    removeWindow.mockResolvedValue(undefined);
  });

  it('creates, verifies, activates, and closes an owned incognito window', async () => {
    const adapter = createAdapter();
    expect(adapter.isolationCapabilities).toEqual({
      resource: 'incognito-profile',
      concurrentContexts: false,
      cookieIsolation: true,
      webStorageIsolation: true,
    });

    const created = await adapter.createIsolatedBrowserContext('browser-a');

    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.value).toMatchObject({
      browserContextId: 'chrome-incognito',
      windowId: 21,
      initialTab: { tabId: 101, windowId: 21 },
    });
    expect(createWindow).toHaveBeenCalledWith(
      expect.objectContaining({ incognito: true, url: 'about:blank' }),
    );
    await expect(
      adapter.isTabInIsolatedBrowserContext(created.value.browserContextId, 101),
    ).resolves.toEqual({ ok: true, value: true });
    await expect(
      adapter.activateIsolatedBrowserTab(created.value.browserContextId, 101),
    ).resolves.toEqual({ ok: true, value: undefined });
    expect(updateTab).toHaveBeenCalledWith(101, { active: true });
    expect(updateWindow).toHaveBeenCalledWith(21, { focused: true });

    await expect(
      adapter.closeIsolatedBrowserContext(created.value.browserContextId),
    ).resolves.toEqual({ ok: true, value: undefined });
    expect(removeWindow).toHaveBeenCalledWith(21);
  });

  it('fails a second concurrent local session instead of sharing incognito storage', async () => {
    const adapter = createAdapter();
    expect((await adapter.createIsolatedBrowserContext('browser-a')).ok).toBe(true);

    const second = await adapter.createIsolatedBrowserContext('browser-b');

    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.error.message).toContain('one shared incognito storage context');
    }
    expect(createWindow).toHaveBeenCalledTimes(1);
  });

  it('allows cleanup and reallocation after the owned window is closed externally', async () => {
    const adapter = createAdapter();
    const created = await adapter.createIsolatedBrowserContext('browser-a');
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const onRemoved = addWindowRemovedListener.mock.calls[0]?.[0] as
      | ((windowId: number) => void)
      | undefined;
    expect(onRemoved).toBeDefined();

    onRemoved?.(created.value.windowId);

    await expect(
      adapter.closeIsolatedBrowserContext(created.value.browserContextId),
    ).resolves.toEqual({ ok: true, value: undefined });
    expect(removeWindow).not.toHaveBeenCalled();
    await expect(adapter.createIsolatedBrowserContext('browser-b')).resolves.toMatchObject({
      ok: true,
    });
  });

  it('removes the external-window listener when disconnected', async () => {
    const adapter = createAdapter();
    await adapter.createIsolatedBrowserContext('browser-a');
    const onRemoved = addWindowRemovedListener.mock.calls[0]?.[0];

    await adapter.disconnect();

    expect(removeWindowRemovedListener).toHaveBeenCalledWith(onRemoved);
  });

  it('fails explicitly when extension incognito access is disabled', async () => {
    isAllowedIncognitoAccess.mockImplementation((callback: (allowed: boolean) => void) => {
      callback(false);
    });
    const adapter = createAdapter();

    const result = await adapter.createIsolatedBrowserContext('browser-a');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain('Allow in Incognito');
    }
    expect(createWindow).not.toHaveBeenCalled();
  });

  it('refuses to share storage with an existing incognito window', async () => {
    getAllWindows.mockResolvedValue([{ id: 7, incognito: true }]);
    const adapter = createAdapter();

    const result = await adapter.createIsolatedBrowserContext('browser-a');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain('Close existing incognito windows');
    }
    expect(createWindow).not.toHaveBeenCalled();
  });
});
