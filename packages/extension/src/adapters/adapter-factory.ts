/**
 * Factory for creating and managing {@link IBrowserAdapter} instances.
 *
 * Supports runtime switching between local (Chrome/Edge) and remote
 * adapters via {@link AdapterManager}.
 */

import type { IBrowserAdapter, RemoteConnectOptions } from '@agentic-browser/shared';
import type { TabTracker } from '../infrastructure/tab-tracker.js';
import type { CDPManager } from '../infrastructure/cdp-manager.js';
import type { Logger } from '../infrastructure/logger.js';
import { ChromeAdapter } from './chrome-adapter.js';
import { EdgeAdapter } from './edge-adapter.js';
import { RemoteAdapter } from './remote-adapter.js';

/**
 * Detects whether the current browser is Microsoft Edge (Chromium).
 *
 * Edge Chromium includes `"Edg/"` (without the trailing "e") in its
 * user-agent string, distinguishing it from legacy Edge (`"Edge/"`).
 *
 * @returns `true` when running in Edge Chromium, `false` otherwise
 */
function isEdgeBrowser(): boolean {
  try {
    return /\bEdg\//.test(navigator.userAgent);
  } catch {
    return false;
  }
}

/**
 * Creates the correct browser adapter for the detected runtime browser.
 *
 * Returns an {@link EdgeAdapter} when the user-agent contains the Edge
 * Chromium signature (`"Edg/"`), otherwise returns a {@link ChromeAdapter}.
 *
 * @param tabTracker - Tab tracking service
 * @param cdpManager - Chrome DevTools Protocol manager
 * @param logger     - Application logger
 * @returns A {@link ChromeAdapter} or {@link EdgeAdapter} instance
 *
 * @example
 * ```ts
 * const adapter = createAdapter(tabTracker, cdpManager, logger);
 * await adapter.connect();
 * ```
 */
function createAdapter(
  tabTracker: TabTracker,
  cdpManager: CDPManager,
  logger: Logger,
): IBrowserAdapter {
  if (isEdgeBrowser()) {
    return new EdgeAdapter(tabTracker, cdpManager, logger);
  }
  return new ChromeAdapter(tabTracker, cdpManager, logger);
}

/** Specific backend identifier for runtime switching. */
type BackendType = 'chrome' | 'edge' | 'remote';

/** Adapter type discriminant. */
type AdapterType = 'local' | 'remote';

type BrowserBackendConfiguration =
  | { readonly type: 'local' }
  | {
      readonly type: 'remote';
      readonly wsUrl: string;
      readonly bearerToken?: string;
      readonly timeout?: number;
    };

interface BrowserBackendStorage {
  readonly local: {
    get(key: string): Promise<Record<string, unknown>>;
  };
  readonly managed: {
    get(key: string): Promise<Record<string, unknown>>;
  };
}

/** Callback for backend switch notifications. */
type BackendSwitchListener = (backend: BackendType, adapter: IBrowserAdapter) => void;

/**
 * Manages the active browser adapter, supporting runtime switching
 * between local (Chrome/Edge) and remote (WebSocket/CDP) adapters.
 */
class AdapterManager {
  private readonly tabTracker: TabTracker;
  private readonly cdpManager: CDPManager;
  private readonly logger: Logger;
  private currentAdapter: IBrowserAdapter;
  private adapterType: AdapterType = 'local';
  private currentBackend: BackendType;
  private readonly switchListeners: BackendSwitchListener[] = [];

  constructor(tabTracker: TabTracker, cdpManager: CDPManager, logger: Logger) {
    this.tabTracker = tabTracker;
    this.cdpManager = cdpManager;
    this.logger = logger;
    this.currentAdapter = createAdapter(tabTracker, cdpManager, logger);
    this.currentBackend = isEdgeBrowser() ? 'edge' : 'chrome';
  }

  /** Returns the currently active adapter. */
  getAdapter(): IBrowserAdapter {
    return this.currentAdapter;
  }

  /** Returns the current adapter type. */
  getAdapterType(): AdapterType {
    return this.adapterType;
  }

  /** Returns the specific backend identifier. */
  getBackend(): BackendType {
    return this.currentBackend;
  }

  /** Registers a listener to be notified on backend switches. */
  onBackendSwitch(listener: BackendSwitchListener): () => void {
    this.switchListeners.push(listener);
    return () => {
      const idx = this.switchListeners.indexOf(listener);
      if (idx >= 0) {
        this.switchListeners.splice(idx, 1);
      }
    };
  }

  private notifySwitchListeners(): void {
    for (const listener of this.switchListeners) {
      listener(this.currentBackend, this.currentAdapter);
    }
  }

  /**
   * Switches to a specific backend at runtime without restart.
   *
   * @param backend - Target backend: 'chrome', 'edge', or 'remote'.
   * @param options - Optional settings (wsUrl/bearerToken for remote).
   * @returns The new adapter instance after switching.
   */
  async switchBackend(
    backend: BackendType,
    options?: { wsUrl?: string; bearerToken?: string; timeout?: number },
  ): Promise<IBrowserAdapter> {
    if (this.currentAdapter.isConnected()) {
      await this.currentAdapter.disconnect();
    }

    switch (backend) {
      case 'chrome': {
        this.currentAdapter = new ChromeAdapter(this.tabTracker, this.cdpManager, this.logger);
        this.adapterType = 'local';
        break;
      }
      case 'edge': {
        this.currentAdapter = new EdgeAdapter(this.tabTracker, this.cdpManager, this.logger);
        this.adapterType = 'local';
        break;
      }
      case 'remote': {
        if (!options?.wsUrl) {
          throw new Error('wsUrl is required for remote backend');
        }
        const remoteAdapter = new RemoteAdapter(this.logger);
        const result = await remoteAdapter.connectRemote(options.wsUrl, {
          bearerToken: options.bearerToken,
          timeout: options.timeout,
        });
        if (!result.ok) {
          throw new Error(result.error.message);
        }
        this.currentAdapter = remoteAdapter;
        this.adapterType = 'remote';
        break;
      }
    }

    this.currentBackend = backend;
    this.logger.info('Switched backend', { backend });
    this.notifySwitchListeners();
    return this.currentAdapter;
  }

  /**
   * Switches to a remote adapter connected via WebSocket.
   *
   * Disconnects the current adapter (if connected) before creating
   * a new {@link RemoteAdapter} and establishing the remote connection.
   *
   * @param wsUrl   - WebSocket URL of the remote browser (e.g. `ws://localhost:9222`)
   * @param options - Optional remote connection settings
   * @returns The remote adapter instance after successful connection
   */
  async switchToRemote(wsUrl: string, options?: RemoteConnectOptions): Promise<RemoteAdapter> {
    if (this.currentAdapter.isConnected()) {
      await this.currentAdapter.disconnect();
    }

    const remoteAdapter = new RemoteAdapter(this.logger);
    const result = await remoteAdapter.connectRemote(wsUrl, options);

    if (!result.ok) {
      throw new Error(result.error.message);
    }

    this.currentAdapter = remoteAdapter;
    this.adapterType = 'remote';
    this.logger.info('Switched to remote adapter', { wsUrl });
    return remoteAdapter;
  }

  /**
   * Switches back to the local (Chrome/Edge) adapter.
   *
   * Disconnects the current adapter (if connected) before creating
   * a fresh local adapter based on browser detection.
   *
   * @returns The local adapter instance
   */
  async switchToLocal(): Promise<IBrowserAdapter> {
    if (this.currentAdapter.isConnected()) {
      await this.currentAdapter.disconnect();
    }

    this.currentAdapter = createAdapter(this.tabTracker, this.cdpManager, this.logger);
    this.adapterType = 'local';
    this.logger.info('Switched to local adapter');
    return this.currentAdapter;
  }
}

function parseBrowserBackendConfiguration(value: unknown): BrowserBackendConfiguration {
  if (value === undefined) {
    return { type: 'local' };
  }

  if (typeof value !== 'object' || value === null || !('type' in value)) {
    throw new Error('browserBackend must be a local or remote backend configuration');
  }
  if (value.type === 'local') {
    return { type: 'local' };
  }
  if (value.type !== 'remote' || !('wsUrl' in value) || typeof value.wsUrl !== 'string') {
    throw new Error('Remote browserBackend requires a wsUrl');
  }
  if (
    ('bearerToken' in value && typeof value.bearerToken !== 'string') ||
    ('timeout' in value && typeof value.timeout !== 'number')
  ) {
    throw new Error('Remote browserBackend bearerToken and timeout have invalid types');
  }
  return {
    type: 'remote',
    wsUrl: value.wsUrl,
    bearerToken:
      'bearerToken' in value && typeof value.bearerToken === 'string'
        ? value.bearerToken
        : undefined,
    timeout: 'timeout' in value && typeof value.timeout === 'number' ? value.timeout : undefined,
  };
}

async function readBrowserBackendConfiguration(
  storage: BrowserBackendStorage,
): Promise<BrowserBackendConfiguration> {
  const stored = await storage.local.get('browserBackend');
  const managed = await storage.managed.get('browserBackend');
  return parseBrowserBackendConfiguration(
    managed['browserBackend'] ?? stored['browserBackend'],
  );
}

async function createConfiguredAdapter(
  tabTracker: TabTracker,
  cdpManager: CDPManager,
  logger: Logger,
  configuration: BrowserBackendConfiguration,
): Promise<IBrowserAdapter> {
  if (configuration.type === 'local') {
    return createAdapter(tabTracker, cdpManager, logger);
  }

  const adapter = new RemoteAdapter(logger);
  const connected = await adapter.connectRemote(configuration.wsUrl, {
    bearerToken: configuration.bearerToken,
    timeout: configuration.timeout,
  });
  if (!connected.ok) {
    throw new Error(`Remote browser backend connection failed: ${connected.error.message}`);
  }
  return adapter;
}

export {
  createAdapter,
  createConfiguredAdapter,
  parseBrowserBackendConfiguration,
  readBrowserBackendConfiguration,
  AdapterManager,
};
export type {
  AdapterType,
  BackendType,
  BackendSwitchListener,
  BrowserBackendConfiguration,
  BrowserBackendStorage,
};
