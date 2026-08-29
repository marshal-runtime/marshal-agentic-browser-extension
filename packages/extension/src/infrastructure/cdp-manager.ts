/**
 * Chrome DevTools Protocol (CDP) manager for debugger attachment,
 * command execution, and event subscription per tab.
 *
 * Wraps the callback-based `chrome.debugger` API in Promise-based methods
 * and tracks which tabs currently have a debugger attached.
 */

import { ErrorCode } from '@agentic-browser/shared';
import { Logger } from './logger.js';

const logger = Logger.getInstance();

/** CDP protocol version used for debugger attachment. */
const CDP_VERSION = '1.3';

/** Error thrown by CDP operations, carrying a structured {@link ErrorCode}. */
class CDPError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = 'CDPError';
    this.code = code;
  }
}

/** Callback signature for CDP event listeners. */
type CDPEventListener<T = Record<string, unknown>> = (method: string, params: T) => void;

/**
 * Manages Chrome DevTools Protocol debugger sessions per tab.
 *
 * Provides typed methods for attaching/detaching the debugger, sending CDP
 * commands, and subscribing to CDP events. Tracks attached tabs to prevent
 * double-attach and handles external detach events for cleanup.
 */
class CDPManager {
  private readonly attachedTabs = new Set<number>();
  private readonly eventListeners = new Map<number, Set<CDPEventListener>>();
  private listenersRegistered = false;

  constructor() {
    this.registerDebuggerListeners();
  }

  /**
   * Attaches the debugger to a tab.
   *
   * No-ops if the tab already has a debugger attached.
   *
   * @param tabId - ID of the tab to attach to.
   * @throws {@link CDPError} with `code: ErrorCode.PERMISSION_DENIED` when attachment fails.
   */
  async attach(tabId: number): Promise<void> {
    if (this.attachedTabs.has(tabId)) {
      logger.debug('Debugger already attached', { tabId });
      return;
    }

    const debuggerApi = this.requireDebuggerApi();
    return new Promise<void>((resolve, reject) => {
      debuggerApi.attach({ tabId }, CDP_VERSION, () => {
        if (chrome.runtime.lastError) {
          const message = chrome.runtime.lastError.message ?? 'Unknown attach error';
          logger.error('Debugger attach failed', { tabId, error: message });
          reject(new CDPError(ErrorCode.PERMISSION_DENIED, message));
          return;
        }
        this.attachedTabs.add(tabId);
        logger.debug('Debugger attached', { tabId });
        resolve();
      });
    });
  }

  /**
   * Detaches the debugger from a tab.
   *
   * No-ops if the tab does not have a debugger attached.
   *
   * @param tabId - ID of the tab to detach from.
   */
  async detach(tabId: number): Promise<void> {
    if (!this.attachedTabs.has(tabId)) {
      logger.debug('Debugger not attached, skipping detach', { tabId });
      return;
    }

    const debuggerApi = this.requireDebuggerApi();
    return new Promise<void>((resolve) => {
      debuggerApi.detach({ tabId }, () => {
        if (chrome.runtime.lastError) {
          logger.warn('Debugger detach failed', {
            tabId,
            error: chrome.runtime.lastError.message ?? 'Unknown detach error',
          });
        }
        this.cleanup(tabId);
        resolve();
      });
    });
  }

  /**
   * Sends a CDP command to a tab and returns the typed response.
   *
   * @typeParam TResult - Type of the CDP command response.
   * @param tabId - ID of the tab to send the command to.
   * @param method - CDP domain method (e.g. `"Page.navigate"`).
   * @param params - Optional parameters for the CDP method.
   * @returns The typed CDP command response.
   * @throws {@link CDPError} with `code: ErrorCode.CDP_ERROR` on command failure.
   * @throws {@link CDPError} with `code: ErrorCode.NOT_CONNECTED` if debugger not attached.
   */
  async sendCommand<TResult = unknown>(
    tabId: number,
    method: string,
    params?: Record<string, unknown>,
  ): Promise<TResult> {
    if (!this.attachedTabs.has(tabId)) {
      throw new CDPError(ErrorCode.NOT_CONNECTED, 'Debugger not attached to tab');
    }

    const debuggerApi = this.requireDebuggerApi();
    return new Promise<TResult>((resolve, reject) => {
      debuggerApi.sendCommand({ tabId }, method, params ?? {}, (result) => {
        if (chrome.runtime.lastError) {
          const message = chrome.runtime.lastError.message ?? 'Unknown CDP error';
          logger.error('CDP command failed', { tabId, method, error: message });
          reject(new CDPError(ErrorCode.CDP_ERROR, message));
          return;
        }
        resolve(result as TResult);
      });
    });
  }

  /**
   * Registers a listener for CDP events on a specific tab.
   *
   * @typeParam T - Type of the event parameters.
   * @param tabId - ID of the tab to listen for events on.
   * @param listener - Callback invoked with the CDP method name and parameters.
   */
  onEvent<T = Record<string, unknown>>(tabId: number, listener: CDPEventListener<T>): void {
    let listeners = this.eventListeners.get(tabId);
    if (!listeners) {
      listeners = new Set();
      this.eventListeners.set(tabId, listeners);
    }
    listeners.add(listener as CDPEventListener);
  }

  /**
   * Removes a previously registered CDP event listener for a tab.
   *
   * @param tabId - ID of the tab.
   * @param listener - The listener to remove.
   */
  offEvent(tabId: number, listener: CDPEventListener): void {
    const listeners = this.eventListeners.get(tabId);
    if (listeners) {
      listeners.delete(listener);
      if (listeners.size === 0) {
        this.eventListeners.delete(tabId);
      }
    }
  }

  /** Returns whether the debugger is currently attached to a tab. */
  isAttached(tabId: number): boolean {
    return this.attachedTabs.has(tabId);
  }

  /** Returns all tab IDs that currently have a debugger attached. */
  getAttachedTabs(): readonly number[] {
    return [...this.attachedTabs];
  }

  private registerDebuggerListeners(): void {
    const debuggerApi = this.getDebuggerApi();
    if (!debuggerApi || this.listenersRegistered) {
      return;
    }
    debuggerApi.onDetach.addListener(this.handleDetach);
    debuggerApi.onEvent.addListener(this.handleEvent);
    this.listenersRegistered = true;
  }

  private requireDebuggerApi(): typeof chrome.debugger {
    const debuggerApi = this.getDebuggerApi();
    if (!debuggerApi) {
      throw new CDPError(ErrorCode.PERMISSION_DENIED, 'Chrome debugger permission is not granted');
    }
    this.registerDebuggerListeners();
    return debuggerApi;
  }

  private getDebuggerApi(): typeof chrome.debugger | undefined {
    return Object.prototype.hasOwnProperty.call(chrome, 'debugger') ? chrome.debugger : undefined;
  }

  private readonly handleDetach = (source: chrome.debugger.Debuggee, reason: string): void => {
    const tabId = source.tabId;
    if (tabId === undefined) {
      return;
    }
    logger.debug('Debugger detached externally', { tabId, reason });
    this.cleanup(tabId);
  };

  private readonly handleEvent = (
    source: chrome.debugger.Debuggee,
    method: string,
    params?: object,
  ): void => {
    const tabId = source.tabId;
    if (tabId === undefined) {
      return;
    }
    const listeners = this.eventListeners.get(tabId);
    if (!listeners) {
      return;
    }
    for (const listener of listeners) {
      listener(method, (params ?? {}) as Record<string, unknown>);
    }
  };

  private cleanup(tabId: number): void {
    this.attachedTabs.delete(tabId);
    this.eventListeners.delete(tabId);
  }
}

export { CDPManager, CDPError };
export type { CDPEventListener };
