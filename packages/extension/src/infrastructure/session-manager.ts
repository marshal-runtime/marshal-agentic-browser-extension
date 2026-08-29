/**
 * Session state manager for the browser extension.
 *
 * Persists session state (active tabs, scroll positions, remote connections)
 * across agent reconnections and extension updates using chrome.storage.local.
 * Provides export/import for session portability.
 */

const SESSION_STORAGE_KEY = 'agentic_session_state';

/** Serialisable session state snapshot. */
export interface SessionState {
  readonly version: number;
  readonly timestamp: number;
  readonly activeTabs: readonly TabSessionInfo[];
  readonly connections: readonly ConnectionInfo[];
  readonly scrollPositions: Readonly<Record<string, ScrollPosition>>;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface TabSessionInfo {
  readonly tabId: number;
  readonly url: string;
  readonly title: string;
  readonly active: boolean;
}

export interface ConnectionInfo {
  readonly type: 'chrome' | 'edge' | 'remote';
  readonly wsUrl?: string;
  readonly connected: boolean;
}

export interface ScrollPosition {
  readonly x: number;
  readonly y: number;
}

function createEmptyState(): SessionState {
  return {
    version: 1,
    timestamp: Date.now(),
    activeTabs: [],
    connections: [],
    scrollPositions: {},
    metadata: {},
  };
}

/**
 * Manages session persistence via chrome.storage.local.
 *
 * Uses chrome.runtime.onInstalled to detect extension updates
 * and restore session state automatically (NFR-013).
 */
export class SessionManager {
  private state: SessionState;
  private readonly storage: typeof chrome.storage.local;

  constructor(storage?: typeof chrome.storage.local) {
    this.state = createEmptyState();
    this.storage = storage ?? chrome.storage.local;
  }

  async save(state: Partial<SessionState>): Promise<void> {
    this.state = {
      ...this.state,
      ...state,
      timestamp: Date.now(),
      version: 1,
    };

    await this.storage.set({ [SESSION_STORAGE_KEY]: this.state });
  }

  async load(): Promise<SessionState> {
    const result = await this.storage.get(SESSION_STORAGE_KEY);
    const stored = result[SESSION_STORAGE_KEY] as SessionState | undefined;

    if (stored && typeof stored === 'object' && stored.version === 1) {
      this.state = stored;
      return this.state;
    }

    return createEmptyState();
  }

  async clear(): Promise<void> {
    this.state = createEmptyState();
    await this.storage.remove(SESSION_STORAGE_KEY);
  }

  getState(): SessionState {
    return this.state;
  }

  async updateTabs(tabs: readonly TabSessionInfo[]): Promise<void> {
    await this.save({ activeTabs: tabs });
  }

  async updateScrollPosition(tabId: number, position: ScrollPosition): Promise<void> {
    const positions = { ...this.state.scrollPositions };
    positions[String(tabId)] = position;
    await this.save({ scrollPositions: positions });
  }

  async updateConnection(connection: ConnectionInfo): Promise<void> {
    const existing = [...this.state.connections];
    const idx = existing.findIndex((c) => c.type === connection.type);
    if (idx >= 0) {
      existing[idx] = connection;
    } else {
      existing.push(connection);
    }
    await this.save({ connections: existing });
  }

  exportSession(): string {
    return JSON.stringify(this.state);
  }

  async importSession(data: string): Promise<SessionState> {
    const parsed = JSON.parse(data) as SessionState;

    if (!parsed || typeof parsed !== 'object' || parsed.version !== 1) {
      throw new Error('Invalid session data: unsupported format or version');
    }

    this.state = parsed;
    await this.storage.set({ [SESSION_STORAGE_KEY]: this.state });
    return this.state;
  }

  registerUpdateListener(): void {
    if (typeof chrome !== 'undefined' && chrome.runtime.onInstalled) {
      chrome.runtime.onInstalled.addListener((details) => {
        if (details.reason === 'update') {
          void this.load();
        }
      });
    }
  }
}

let _sessionManager: SessionManager | null = null;

export function getSessionManager(): SessionManager {
  if (!_sessionManager) {
    _sessionManager = new SessionManager();
  }
  return _sessionManager;
}
