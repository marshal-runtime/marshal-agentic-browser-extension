/**
 * Native Messaging transport for communication between the Chrome extension
 * and the MCP server native host process.
 *
 * Uses `chrome.runtime.connectNative` to establish a persistent connection
 * with the native messaging host. Handles message serialization, connection
 * lifecycle (connect, disconnect, auto-reconnect), and error handling.
 */

import { Logger } from '../infrastructure/logger.js';
import {
  MAX_MESSAGE_SIZE,
  MAX_RETRY_COUNT,
  NATIVE_MESSAGING_HOST_ID,
  RETRY_DELAY,
  ErrorCode,
} from '@agentic-browser/shared';
import type { CommandRequest, CommandResponse } from '@agentic-browser/shared';
import type { RuntimePanelChannelMessage } from '@marshal/runtime-browser-panel';

const logger = Logger.getInstance();

/** Minimum reconnect delay in milliseconds. */
const MIN_RECONNECT_DELAY = RETRY_DELAY;

/** Maximum reconnect delay in milliseconds (capped backoff). */
const MAX_RECONNECT_DELAY = 30_000;

/** Backoff multiplier for reconnection attempts. */
const RECONNECT_BACKOFF_FACTOR = 2;

type NativeMessagingInboundMessage = CommandRequest | RuntimePanelChannelMessage;
type NativeMessagingOutboundMessage = CommandResponse | RuntimePanelChannelMessage;

/** Callback type for incoming messages from the native host. */
type MessageHandler = (message: NativeMessagingInboundMessage) => void;

/** Callback type for connection error events. */
type ErrorHandler = (error: NativeMessagingError) => void;

/** Callback type for connection state change events. */
type StateChangeHandler = (connected: boolean) => void;

/** Structured error for native messaging failures. */
interface NativeMessagingError {
  readonly code: ErrorCode;
  readonly message: string;
  readonly details?: string;
}

/**
 * Manages the Native Messaging connection to the MCP server host process.
 *
 * Provides methods to connect, disconnect, send messages, and register
 * listeners for incoming messages and connection events. Supports automatic
 * reconnection with exponential backoff when the connection drops
 * unexpectedly.
 */
export class NativeMessaging {
  private port: chrome.runtime.Port | null = null;
  private readonly hostName: string;
  private connected = false;
  private reconnecting = false;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private intentionalDisconnect = false;

  private readonly messageHandlers: Set<MessageHandler> = new Set();
  private readonly errorHandlers: Set<ErrorHandler> = new Set();
  private readonly stateChangeHandlers: Set<StateChangeHandler> = new Set();

  /**
   * Creates a new NativeMessaging instance.
   *
   * @param hostName - The native messaging host name to connect to.
   *   Defaults to `com.agentic_browser.mcp_host`.
   */
  constructor(hostName?: string) {
    this.hostName = hostName ?? NATIVE_MESSAGING_HOST_ID;
  }

  /**
   * Opens a connection to the native messaging host.
   *
   * If already connected, this method is a no-op. On failure, emits an
   * error event and throws.
   */
  connect(): void {
    if (this.connected && this.port) {
      logger.debug('Already connected to native host', { hostName: this.hostName });
      return;
    }

    this.intentionalDisconnect = false;
    this.establishConnection();
  }

  /**
   * Closes the connection to the native messaging host.
   *
   * Cancels any pending reconnection attempts. If not connected, this
   * method is a no-op.
   */
  disconnect(): void {
    this.intentionalDisconnect = true;
    this.cancelReconnect();

    if (this.port) {
      this.port.disconnect();
      this.port = null;
    }

    if (this.connected) {
      this.connected = false;
      this.notifyStateChange(false);
      logger.info('Disconnected from native host', { hostName: this.hostName });
    }
  }

  /**
   * Sends a response message to the native host.
   *
   * @param message - The command response to send.
   * @throws When not connected or when the message exceeds the 1 MB size limit.
   */
  sendMessage(message: NativeMessagingOutboundMessage): void {
    if (!this.connected || !this.port) {
      const error: NativeMessagingError = {
        code: ErrorCode.NOT_CONNECTED,
        message: 'Cannot send message: not connected to native host',
      };
      this.notifyError(error);
      throw new Error(error.message);
    }

    const serialized = JSON.stringify(message);
    const byteLength = new TextEncoder().encode(serialized).byteLength;

    if (byteLength > MAX_MESSAGE_SIZE) {
      const error: NativeMessagingError = {
        code: ErrorCode.UNKNOWN,
        message: `Message exceeds maximum size of ${String(MAX_MESSAGE_SIZE)} bytes`,
        details: `Actual size: ${String(byteLength)} bytes`,
      };
      this.notifyError(error);
      throw new Error(error.message);
    }

    this.port.postMessage(message);
    logger.debug('Sent message to native host');
  }

  /**
   * Registers a handler for incoming messages from the native host.
   *
   * @param handler - Callback invoked with each received {@link CommandRequest}.
   * @returns A dispose function that removes the handler.
   */
  onMessage(handler: MessageHandler): () => void {
    this.messageHandlers.add(handler);
    return () => {
      this.messageHandlers.delete(handler);
    };
  }

  /**
   * Registers a handler for connection errors.
   *
   * @param handler - Callback invoked with a {@link NativeMessagingError}.
   * @returns A dispose function that removes the handler.
   */
  onError(handler: ErrorHandler): () => void {
    this.errorHandlers.add(handler);
    return () => {
      this.errorHandlers.delete(handler);
    };
  }

  /**
   * Registers a handler for connection state changes.
   *
   * @param handler - Callback invoked with `true` on connect and `false`
   *   on disconnect.
   * @returns A dispose function that removes the handler.
   */
  onStateChange(handler: StateChangeHandler): () => void {
    this.stateChangeHandlers.add(handler);
    return () => {
      this.stateChangeHandlers.delete(handler);
    };
  }

  /** Returns whether the transport is currently connected. */
  isConnected(): boolean {
    return this.connected;
  }

  private establishConnection(): void {
    try {
      this.port = chrome.runtime.connectNative(this.hostName);
    } catch (err: unknown) {
      const detail = err instanceof Error ? err.message : String(err);
      const error: NativeMessagingError = {
        code: ErrorCode.CONNECTION_FAILED,
        message: 'Failed to connect to native host',
        details: detail,
      };
      logger.error('Native host connection failed', {
        hostName: this.hostName,
        error: detail,
      });
      this.notifyError(error);
      this.scheduleReconnect();
      return;
    }

    if (chrome.runtime.lastError) {
      const detail = chrome.runtime.lastError.message ?? 'Unknown error';
      const error: NativeMessagingError = {
        code: ErrorCode.CONNECTION_FAILED,
        message: 'Failed to connect to native host',
        details: detail,
      };
      logger.error('Native host connection failed', {
        hostName: this.hostName,
        error: detail,
      });
      this.notifyError(error);
      this.port = null;
      this.scheduleReconnect();
      return;
    }

    this.port.onMessage.addListener((message: unknown) => {
      this.handleMessage(message as NativeMessagingInboundMessage);
    });

    this.port.onDisconnect.addListener(() => {
      this.handleDisconnect();
    });

    this.connected = true;
    this.reconnectAttempts = 0;
    this.reconnecting = false;
    this.notifyStateChange(true);

    logger.info('Connected to native host', { hostName: this.hostName });
  }

  private handleMessage(message: NativeMessagingInboundMessage): void {
    logger.debug('Received message from native host');

    for (const handler of this.messageHandlers) {
      try {
        handler(message);
      } catch (err: unknown) {
        const detail = err instanceof Error ? err.message : String(err);
        logger.error('Message handler threw an error', { error: detail });
      }
    }
  }

  private handleDisconnect(): void {
    const lastError = chrome.runtime.lastError?.message;
    this.port = null;
    this.connected = false;
    this.notifyStateChange(false);

    if (lastError) {
      logger.warn('Native host disconnected with error', {
        hostName: this.hostName,
        error: lastError,
      });
    } else {
      logger.info('Native host disconnected', { hostName: this.hostName });
    }

    if (!this.intentionalDisconnect) {
      const error: NativeMessagingError = {
        code: ErrorCode.CONNECTION_FAILED,
        message: 'Native host connection lost',
        details: lastError,
      };
      this.notifyError(error);
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.intentionalDisconnect || this.reconnecting) {
      return;
    }

    if (this.reconnectAttempts >= MAX_RETRY_COUNT) {
      logger.error('Max reconnection attempts reached', {
        hostName: this.hostName,
        attempts: this.reconnectAttempts,
      });
      const error: NativeMessagingError = {
        code: ErrorCode.CONNECTION_FAILED,
        message: `Failed to reconnect after ${String(this.reconnectAttempts)} attempts`,
      };
      this.notifyError(error);
      return;
    }

    this.reconnecting = true;
    const delay = Math.min(
      MIN_RECONNECT_DELAY * Math.pow(RECONNECT_BACKOFF_FACTOR, this.reconnectAttempts),
      MAX_RECONNECT_DELAY,
    );
    this.reconnectAttempts++;

    logger.info('Scheduling reconnection', {
      hostName: this.hostName,
      attempt: this.reconnectAttempts,
      delayMs: delay,
    });

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.reconnecting = false;
      this.establishConnection();
    }, delay);
  }

  private cancelReconnect(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.reconnecting = false;
    this.reconnectAttempts = 0;
  }

  private notifyStateChange(connected: boolean): void {
    for (const handler of this.stateChangeHandlers) {
      try {
        handler(connected);
      } catch (err: unknown) {
        const detail = err instanceof Error ? err.message : String(err);
        logger.error('State change handler threw an error', { error: detail });
      }
    }
  }

  private notifyError(error: NativeMessagingError): void {
    for (const handler of this.errorHandlers) {
      try {
        handler(error);
      } catch (err: unknown) {
        const detail = err instanceof Error ? err.message : String(err);
        logger.error('Error handler threw an error', { error: detail });
      }
    }
  }
}

export type {
  ErrorHandler,
  MessageHandler,
  NativeMessagingError,
  NativeMessagingInboundMessage,
  NativeMessagingOutboundMessage,
  StateChangeHandler,
};
