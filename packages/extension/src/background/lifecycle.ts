/**
 * Service worker lifecycle manager for MV3 extension.
 *
 * Handles install, startup, and suspend events to ensure state is
 * persisted before idle termination and restored on wake-up.
 */

import { Logger } from '../infrastructure/logger.js';
import { StateManager } from '../infrastructure/state-manager.js';

const logger = Logger.getInstance();
const stateManager = StateManager.getInstance();

/** Internal state key used to track lifecycle status. */
const LIFECYCLE_STATE_KEY = 'lifecycle:initialized';

/**
 * Manages the extension service worker lifecycle.
 *
 * Registers Chrome runtime event listeners for install, startup, and suspend
 * events. Persists state via {@link StateManager} before idle termination and
 * restores it on wake-up.
 */
export class Lifecycle {
  private initialized = false;

  /**
   * Initializes the lifecycle manager by registering Chrome runtime listeners.
   *
   * Must be called once during service worker startup. Subsequent calls are
   * ignored.
   */
  async init(): Promise<void> {
    if (this.initialized) {
      return;
    }

    chrome.runtime.onInstalled.addListener((details: chrome.runtime.InstalledDetails) => {
      void this.onInstall(details);
    });

    chrome.runtime.onStartup.addListener(() => {
      void this.onStartup();
    });

    chrome.runtime.onSuspend.addListener(() => {
      void this.onSuspend();
    });

    this.initialized = true;
    await stateManager.set(LIFECYCLE_STATE_KEY, true);

    logger.info('Lifecycle manager initialized');
  }

  /**
   * Handles the `chrome.runtime.onInstalled` event.
   *
   * Logs the extension version and install reason, then initializes default
   * state.
   */
  async onInstall(details: chrome.runtime.InstalledDetails): Promise<void> {
    const manifest = chrome.runtime.getManifest();

    logger.info('Extension installed', {
      version: manifest.version,
      reason: details.reason,
    });

    await stateManager.set(LIFECYCLE_STATE_KEY, true);
  }

  /**
   * Handles the `chrome.runtime.onStartup` event.
   *
   * Restores persisted state from chrome.storage via {@link StateManager}.
   */
  async onStartup(): Promise<void> {
    const start = Date.now();

    await stateManager.restore();

    const elapsed = Date.now() - start;
    logger.info('State restored on startup', { elapsedMs: elapsed });
  }

  /**
   * Handles the `chrome.runtime.onSuspend` event.
   *
   * Persists current in-memory state to chrome.storage before the service
   * worker is terminated due to idle timeout.
   */
  async onSuspend(): Promise<void> {
    await stateManager.persist();
    logger.info('State persisted before suspend');
  }
}
