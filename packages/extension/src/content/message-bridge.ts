/**
 * Bidirectional message bridge between content scripts and the service worker.
 *
 * Provides typed request/response communication over `chrome.runtime` messaging
 * with correlation IDs and configurable timeout handling.
 */

import type { CommandRequest, CommandResponse } from '@agentic-browser/shared';
import { DEFAULT_TIMEOUT } from '@agentic-browser/shared';
import { Logger } from '../infrastructure/logger.js';

const logger = Logger.getInstance();

/** Handler function invoked when an incoming message is received from the service worker. */
type MessageHandler = (
  message: CommandRequest,
  sender: chrome.runtime.MessageSender,
) => Promise<CommandResponse> | CommandResponse;

/** Tracks a pending outbound request awaiting a response from the service worker. */
interface PendingRequest {
  readonly resolve: (response: CommandResponse) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

/**
 * Message bridge for content-script ↔ service-worker communication.
 *
 * Uses `chrome.runtime.sendMessage` for outbound messages (CS → SW) and
 * `chrome.runtime.onMessage` for inbound messages (SW → CS). Each outbound
 * request is assigned a unique ID for response correlation, with automatic
 * timeout rejection for unanswered messages.
 */
class MessageBridge {
  private static instance: MessageBridge | undefined;

  private readonly pending = new Map<string, PendingRequest>();
  private readonly handlers: MessageHandler[] = [];
  private initialized = false;

  private constructor() {}

  /** Returns the singleton MessageBridge instance. */
  static getInstance(): MessageBridge {
    if (!MessageBridge.instance) {
      MessageBridge.instance = new MessageBridge();
    }
    return MessageBridge.instance;
  }

  /**
   * Initializes the message bridge by registering the `chrome.runtime.onMessage` listener.
   *
   * Safe to call multiple times — subsequent calls are no-ops.
   */
  init(): void {
    if (this.initialized) {
      return;
    }

    chrome.runtime.onMessage.addListener(
      (
        message: unknown,
        sender: chrome.runtime.MessageSender,
        sendResponse: (response?: unknown) => void,
      ): boolean => {
        this.handleIncoming(message, sender, sendResponse);
        return true;
      },
    );

    this.initialized = true;
    logger.debug('MessageBridge initialized');
  }

  /**
   * Sends a command request to the service worker and waits for a correlated response.
   *
   * @param command - The command name to invoke.
   * @param params - Parameters for the command.
   * @param timeout - Maximum time in milliseconds to wait for a response.
   * @returns The correlated command response from the service worker.
   * @throws If the request times out or the runtime reports an error.
   */
  sendToBackground(
    command: CommandRequest['command'],
    params: CommandRequest['params'],
    timeout: number = DEFAULT_TIMEOUT,
  ): Promise<CommandResponse> {
    const id = crypto.randomUUID();
    const request: CommandRequest = {
      id,
      command,
      params,
      timestamp: Date.now(),
    };

    return new Promise<CommandResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        logger.warn('Message timed out', { id, command, timeout });
        reject(new Error(`Message ${id} timed out after ${String(timeout)}ms`));
      }, timeout);

      this.pending.set(id, { resolve, reject, timer });

      chrome.runtime.sendMessage(request, (response: unknown) => {
        const runtimeError = chrome.runtime.lastError;
        if (runtimeError) {
          this.resolvePending(id, undefined, new Error(runtimeError.message));
          return;
        }

        if (isCommandResponse(response)) {
          this.resolvePending(id, response);
        }
      });
    });
  }

  /**
   * Registers a handler for incoming messages from the service worker.
   *
   * Handlers are invoked in registration order. The first handler to return a
   * response wins; subsequent handlers are not called for that message.
   *
   * @param handler - Callback invoked with the incoming request and sender info.
   */
  onMessage(handler: MessageHandler): void {
    this.handlers.push(handler);
  }

  /**
   * Removes all registered message handlers and cleans up pending requests.
   *
   * Does not remove the `chrome.runtime.onMessage` listener since Chrome does
   * not support removing individual listeners by reference in content scripts.
   */
  destroy(): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error('MessageBridge destroyed'));
      this.pending.delete(id);
    }
    this.handlers.length = 0;
    logger.debug('MessageBridge destroyed');
  }

  /**
   * Resolves or rejects a pending outbound request by correlation ID.
   *
   * @param id - The message correlation ID.
   * @param response - The response received, if successful.
   * @param error - The error, if the request failed.
   */
  private resolvePending(id: string, response?: CommandResponse, error?: Error): void {
    const pending = this.pending.get(id);
    if (!pending) {
      return;
    }

    clearTimeout(pending.timer);
    this.pending.delete(id);

    if (error) {
      logger.warn('Message failed', { id, error: error.message });
      pending.reject(error);
    } else if (response) {
      logger.debug('Message response received', { id, success: response.success });
      pending.resolve(response);
    }
  }

  /**
   * Handles an incoming message from the service worker.
   *
   * If the message is a correlated response to a pending outbound request, it
   * resolves that request. Otherwise, it dispatches to registered handlers.
   */
  private handleIncoming(
    message: unknown,
    sender: chrome.runtime.MessageSender,
    sendResponse: (response?: unknown) => void,
  ): void {
    if (isCommandResponse(message)) {
      const pending = this.pending.get(message.id);
      if (pending) {
        this.resolvePending(message.id, message);
        return;
      }
    }

    if (isCommandRequest(message)) {
      this.dispatchToHandlers(message, sender, sendResponse);
    }
  }

  /**
   * Dispatches an incoming request to registered handlers.
   *
   * The first handler to produce a response sends it back via `sendResponse`.
   */
  private dispatchToHandlers(
    request: CommandRequest,
    sender: chrome.runtime.MessageSender,
    sendResponse: (response?: unknown) => void,
  ): void {
    if (this.handlers.length === 0) {
      sendResponse({ id: request.id, success: false, error: { code: 'NO_HANDLER', message: 'No handler registered' } });
      return;
    }

    const tryHandler = async (): Promise<void> => {
      for (const handler of this.handlers) {
        try {
          const response = await handler(request, sender);
          sendResponse(response);
          return;
        } catch (error: unknown) {
          logger.warn('Handler threw an error', { id: request.id, error: String(error) });
        }
      }

      sendResponse({
        id: request.id,
        success: false,
        error: { code: 'HANDLER_FAILED', message: 'All handlers failed' },
      });
    };

    void tryHandler();
  }
}

/**
 * Type guard that checks whether a value conforms to {@link CommandRequest}.
 *
 * @param value - The value to check.
 * @returns `true` if the value has the shape of a CommandRequest.
 */
function isCommandRequest(value: unknown): value is CommandRequest {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const obj = value as Record<string, unknown>;
  return (
    typeof obj['id'] === 'string' &&
    typeof obj['command'] === 'string' &&
    typeof obj['params'] === 'object' &&
    obj['params'] !== null &&
    typeof obj['timestamp'] === 'number'
  );
}

/**
 * Type guard that checks whether a value conforms to {@link CommandResponse}.
 *
 * @param value - The value to check.
 * @returns `true` if the value has the shape of a CommandResponse.
 */
function isCommandResponse(value: unknown): value is CommandResponse {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const obj = value as Record<string, unknown>;
  return typeof obj['id'] === 'string' && typeof obj['success'] === 'boolean';
}

/** Singleton message bridge instance. */
const messageBridge = MessageBridge.getInstance();

export { MessageBridge, messageBridge };
export type { MessageHandler, PendingRequest };
