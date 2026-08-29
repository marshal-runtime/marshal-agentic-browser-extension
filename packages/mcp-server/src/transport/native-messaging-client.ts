/**
 * Native Messaging client for communication between the MCP server
 * and the Chrome extension via a native messaging host process.
 *
 * Uses `child_process.spawn` to launch the native messaging host and
 * communicates over stdin/stdout using the Chrome Native Messaging
 * protocol: each message is prefixed with a 4-byte little-endian
 * unsigned integer indicating the JSON payload length.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import {
  MAX_MESSAGE_SIZE,
  MAX_RETRY_COUNT,
  NATIVE_MESSAGING_HOST_ID,
  RETRY_DELAY,
} from '@agentic-browser/shared';

/** Minimum reconnect delay in milliseconds. */
const MIN_RECONNECT_DELAY = RETRY_DELAY;

/** Maximum reconnect delay in milliseconds (capped backoff). */
const MAX_RECONNECT_DELAY = 30_000;

/** Backoff multiplier for reconnection attempts. */
const RECONNECT_BACKOFF_FACTOR = 2;

/** Length of the Native Messaging header in bytes. */
const HEADER_LENGTH = 4;

/** Callback type for incoming messages from the native host. */
type MessageHandler = (message: unknown) => void;

/** Callback type for connection error events. */
type ErrorHandler = (error: NativeMessagingClientError) => void;

/** Callback type for connection state change events. */
type StateChangeHandler = (connected: boolean) => void;

/** Structured error for native messaging client failures. */
export interface NativeMessagingClientError {
  readonly code: string;
  readonly message: string;
  readonly details?: string;
}

/**
 * Client-side Native Messaging transport for the MCP server.
 *
 * Spawns the native messaging host process and communicates over
 * stdin/stdout using the Chrome Native Messaging wire protocol
 * (4-byte LE length prefix + JSON payload). Supports automatic
 * reconnection with exponential backoff when the host process
 * exits unexpectedly.
 */
export class NativeMessagingClient {
  private process: ChildProcess | null = null;
  private readonly hostPath: string;
  private readonly hostArgs: readonly string[];
  private connected = false;
  private reconnecting = false;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private intentionalDisconnect = false;
  private readBuffer: Buffer = Buffer.alloc(0);

  private readonly messageHandlers: Set<MessageHandler> = new Set();
  private readonly errorHandlers: Set<ErrorHandler> = new Set();
  private readonly stateChangeHandlers: Set<StateChangeHandler> = new Set();

  /**
   * Creates a new NativeMessagingClient instance.
   *
   * @param hostPath - Path to the native messaging host executable.
   *   Defaults to `com.agentic_browser.mcp_host`.
   * @param hostArgs - Arguments to pass to the host process.
   */
  constructor(hostPath?: string, hostArgs?: readonly string[]) {
    this.hostPath = hostPath ?? NATIVE_MESSAGING_HOST_ID;
    this.hostArgs = hostArgs ?? [];
  }

  /**
   * Spawns the native messaging host process and establishes
   * communication over stdin/stdout.
   *
   * If already connected, this method is a no-op.
   */
  connect(): void {
    if (this.connected && this.process) {
      return;
    }

    this.intentionalDisconnect = false;
    this.establishConnection();
  }

  /**
   * Terminates the native messaging host process and cleans up
   * resources.
   *
   * Cancels any pending reconnection attempts. If not connected,
   * this method is a no-op.
   */
  disconnect(): void {
    this.intentionalDisconnect = true;
    this.cancelReconnect();

    if (this.process) {
      this.process.kill();
      this.process = null;
    }

    this.readBuffer = Buffer.alloc(0);

    if (this.connected) {
      this.connected = false;
      this.notifyStateChange(false);
    }
  }

  /**
   * Sends a JSON message to the native messaging host.
   *
   * Serializes the message to JSON and writes it to the host's stdin
   * with a 4-byte little-endian length prefix per the Native Messaging
   * protocol.
   *
   * @param message - The object to send as a JSON message.
   * @throws When not connected or when the message exceeds the size limit.
   */
  send(message: object): void {
    if (!this.connected || !this.process?.stdin) {
      const error: NativeMessagingClientError = {
        code: 'NOT_CONNECTED',
        message: 'Cannot send message: not connected to native host',
      };
      this.notifyError(error);
      throw new Error(error.message);
    }

    const json = JSON.stringify(message);
    const payload = Buffer.from(json, 'utf-8');

    if (payload.byteLength > MAX_MESSAGE_SIZE) {
      const error: NativeMessagingClientError = {
        code: 'MESSAGE_TOO_LARGE',
        message: `Message exceeds maximum size of ${String(MAX_MESSAGE_SIZE)} bytes`,
        details: `Actual size: ${String(payload.byteLength)} bytes`,
      };
      this.notifyError(error);
      throw new Error(error.message);
    }

    const header = Buffer.alloc(HEADER_LENGTH);
    header.writeUInt32LE(payload.byteLength, 0);

    this.process.stdin.write(header);
    this.process.stdin.write(payload);
  }

  /**
   * Registers a handler for incoming messages from the native host.
   *
   * @param callback - Callback invoked with each received message object.
   * @returns A dispose function that removes the handler.
   */
  onMessage(callback: MessageHandler): () => void {
    this.messageHandlers.add(callback);
    return () => {
      this.messageHandlers.delete(callback);
    };
  }

  /**
   * Registers a handler for connection errors.
   *
   * @param handler - Callback invoked with a {@link NativeMessagingClientError}.
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

  /** Returns whether the client is currently connected to the host. */
  isConnected(): boolean {
    return this.connected;
  }

  private establishConnection(): void {
    try {
      this.process = spawn(this.hostPath, [...this.hostArgs], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err: unknown) {
      const detail = err instanceof Error ? err.message : String(err);
      const error: NativeMessagingClientError = {
        code: 'CONNECTION_FAILED',
        message: 'Failed to spawn native messaging host',
        details: detail,
      };
      this.notifyError(error);
      this.scheduleReconnect();
      return;
    }

    this.process.on('error', (err: Error) => {
      const error: NativeMessagingClientError = {
        code: 'CONNECTION_FAILED',
        message: 'Native messaging host process error',
        details: err.message,
      };
      this.notifyError(error);
    });

    this.process.on('exit', (code: number | null, signal: string | null) => {
      this.handleProcessExit(code, signal);
    });

    if (this.process.stdout) {
      this.process.stdout.on('data', (chunk: Buffer) => {
        this.handleData(chunk);
      });
    }

    if (this.process.stderr) {
      this.process.stderr.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf-8').trim();
        if (text) {
          const error: NativeMessagingClientError = {
            code: 'HOST_STDERR',
            message: 'Native host wrote to stderr',
            details: text,
          };
          this.notifyError(error);
        }
      });
    }

    this.connected = true;
    this.reconnectAttempts = 0;
    this.reconnecting = false;
    this.readBuffer = Buffer.alloc(0);
    this.notifyStateChange(true);
  }

  private handleData(chunk: Buffer): void {
    this.readBuffer = Buffer.concat([this.readBuffer, chunk]);

    while (this.readBuffer.byteLength >= HEADER_LENGTH) {
      const messageLength = this.readBuffer.readUInt32LE(0);

      if (messageLength > MAX_MESSAGE_SIZE) {
        const error: NativeMessagingClientError = {
          code: 'MESSAGE_TOO_LARGE',
          message: `Incoming message exceeds maximum size of ${String(MAX_MESSAGE_SIZE)} bytes`,
          details: `Declared size: ${String(messageLength)} bytes`,
        };
        this.notifyError(error);
        this.readBuffer = Buffer.alloc(0);
        return;
      }

      const totalLength = HEADER_LENGTH + messageLength;

      if (this.readBuffer.byteLength < totalLength) {
        break;
      }

      const jsonBytes = this.readBuffer.subarray(HEADER_LENGTH, totalLength);
      this.readBuffer = this.readBuffer.subarray(totalLength);

      let parsed: unknown;
      try {
        parsed = JSON.parse(jsonBytes.toString('utf-8')) as unknown;
      } catch (err: unknown) {
        const detail = err instanceof Error ? err.message : String(err);
        const error: NativeMessagingClientError = {
          code: 'PARSE_ERROR',
          message: 'Failed to parse incoming message',
          details: detail,
        };
        this.notifyError(error);
        continue;
      }

      this.dispatchMessage(parsed);
    }
  }

  private dispatchMessage(message: unknown): void {
    for (const handler of this.messageHandlers) {
      try {
        handler(message);
      } catch (err: unknown) {
        const detail = err instanceof Error ? err.message : String(err);
        const error: NativeMessagingClientError = {
          code: 'HANDLER_ERROR',
          message: 'Message handler threw an error',
          details: detail,
        };
        this.notifyError(error);
      }
    }
  }

  private handleProcessExit(code: number | null, signal: string | null): void {
    this.process = null;
    this.connected = false;
    this.readBuffer = Buffer.alloc(0);
    this.notifyStateChange(false);

    if (!this.intentionalDisconnect) {
      const details = signal
        ? `Process killed by signal ${signal}`
        : `Process exited with code ${String(code)}`;
      const error: NativeMessagingClientError = {
        code: 'CONNECTION_FAILED',
        message: 'Native messaging host process exited unexpectedly',
        details,
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
      const error: NativeMessagingClientError = {
        code: 'CONNECTION_FAILED',
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

  private notifyStateChange(stateConnected: boolean): void {
    for (const handler of this.stateChangeHandlers) {
      try {
        handler(stateConnected);
      } catch (err: unknown) {
        const detail = err instanceof Error ? err.message : String(err);
        const notifyError: NativeMessagingClientError = {
          code: 'HANDLER_ERROR',
          message: 'State change handler threw an error',
          details: detail,
        };
        this.notifyError(notifyError);
      }
    }
  }

  private notifyError(error: NativeMessagingClientError): void {
    for (const handler of this.errorHandlers) {
      try {
        handler(error);
      } catch {
        // Prevent infinite recursion from error handler failures
      }
    }
  }
}

export type { MessageHandler, ErrorHandler, StateChangeHandler };
