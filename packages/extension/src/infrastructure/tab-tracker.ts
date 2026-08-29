/**
 * Tracks browser tab state using chrome.tabs events.
 *
 * Maintains an in-memory {@link Map} of {@link TabState} entries, updated in
 * real time via `chrome.tabs.onCreated`, `onUpdated`, `onRemoved`, and
 * `onActivated` listeners.
 */

import { Logger } from './logger.js';

const logger = Logger.getInstance();

/** Snapshot of a single browser tab's observable properties. */
interface TabState {
  readonly id: number;
  readonly url: string;
  readonly title: string;
  readonly status: string;
  readonly favIconUrl: string;
  readonly windowId: number;
  readonly active: boolean;
}

type TabChangeListener = (tabs: readonly TabState[]) => void;

/**
 * Converts a `chrome.tabs.Tab` object into a {@link TabState} snapshot.
 *
 * Missing or undefined fields are replaced with safe defaults.
 */
function toTabState(tab: chrome.tabs.Tab): TabState {
  return {
    id: tab.id ?? -1,
    url: tab.url ?? '',
    title: tab.title ?? '',
    status: tab.status ?? 'loading',
    favIconUrl: tab.favIconUrl ?? '',
    windowId: tab.windowId,
    active: tab.active,
  };
}

/**
 * Tracks active browser tabs and exposes query helpers.
 *
 * Call {@link TabTracker.init} once during service worker startup to populate
 * the initial state and register event listeners.
 */
class TabTracker {
  private readonly tabs = new Map<number, TabState>();
  private readonly listeners = new Set<TabChangeListener>();
  private activeTabId: number | undefined;
  private initialized = false;

  /**
   * Populates the tab map from the current browser state and registers
   * chrome.tabs event listeners.
   *
   * Safe to call multiple times — subsequent calls are no-ops.
   */
  async init(): Promise<void> {
    if (this.initialized) {
      return;
    }

    const existingTabs = await chrome.tabs.query({});
    for (const tab of existingTabs) {
      if (tab.id !== undefined) {
        const state = toTabState(tab);
        this.tabs.set(tab.id, state);
        if (state.active) {
          this.activeTabId = tab.id;
        }
      }
    }

    chrome.tabs.onCreated.addListener(this.handleCreated);
    chrome.tabs.onUpdated.addListener(this.handleUpdated);
    chrome.tabs.onRemoved.addListener(this.handleRemoved);
    chrome.tabs.onActivated.addListener(this.handleActivated);

    this.initialized = true;
    logger.debug('TabTracker initialized', { tabCount: this.tabs.size });
  }

  /** Returns the {@link TabState} for a given tab ID, or `undefined`. */
  getTab(tabId: number): TabState | undefined {
    return this.tabs.get(tabId);
  }

  /** Returns all tracked tabs as a read-only array. */
  getAllTabs(): readonly TabState[] {
    return [...this.tabs.values()];
  }

  /** Returns the currently active tab, or `undefined` if unknown. */
  getActiveTab(): TabState | undefined {
    if (this.activeTabId === undefined) {
      return undefined;
    }
    return this.tabs.get(this.activeTabId);
  }

  /** Subscribes to tab snapshots after create, update, remove, or activation events. */
  onChange(listener: TabChangeListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private readonly handleCreated = (tab: chrome.tabs.Tab): void => {
    if (tab.id === undefined) {
      return;
    }
    const state = toTabState(tab);
    this.tabs.set(tab.id, state);
    this.notifyListeners();
    logger.debug('Tab created', { tabId: tab.id });
  };

  private readonly handleUpdated = (
    tabId: number,
    _changeInfo: chrome.tabs.TabChangeInfo,
    tab: chrome.tabs.Tab,
  ): void => {
    const state = toTabState(tab);
    this.tabs.set(tabId, state);
    this.notifyListeners();
    logger.debug('Tab updated', { tabId });
  };

  private readonly handleRemoved = (tabId: number): void => {
    this.tabs.delete(tabId);
    if (this.activeTabId === tabId) {
      this.activeTabId = undefined;
    }
    this.notifyListeners();
    logger.debug('Tab removed', { tabId });
  };

  private readonly handleActivated = (activeInfo: chrome.tabs.TabActiveInfo): void => {
    if (this.activeTabId !== undefined) {
      const prev = this.tabs.get(this.activeTabId);
      if (prev) {
        this.tabs.set(this.activeTabId, { ...prev, active: false });
      }
    }

    this.activeTabId = activeInfo.tabId;

    const current = this.tabs.get(activeInfo.tabId);
    if (current) {
      this.tabs.set(activeInfo.tabId, { ...current, active: true });
    }
    this.notifyListeners();
    logger.debug('Tab activated', { tabId: activeInfo.tabId });
  };

  private notifyListeners(): void {
    const snapshot = this.getAllTabs();
    for (const listener of this.listeners) {
      listener(snapshot);
    }
  }
}

export { TabTracker };
export type { TabChangeListener, TabState };
