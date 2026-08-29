import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { chrome, resetChromeMocks } from '../../__mocks__/chrome.js';

vi.stubGlobal('chrome', chrome);

vi.mock('../../../src/infrastructure/logger.js', () => {
  const noop = () => {};
  return {
    Logger: {
      getInstance: () => ({
        debug: noop,
        info: noop,
        warn: noop,
        error: noop,
      }),
    },
  };
});

const { CheckpointManager } = await import('../../../src/infrastructure/checkpoint-manager.js');

function getManager(): ReturnType<typeof CheckpointManager.getInstance> {
  (CheckpointManager as unknown as { instance: undefined }).instance = undefined;
  return CheckpointManager.getInstance();
}

describe('CheckpointManager', () => {
  let manager: ReturnType<typeof CheckpointManager.getInstance>;

  beforeEach(() => {
    resetChromeMocks();
    manager = getManager();
  });

  describe('saveCheckpoint', () => {
    it('should persist checkpoint data to chrome.storage.local', async () => {
      await manager.saveCheckpoint('cp-1', 0, [
        { stepIndex: 0, status: 'success', timestamp: 1000 },
      ], { taskName: 'test' });

      const store = chrome.storage.local._getStore();
      const data = store['checkpoint:cp-1'] as Record<string, unknown>;

      expect(data).toBeDefined();
      expect(data.checkpointId).toBe('cp-1');
      expect(data.stepIndex).toBe(0);
    });

    it('should include TTL in saved data', async () => {
      await manager.saveCheckpoint('cp-2', 1, [], { taskName: 'test' });

      const store = chrome.storage.local._getStore();
      const data = store['checkpoint:cp-2'] as Record<string, unknown>;

      expect(data.ttl).toBe(30 * 60 * 1000);
    });

    it('should include timestamp in saved data', async () => {
      const before = Date.now();
      await manager.saveCheckpoint('cp-3', 0, [], {});
      const after = Date.now();

      const store = chrome.storage.local._getStore();
      const data = store['checkpoint:cp-3'] as Record<string, unknown>;

      expect(data.timestamp).toBeGreaterThanOrEqual(before);
      expect(data.timestamp).toBeLessThanOrEqual(after);
    });

    it('should store step results', async () => {
      const steps = [
        { stepIndex: 0, status: 'success' as const, data: { url: 'https://example.com' }, timestamp: 1000 },
        { stepIndex: 1, status: 'failure' as const, error: 'timeout', timestamp: 2000 },
      ];

      await manager.saveCheckpoint('cp-4', 1, steps, {});

      const store = chrome.storage.local._getStore();
      const data = store['checkpoint:cp-4'] as Record<string, unknown>;
      const savedSteps = data.stepResults as typeof steps;

      expect(savedSteps).toHaveLength(2);
      expect(savedSteps[0]!.status).toBe('success');
      expect(savedSteps[1]!.status).toBe('failure');
    });
  });

  describe('getCheckpoint', () => {
    it('should retrieve a saved checkpoint', async () => {
      await manager.saveCheckpoint('cp-get', 2, [
        { stepIndex: 0, status: 'success', timestamp: 1000 },
        { stepIndex: 1, status: 'success', timestamp: 2000 },
        { stepIndex: 2, status: 'success', timestamp: 3000 },
      ], { taskName: 'fetch-test' });

      const data = await manager.getCheckpoint('cp-get');

      expect(data).toBeDefined();
      expect(data!.checkpointId).toBe('cp-get');
      expect(data!.stepIndex).toBe(2);
      expect(data!.stepResults).toHaveLength(3);
      expect(data!.diagnosticContext.taskName).toBe('fetch-test');
    });

    it('should return undefined for nonexistent checkpoint', async () => {
      const data = await manager.getCheckpoint('does-not-exist');

      expect(data).toBeUndefined();
    });

    it('should return undefined for expired checkpoint', async () => {
      const expiredData = {
        checkpointId: 'cp-expired',
        stepIndex: 0,
        stepResults: [],
        diagnosticContext: {},
        timestamp: Date.now() - 31 * 60 * 1000,
        ttl: 30 * 60 * 1000,
      };

      await chrome.storage.local.set({ 'checkpoint:cp-expired': expiredData });

      const data = await manager.getCheckpoint('cp-expired');

      expect(data).toBeUndefined();
    });
  });

  describe('resumeFromCheckpoint', () => {
    it('should return step results for an existing checkpoint', async () => {
      const steps = [
        { stepIndex: 0, status: 'success' as const, data: 'a', timestamp: 1000 },
        { stepIndex: 1, status: 'success' as const, data: 'b', timestamp: 2000 },
      ];

      await manager.saveCheckpoint('cp-resume', 1, steps, {});

      const results = await manager.resumeFromCheckpoint('cp-resume');

      expect(results).toHaveLength(2);
      expect(results[0]!.stepIndex).toBe(0);
      expect(results[1]!.stepIndex).toBe(1);
    });

    it('should return empty array for nonexistent checkpoint', async () => {
      const results = await manager.resumeFromCheckpoint('missing');

      expect(results).toEqual([]);
    });

    it('should return empty array for expired checkpoint', async () => {
      const expiredData = {
        checkpointId: 'cp-expired-resume',
        stepIndex: 0,
        stepResults: [{ stepIndex: 0, status: 'success', timestamp: 1000 }],
        diagnosticContext: {},
        timestamp: Date.now() - 31 * 60 * 1000,
        ttl: 30 * 60 * 1000,
      };

      await chrome.storage.local.set({ 'checkpoint:cp-expired-resume': expiredData });

      const results = await manager.resumeFromCheckpoint('cp-expired-resume');

      expect(results).toEqual([]);
    });
  });

  describe('TTL cleanup', () => {
    it('should remove expired checkpoints during cleanup', async () => {
      const expired = {
        checkpointId: 'cp-old',
        stepIndex: 0,
        stepResults: [],
        diagnosticContext: {},
        timestamp: Date.now() - 31 * 60 * 1000,
        ttl: 30 * 60 * 1000,
      };
      const valid = {
        checkpointId: 'cp-new',
        stepIndex: 0,
        stepResults: [],
        diagnosticContext: {},
        timestamp: Date.now(),
        ttl: 30 * 60 * 1000,
      };

      await chrome.storage.local.set({
        'checkpoint:cp-old': expired,
        'checkpoint:cp-new': valid,
      });

      await manager.cleanup();

      const store = chrome.storage.local._getStore();

      expect(store['checkpoint:cp-old']).toBeUndefined();
      expect(store['checkpoint:cp-new']).toBeDefined();
    });

    it('should not remove non-checkpoint keys', async () => {
      await chrome.storage.local.set({ 'other-key': 'value' });

      await manager.cleanup();

      const store = chrome.storage.local._getStore();

      expect(store['other-key']).toBe('value');
    });
  });

  describe('quota handling', () => {
    it('should retry after evicting expired checkpoints on quota error', async () => {
      const expired = {
        checkpointId: 'cp-quota-expired',
        stepIndex: 0,
        stepResults: [],
        diagnosticContext: {},
        timestamp: Date.now() - 31 * 60 * 1000,
        ttl: 30 * 60 * 1000,
      };
      await chrome.storage.local.set({ 'checkpoint:cp-quota-expired': expired });

      let callCount = 0;
      const originalSet = chrome.storage.local.set.getMockImplementation()!;
      chrome.storage.local.set.mockImplementation((items: Record<string, unknown>) => {
        callCount++;
        if (callCount === 1) {
          throw new DOMException('Quota exceeded', 'QuotaExceededError');
        }
        return originalSet(items);
      });

      await manager.saveCheckpoint('cp-retry', 0, [], {});

      const store = chrome.storage.local._getStore();

      expect(store['checkpoint:cp-retry']).toBeDefined();
    });

    it('should evict oldest checkpoint if quota still exceeded after expired eviction', async () => {
      const oldest = {
        checkpointId: 'cp-oldest',
        stepIndex: 0,
        stepResults: [],
        diagnosticContext: {},
        timestamp: Date.now() - 1000,
        ttl: 30 * 60 * 1000,
      };
      await chrome.storage.local.set({ 'checkpoint:cp-oldest': oldest });

      let callCount = 0;
      const originalSet = chrome.storage.local.set.getMockImplementation()!;
      chrome.storage.local.set.mockImplementation((items: Record<string, unknown>) => {
        callCount++;
        if (callCount <= 2) {
          throw new DOMException('Quota exceeded', 'QuotaExceededError');
        }
        return originalSet(items);
      });

      await manager.saveCheckpoint('cp-after-evict', 0, [], {});

      const store = chrome.storage.local._getStore();

      expect(store['checkpoint:cp-oldest']).toBeUndefined();
      expect(store['checkpoint:cp-after-evict']).toBeDefined();
    });
  });
});
