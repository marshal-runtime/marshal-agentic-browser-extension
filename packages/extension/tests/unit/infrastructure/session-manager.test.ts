import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SessionManager } from '../../../src/infrastructure/session-manager.js';
import type { SessionState, TabSessionInfo, ConnectionInfo } from '../../../src/infrastructure/session-manager.js';

function createMockStorage() {
  const store: Record<string, unknown> = {};
  return {
    get: vi.fn(async (key: string) => {
      return { [key]: store[key] };
    }),
    set: vi.fn(async (items: Record<string, unknown>) => {
      for (const [k, v] of Object.entries(items)) {
        store[k] = v;
      }
    }),
    remove: vi.fn(async (key: string) => {
      delete store[key];
    }),
    _store: store,
  } as unknown as typeof chrome.storage.local & { _store: Record<string, unknown> };
}

describe('SessionManager', () => {
  let storage: ReturnType<typeof createMockStorage>;
  let manager: SessionManager;

  beforeEach(() => {
    storage = createMockStorage();
    manager = new SessionManager(storage as unknown as typeof chrome.storage.local);
  });

  describe('save and load', () => {
    it('should save session state to storage', async () => {
      const tabs: TabSessionInfo[] = [
        { tabId: 1, url: 'https://example.com', title: 'Example', active: true },
      ];

      await manager.save({ activeTabs: tabs });

      expect(storage.set).toHaveBeenCalledWith(
        expect.objectContaining({
          agentic_session_state: expect.objectContaining({
            version: 1,
            activeTabs: tabs,
          }),
        }),
      );
    });

    it('should load session state from storage', async () => {
      const state: SessionState = {
        version: 1,
        timestamp: Date.now(),
        activeTabs: [{ tabId: 1, url: 'https://example.com', title: 'Example', active: true }],
        connections: [],
        scrollPositions: {},
        metadata: {},
      };

      storage._store['agentic_session_state'] = state;

      const loaded = await manager.load();

      expect(loaded.activeTabs).toEqual(state.activeTabs);
      expect(loaded.version).toBe(1);
    });

    it('should return empty state when nothing is stored', async () => {
      const loaded = await manager.load();

      expect(loaded.activeTabs).toEqual([]);
      expect(loaded.connections).toEqual([]);
      expect(loaded.scrollPositions).toEqual({});
      expect(loaded.version).toBe(1);
    });

    it('should persist state across agent reconnections', async () => {
      const tabs: TabSessionInfo[] = [
        { tabId: 1, url: 'https://example.com', title: 'Example', active: true },
        { tabId: 2, url: 'https://test.com', title: 'Test', active: false },
      ];

      await manager.save({ activeTabs: tabs });

      // Simulate reconnection by creating a new manager with same storage
      const newManager = new SessionManager(storage as unknown as typeof chrome.storage.local);
      const loaded = await newManager.load();

      expect(loaded.activeTabs).toEqual(tabs);
    });
  });

  describe('clear', () => {
    it('should clear session state', async () => {
      await manager.save({
        activeTabs: [{ tabId: 1, url: 'https://example.com', title: 'Test', active: true }],
      });

      await manager.clear();

      expect(storage.remove).toHaveBeenCalledWith('agentic_session_state');
      const state = manager.getState();
      expect(state.activeTabs).toEqual([]);
    });
  });

  describe('updateTabs', () => {
    it('should update tab list', async () => {
      const tabs: TabSessionInfo[] = [
        { tabId: 1, url: 'https://a.com', title: 'A', active: true },
        { tabId: 2, url: 'https://b.com', title: 'B', active: false },
      ];

      await manager.updateTabs(tabs);

      const state = manager.getState();
      expect(state.activeTabs).toEqual(tabs);
    });
  });

  describe('updateScrollPosition', () => {
    it('should update scroll position for a tab', async () => {
      await manager.updateScrollPosition(1, { x: 0, y: 500 });

      const state = manager.getState();
      expect(state.scrollPositions['1']).toEqual({ x: 0, y: 500 });
    });

    it('should preserve other scroll positions', async () => {
      await manager.updateScrollPosition(1, { x: 0, y: 100 });
      await manager.updateScrollPosition(2, { x: 0, y: 200 });

      const state = manager.getState();
      expect(state.scrollPositions['1']).toEqual({ x: 0, y: 100 });
      expect(state.scrollPositions['2']).toEqual({ x: 0, y: 200 });
    });
  });

  describe('updateConnection', () => {
    it('should add a new connection', async () => {
      const conn: ConnectionInfo = { type: 'remote', wsUrl: 'ws://localhost:9222', connected: true };

      await manager.updateConnection(conn);

      const state = manager.getState();
      expect(state.connections).toHaveLength(1);
      expect(state.connections[0]).toEqual(conn);
    });

    it('should update an existing connection', async () => {
      await manager.updateConnection({ type: 'remote', wsUrl: 'ws://localhost:9222', connected: true });
      await manager.updateConnection({ type: 'remote', wsUrl: 'ws://localhost:9222', connected: false });

      const state = manager.getState();
      expect(state.connections).toHaveLength(1);
      expect(state.connections[0]!.connected).toBe(false);
    });
  });

  describe('export/import', () => {
    it('should export session state as JSON string', async () => {
      await manager.save({
        activeTabs: [{ tabId: 1, url: 'https://example.com', title: 'Test', active: true }],
      });

      const exported = manager.exportSession();
      const parsed = JSON.parse(exported) as SessionState;

      expect(parsed.version).toBe(1);
      expect(parsed.activeTabs).toHaveLength(1);
    });

    it('should import session state from JSON string', async () => {
      const state: SessionState = {
        version: 1,
        timestamp: Date.now(),
        activeTabs: [{ tabId: 3, url: 'https://imported.com', title: 'Imported', active: true }],
        connections: [{ type: 'chrome', connected: true }],
        scrollPositions: { '3': { x: 0, y: 300 } },
        metadata: { key: 'value' },
      };

      const imported = await manager.importSession(JSON.stringify(state));

      expect(imported.activeTabs).toEqual(state.activeTabs);
      expect(imported.connections).toEqual(state.connections);
      expect(imported.scrollPositions).toEqual(state.scrollPositions);
    });

    it('should reject invalid import data', async () => {
      await expect(manager.importSession('{"version": 99}')).rejects.toThrow(
        'Invalid session data',
      );
    });

    it('should reject malformed JSON', async () => {
      await expect(manager.importSession('not json')).rejects.toThrow();
    });
  });

  describe('getState', () => {
    it('should return current state', () => {
      const state = manager.getState();
      expect(state.version).toBe(1);
      expect(state.activeTabs).toEqual([]);
    });
  });
});
