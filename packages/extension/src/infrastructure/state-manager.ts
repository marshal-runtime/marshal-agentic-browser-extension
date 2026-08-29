/**
 * In-memory state manager with chrome.storage persistence for service worker
 * restart recovery.
 *
 * Uses a three-tier fallback chain:
 * 1. In-memory {@link Map} cache (fastest, lost on restart)
 * 2. `chrome.storage.session` (survives restarts within browser session)
 * 3. `chrome.storage.local` (survives browser restarts)
 */

import { Logger } from './logger.js';

const logger = Logger.getInstance();

/** Key prefix used in chrome.storage to namespace state entries. */
const STORAGE_PREFIX = 'state:';

/**
 * Manages extension state with in-memory caching and chrome.storage persistence.
 *
 * Provides typed generic access to stored values and a fallback chain for
 * durability across service worker restarts.
 */
class StateManager {
  private static instance: StateManager | undefined;

  private readonly cache = new Map<string, unknown>();

  private constructor() {}

  /** Returns the singleton StateManager instance. */
  static getInstance(): StateManager {
    if (!StateManager.instance) {
      StateManager.instance = new StateManager();
    }
    return StateManager.instance;
  }

  /**
   * Retrieves a value from the in-memory cache.
   *
   * @typeParam T - Expected type of the stored value.
   * @param key - Storage key to look up.
   * @returns The cached value, or `undefined` if not present.
   */
  get<T>(key: string): Promise<T | undefined> {
    return Promise.resolve(this.cache.get(key) as T | undefined);
  }

  /**
   * Stores a value in the in-memory cache.
   *
   * @param key - Storage key.
   * @param value - Value to cache.
   */
  set(key: string, value: unknown): Promise<void> {
    this.cache.set(key, value);
    return Promise.resolve();
  }

  /**
   * Removes a value from the in-memory cache and both chrome.storage areas.
   *
   * @param key - Storage key to delete.
   */
  async delete(key: string): Promise<void> {
    this.cache.delete(key);
    const storageKey = STORAGE_PREFIX + key;

    try {
      await chrome.storage.session.remove(storageKey);
    } catch (error: unknown) {
      logger.warn('Failed to remove key from session storage', {
        key,
        error: String(error),
      });
    }

    try {
      await chrome.storage.local.remove(storageKey);
    } catch (error: unknown) {
      logger.warn('Failed to remove key from local storage', {
        key,
        error: String(error),
      });
    }
  }

  /**
   * Persists all in-memory cache entries to chrome.storage.
   *
   * Writes to `chrome.storage.session` first, then falls back to
   * `chrome.storage.local` on quota or other errors.
   */
  async persist(): Promise<void> {
    if (this.cache.size === 0) {
      return;
    }

    const items: Record<string, unknown> = {};
    for (const [key, value] of this.cache) {
      items[STORAGE_PREFIX + key] = value;
    }

    try {
      await chrome.storage.session.set(items);
    } catch (error: unknown) {
      logger.warn('Session storage write failed, falling back to local storage', {
        error: String(error),
        entryCount: this.cache.size,
      });

      try {
        await chrome.storage.local.set(items);
      } catch (localError: unknown) {
        logger.error('Local storage write also failed — state not persisted', {
          error: String(localError),
          entryCount: this.cache.size,
        });
      }
    }
  }

  /**
   * Restores state from chrome.storage into the in-memory cache.
   *
   * Reads from `chrome.storage.session` first. If no entries are found,
   * falls back to `chrome.storage.local`.
   */
  async restore(): Promise<void> {
    let entries = await this.readStorageArea(chrome.storage.session, 'session');

    if (Object.keys(entries).length === 0) {
      entries = await this.readStorageArea(chrome.storage.local, 'local');
    }

    for (const [storageKey, value] of Object.entries(entries)) {
      if (storageKey.startsWith(STORAGE_PREFIX)) {
        const key = storageKey.slice(STORAGE_PREFIX.length);
        this.cache.set(key, value);
      }
    }
  }

  /**
   * Reads all prefixed entries from a chrome.storage area.
   *
   * @param area - The chrome.storage area to read from.
   * @param label - Human-readable label for logging.
   * @returns Object of matching key-value pairs, or empty object on failure.
   */
  private async readStorageArea(
    area: chrome.storage.StorageArea,
    label: string,
  ): Promise<Record<string, unknown>> {
    try {
      const all = await area.get(null);
      const result: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(all)) {
        if (key.startsWith(STORAGE_PREFIX)) {
          result[key] = value;
        }
      }
      return result;
    } catch (error: unknown) {
      logger.warn(`Failed to read from ${label} storage`, {
        error: String(error),
      });
      return {};
    }
  }
}

/** Singleton state manager instance. */
const stateManager = StateManager.getInstance();

export { StateManager, stateManager };
