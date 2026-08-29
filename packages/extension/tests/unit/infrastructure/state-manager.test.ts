import { describe, it, expect, vi, beforeEach } from 'vitest';
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

const { StateManager } = await import('../../../src/infrastructure/state-manager.js');

describe('StateManager', () => {
  let manager: ReturnType<typeof StateManager.getInstance>;

  beforeEach(() => {
    resetChromeMocks();
    (StateManager as unknown as { instance: undefined }).instance = undefined;
    manager = StateManager.getInstance();
  });

  describe('get/set', () => {
    it('should return undefined for unset keys', async () => {
      const result = await manager.get('missing');

      expect(result).toBeUndefined();
    });

    it('should store and retrieve a value', async () => {
      await manager.set('key1', 'value1');

      const result = await manager.get('key1');

      expect(result).toBe('value1');
    });

    it('should overwrite existing values', async () => {
      await manager.set('key1', 'old');
      await manager.set('key1', 'new');

      const result = await manager.get('key1');

      expect(result).toBe('new');
    });

    it('should handle complex objects', async () => {
      const obj = { nested: { value: 42 }, arr: [1, 2, 3] };
      await manager.set('complex', obj);

      const result = await manager.get('complex');

      expect(result).toEqual(obj);
    });
  });

  describe('delete', () => {
    it('should remove value from cache', async () => {
      await manager.set('key1', 'value1');

      await manager.delete('key1');

      const result = await manager.get('key1');
      expect(result).toBeUndefined();
    });

    it('should call chrome.storage.session.remove', async () => {
      await manager.set('key1', 'value1');

      await manager.delete('key1');

      expect(chrome.storage.session.remove).toHaveBeenCalledWith('state:key1');
    });

    it('should call chrome.storage.local.remove', async () => {
      await manager.set('key1', 'value1');

      await manager.delete('key1');

      expect(chrome.storage.local.remove).toHaveBeenCalledWith('state:key1');
    });

    it('should handle session storage remove failure gracefully', async () => {
      chrome.storage.session.remove.mockRejectedValueOnce(new Error('fail'));

      await expect(manager.delete('key1')).resolves.toBeUndefined();
    });

    it('should handle local storage remove failure gracefully', async () => {
      chrome.storage.local.remove.mockRejectedValueOnce(new Error('fail'));

      await expect(manager.delete('key1')).resolves.toBeUndefined();
    });
  });

  describe('persist', () => {
    it('should do nothing when cache is empty', async () => {
      await manager.persist();

      expect(chrome.storage.session.set).not.toHaveBeenCalled();
    });

    it('should write all cache entries to session storage with prefix', async () => {
      await manager.set('a', 1);
      await manager.set('b', 2);

      await manager.persist();

      expect(chrome.storage.session.set).toHaveBeenCalledWith({
        'state:a': 1,
        'state:b': 2,
      });
    });

    it('should fall back to local storage on session storage failure', async () => {
      await manager.set('key1', 'value1');
      chrome.storage.session.set.mockRejectedValueOnce(new Error('quota'));

      await manager.persist();

      expect(chrome.storage.local.set).toHaveBeenCalledWith({
        'state:key1': 'value1',
      });
    });

    it('should handle both session and local storage failures', async () => {
      await manager.set('key1', 'value1');
      chrome.storage.session.set.mockRejectedValueOnce(new Error('quota'));
      chrome.storage.local.set.mockRejectedValueOnce(new Error('quota'));

      await expect(manager.persist()).resolves.toBeUndefined();
    });
  });

  describe('restore', () => {
    it('should restore entries from session storage', async () => {
      chrome.storage.session.get.mockResolvedValueOnce({
        'state:restored': 'from-session',
        'other:ignored': 'skip',
      });

      await manager.restore();

      const result = await manager.get('restored');
      expect(result).toBe('from-session');
    });

    it('should fall back to local storage when session is empty', async () => {
      chrome.storage.session.get.mockResolvedValueOnce({});
      chrome.storage.local.get.mockResolvedValueOnce({
        'state:restored': 'from-local',
      });

      await manager.restore();

      const result = await manager.get('restored');
      expect(result).toBe('from-local');
    });

    it('should skip entries without state: prefix', async () => {
      chrome.storage.session.get.mockResolvedValueOnce({
        'other:key': 'ignored',
        'state:valid': 'kept',
      });

      await manager.restore();

      expect(await manager.get('key')).toBeUndefined();
      expect(await manager.get('valid')).toBe('kept');
    });

    it('should handle session storage read failure gracefully', async () => {
      chrome.storage.session.get.mockRejectedValueOnce(new Error('fail'));
      chrome.storage.local.get.mockResolvedValueOnce({
        'state:fallback': 'ok',
      });

      await manager.restore();

      expect(await manager.get('fallback')).toBe('ok');
    });

    it('should handle both storage reads failing gracefully', async () => {
      chrome.storage.session.get.mockRejectedValueOnce(new Error('fail'));
      chrome.storage.local.get.mockRejectedValueOnce(new Error('fail'));

      await expect(manager.restore()).resolves.toBeUndefined();
    });
  });

  describe('singleton', () => {
    it('should return the same instance', () => {
      const a = StateManager.getInstance();
      const b = StateManager.getInstance();

      expect(a).toBe(b);
    });
  });
});
