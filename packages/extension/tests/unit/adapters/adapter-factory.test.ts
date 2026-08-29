import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  AdapterManager,
  parseBrowserBackendConfiguration,
  readBrowserBackendConfiguration,
} from '../../../src/adapters/adapter-factory.js';
import type { Logger } from '../../../src/infrastructure/logger.js';
import type { TabTracker } from '../../../src/infrastructure/tab-tracker.js';
import type { CDPManager } from '../../../src/infrastructure/cdp-manager.js';
import type { IBrowserAdapter } from '@agentic-browser/shared';

function createMockLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as unknown as Logger;
}

function createMockTabTracker(): TabTracker {
  return {
    getActiveTabId: vi.fn().mockReturnValue(1),
    setActiveTabId: vi.fn(),
    getAllTrackedTabs: vi.fn().mockReturnValue([]),
  } as unknown as TabTracker;
}

function createMockCDPManager(): CDPManager {
  return {
    attach: vi.fn(),
    detach: vi.fn(),
    sendCommand: vi.fn(),
    isAttached: vi.fn().mockReturnValue(false),
  } as unknown as CDPManager;
}

describe('AdapterManager', () => {
  let manager: AdapterManager;
  let logger: Logger;
  let tabTracker: TabTracker;
  let cdpManager: CDPManager;

  beforeEach(() => {
    logger = createMockLogger();
    tabTracker = createMockTabTracker();
    cdpManager = createMockCDPManager();
    manager = new AdapterManager(tabTracker, cdpManager, logger);
  });

  describe('parseBrowserBackendConfiguration', () => {
    it('defaults to the fail-closed local backend only when no selection exists', () => {
      expect(parseBrowserBackendConfiguration(undefined)).toEqual({ type: 'local' });
    });

    describe('readBrowserBackendConfiguration', () => {
      it('gives managed policy precedence over local configuration', async () => {
        await expect(
          readBrowserBackendConfiguration({
            local: {
              get: vi.fn().mockResolvedValue({ browserBackend: { type: 'local' } }),
            },
            managed: {
              get: vi.fn().mockResolvedValue({
                browserBackend: {
                  type: 'remote',
                  wsUrl: 'wss://browser.example.test/devtools/browser/managed',
                },
              }),
            },
          }),
        ).resolves.toEqual({
          type: 'remote',
          wsUrl: 'wss://browser.example.test/devtools/browser/managed',
          bearerToken: undefined,
          timeout: undefined,
        });
      });

      it('fails closed when managed policy cannot be read', async () => {
        const readFailure = new Error('managed storage unavailable');
        await expect(
          readBrowserBackendConfiguration({
            local: {
              get: vi.fn().mockResolvedValue({ browserBackend: { type: 'local' } }),
            },
            managed: {
              get: vi.fn().mockRejectedValue(readFailure),
            },
          }),
        ).rejects.toBe(readFailure);
      });
    });

    it('accepts an explicit remote browser-context backend', () => {
      expect(
        parseBrowserBackendConfiguration({
          type: 'remote',
          wsUrl: 'wss://browser.example.test/devtools/browser/id',
          bearerToken: 'secret',
          timeout: 5000,
        }),
      ).toEqual({
        type: 'remote',
        wsUrl: 'wss://browser.example.test/devtools/browser/id',
        bearerToken: 'secret',
        timeout: 5000,
      });
    });

    it('rejects malformed remote selection instead of falling back to local storage', () => {
      expect(() => parseBrowserBackendConfiguration({ type: 'remote' })).toThrow(
        'Remote browserBackend requires a wsUrl',
      );
    });
  });

  it('starts with a local adapter', () => {
    expect(manager.getAdapterType()).toBe('local');
    expect(manager.getAdapter()).toBeDefined();
  });

  it('getBackend returns chrome or edge based on browser detection', () => {
    const backend = manager.getBackend();
    expect(['chrome', 'edge']).toContain(backend);
  });

  describe('switchBackend', () => {
    it('switches to chrome adapter', async () => {
      const adapter = await manager.switchBackend('chrome');
      expect(adapter).toBeDefined();
      expect(manager.getAdapterType()).toBe('local');
      expect(manager.getBackend()).toBe('chrome');
    });

    it('switches to edge adapter', async () => {
      const adapter = await manager.switchBackend('edge');
      expect(adapter).toBeDefined();
      expect(manager.getAdapterType()).toBe('local');
      expect(manager.getBackend()).toBe('edge');
    });

    it('throws when switching to remote without wsUrl', async () => {
      await expect(manager.switchBackend('remote')).rejects.toThrow(
        'wsUrl is required for remote backend',
      );
    });

    it('disconnects current adapter before switching', async () => {
      const currentAdapter = manager.getAdapter();
      const disconnectSpy = vi.spyOn(currentAdapter, 'disconnect').mockResolvedValue(undefined as never);
      const isConnectedSpy = vi.spyOn(currentAdapter, 'isConnected').mockReturnValue(true);

      await manager.switchBackend('chrome');

      expect(isConnectedSpy).toHaveBeenCalled();
      expect(disconnectSpy).toHaveBeenCalled();
    });

    it('does not disconnect if current adapter is not connected', async () => {
      const currentAdapter = manager.getAdapter();
      const disconnectSpy = vi.spyOn(currentAdapter, 'disconnect').mockResolvedValue(undefined as never);
      const isConnectedSpy = vi.spyOn(currentAdapter, 'isConnected').mockReturnValue(false);

      await manager.switchBackend('edge');

      expect(isConnectedSpy).toHaveBeenCalled();
      expect(disconnectSpy).not.toHaveBeenCalled();
    });

    it('notifies listeners on backend switch', async () => {
      const listener = vi.fn();
      manager.onBackendSwitch(listener);

      await manager.switchBackend('edge');

      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledWith('edge', expect.any(Object));
    });

    it('unsubscribe removes listener', async () => {
      const listener = vi.fn();
      const unsubscribe = manager.onBackendSwitch(listener);

      unsubscribe();
      await manager.switchBackend('chrome');

      expect(listener).not.toHaveBeenCalled();
    });

    it('returns new adapter instance after switch', async () => {
      const originalAdapter = manager.getAdapter();
      await manager.switchBackend('edge');
      const newAdapter = manager.getAdapter();

      expect(newAdapter).not.toBe(originalAdapter);
    });

    it('logs the backend switch', async () => {
      await manager.switchBackend('chrome');

      expect(logger.info).toHaveBeenCalledWith('Switched backend', { backend: 'chrome' });
    });
  });
});
