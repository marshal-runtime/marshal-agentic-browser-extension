import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ChildProcess } from 'node:child_process';
import type { Writable, Readable } from 'node:stream';
import { EventEmitter } from 'node:events';

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}));

import { spawn } from 'node:child_process';
import { NativeMessagingClient } from '../../transport/native-messaging-client.js';

const mockedSpawn = vi.mocked(spawn);

function createMockProcess(): ChildProcess {
  const proc = new EventEmitter() as ChildProcess;
  const stdinEmitter = new EventEmitter();
  (stdinEmitter as Writable & { write: ReturnType<typeof vi.fn> }).write = vi
    .fn()
    .mockReturnValue(true);
  proc.stdin = stdinEmitter as unknown as Writable;

  const stdoutEmitter = new EventEmitter();
  proc.stdout = stdoutEmitter as unknown as Readable;

  const stderrEmitter = new EventEmitter();
  proc.stderr = stderrEmitter as unknown as Readable;

  proc.kill = vi.fn().mockReturnValue(true);

  return proc;
}

function encodeNativeMessage(message: object): Buffer {
  const json = JSON.stringify(message);
  const payload = Buffer.from(json, 'utf-8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(payload.byteLength, 0);
  return Buffer.concat([header, payload]);
}

describe('NativeMessagingClient', () => {
  let client: NativeMessagingClient;
  let mockProc: ChildProcess;

  beforeEach(() => {
    vi.useFakeTimers();
    mockProc = createMockProcess();
    mockedSpawn.mockReturnValue(mockProc);
    client = new NativeMessagingClient('/test/host');
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('connect', () => {
    it('should spawn the host process', () => {
      client.connect();

      expect(mockedSpawn).toHaveBeenCalledWith('/test/host', [], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      expect(client.isConnected()).toBe(true);
    });

    it('should be a no-op if already connected', () => {
      client.connect();
      client.connect();

      expect(mockedSpawn).toHaveBeenCalledTimes(1);
    });

    it('should notify state change handlers on connect', () => {
      const handler = vi.fn();
      client.onStateChange(handler);

      client.connect();

      expect(handler).toHaveBeenCalledWith(true);
    });

    it('should handle spawn failure', () => {
      mockedSpawn.mockImplementation(() => {
        throw new Error('ENOENT');
      });

      const errorHandler = vi.fn();
      client.onError(errorHandler);
      client.connect();

      expect(client.isConnected()).toBe(false);
      expect(errorHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          code: 'CONNECTION_FAILED',
          message: 'Failed to spawn native messaging host',
        }),
      );
    });

    it('should use default host path when none provided', () => {
      const defaultClient = new NativeMessagingClient();
      defaultClient.connect();

      expect(mockedSpawn).toHaveBeenCalledWith(
        'com.agentic_browser.mcp_host',
        [],
        expect.any(Object),
      );
    });
  });

  describe('disconnect', () => {
    it('should kill the process', () => {
      client.connect();
      client.disconnect();

      expect(mockProc.kill).toHaveBeenCalled();
      expect(client.isConnected()).toBe(false);
    });

    it('should notify state change on disconnect', () => {
      const handler = vi.fn();
      client.onStateChange(handler);

      client.connect();
      handler.mockClear();

      client.disconnect();

      expect(handler).toHaveBeenCalledWith(false);
    });

    it('should be a no-op if not connected', () => {
      client.disconnect();

      expect(client.isConnected()).toBe(false);
    });

    it('should cancel pending reconnection attempts', () => {
      client.connect();
      mockProc.emit('exit', 1, null);

      client.disconnect();

      vi.advanceTimersByTime(60_000);
      expect(mockedSpawn).toHaveBeenCalledTimes(1);
    });
  });

  describe('send', () => {
    it('should write 4-byte LE header followed by JSON payload', () => {
      client.connect();

      const message = { command: 'navigate', params: { url: 'https://example.com' } };
      client.send(message);

      const stdin = mockProc.stdin as unknown as { write: ReturnType<typeof vi.fn> };
      expect(stdin.write).toHaveBeenCalledTimes(2);

      const headerArg = stdin.write.mock.calls[0]![0] as Buffer;
      expect(headerArg.byteLength).toBe(4);

      const json = JSON.stringify(message);
      const expectedLength = Buffer.from(json, 'utf-8').byteLength;
      expect(headerArg.readUInt32LE(0)).toBe(expectedLength);

      const payloadArg = stdin.write.mock.calls[1]![0] as Buffer;
      expect(payloadArg.toString('utf-8')).toBe(json);
    });

    it('should throw when not connected', () => {
      expect(() => {
        client.send({ test: true });
      }).toThrow('not connected');
    });

    it('should throw when message exceeds max size', () => {
      client.connect();

      const largeMessage = { data: 'x'.repeat(1_024 * 1_024 + 1) };
      expect(() => {
        client.send(largeMessage);
      }).toThrow('exceeds maximum size');
    });

    it('should notify error handler when not connected', () => {
      const errorHandler = vi.fn();
      client.onError(errorHandler);

      expect(() => {
        client.send({ test: true });
      }).toThrow();

      expect(errorHandler).toHaveBeenCalledWith(expect.objectContaining({ code: 'NOT_CONNECTED' }));
    });
  });

  describe('receive', () => {
    it('should parse 4-byte LE header + JSON message', () => {
      const handler = vi.fn();
      client.onMessage(handler);
      client.connect();

      const message = { id: '123', success: true, data: { url: 'https://example.com' } };
      const encoded = encodeNativeMessage(message);
      mockProc.stdout!.emit('data', encoded);

      expect(handler).toHaveBeenCalledWith(message);
    });

    it('should handle fragmented messages', () => {
      const handler = vi.fn();
      client.onMessage(handler);
      client.connect();

      const message = { id: '456', success: true };
      const encoded = encodeNativeMessage(message);

      mockProc.stdout!.emit('data', encoded.subarray(0, 3));
      expect(handler).not.toHaveBeenCalled();

      mockProc.stdout!.emit('data', encoded.subarray(3));
      expect(handler).toHaveBeenCalledWith(message);
    });

    it('should handle multiple messages in a single chunk', () => {
      const handler = vi.fn();
      client.onMessage(handler);
      client.connect();

      const msg1 = { id: '1', success: true };
      const msg2 = { id: '2', success: false };
      const combined = Buffer.concat([encodeNativeMessage(msg1), encodeNativeMessage(msg2)]);

      mockProc.stdout!.emit('data', combined);

      expect(handler).toHaveBeenCalledTimes(2);
      expect(handler).toHaveBeenCalledWith(msg1);
      expect(handler).toHaveBeenCalledWith(msg2);
    });

    it('should handle invalid JSON gracefully', () => {
      const messageHandler = vi.fn();
      const errorHandler = vi.fn();
      client.onMessage(messageHandler);
      client.onError(errorHandler);
      client.connect();

      const badPayload = Buffer.from('not json!!!', 'utf-8');
      const header = Buffer.alloc(4);
      header.writeUInt32LE(badPayload.byteLength, 0);
      mockProc.stdout!.emit('data', Buffer.concat([header, badPayload]));

      expect(messageHandler).not.toHaveBeenCalled();
      expect(errorHandler).toHaveBeenCalledWith(expect.objectContaining({ code: 'PARSE_ERROR' }));
    });

    it('should handle oversized message declaration', () => {
      const errorHandler = vi.fn();
      client.onError(errorHandler);
      client.connect();

      const header = Buffer.alloc(4);
      header.writeUInt32LE(2_000_000, 0);
      mockProc.stdout!.emit('data', header);

      expect(errorHandler).toHaveBeenCalledWith(
        expect.objectContaining({ code: 'MESSAGE_TOO_LARGE' }),
      );
    });
  });

  describe('onMessage dispose', () => {
    it('should remove handler when dispose is called', () => {
      const handler = vi.fn();
      const dispose = client.onMessage(handler);
      client.connect();

      dispose();

      const encoded = encodeNativeMessage({ id: '1', success: true });
      mockProc.stdout!.emit('data', encoded);

      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe('error handling', () => {
    it('should notify error handlers on process error event', () => {
      const errorHandler = vi.fn();
      client.onError(errorHandler);
      client.connect();

      mockProc.emit('error', new Error('process crashed'));

      expect(errorHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          code: 'CONNECTION_FAILED',
          details: 'process crashed',
        }),
      );
    });

    it('should notify error handlers on stderr output', () => {
      const errorHandler = vi.fn();
      client.onError(errorHandler);
      client.connect();

      mockProc.stderr!.emit('data', Buffer.from('some error output'));

      expect(errorHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          code: 'HOST_STDERR',
          details: 'some error output',
        }),
      );
    });

    it('should handle message handler errors gracefully', () => {
      const errorHandler = vi.fn();
      client.onError(errorHandler);
      client.onMessage(() => {
        throw new Error('handler boom');
      });
      client.connect();

      const encoded = encodeNativeMessage({ id: '1', success: true });
      mockProc.stdout!.emit('data', encoded);

      expect(errorHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          code: 'HANDLER_ERROR',
          details: 'handler boom',
        }),
      );
    });
  });

  describe('reconnection', () => {
    it('should attempt reconnection on unexpected exit', () => {
      client.connect();
      mockedSpawn.mockClear();

      const newProc = createMockProcess();
      mockedSpawn.mockReturnValue(newProc);

      mockProc.emit('exit', 1, null);

      vi.advanceTimersByTime(1_500);

      expect(mockedSpawn).toHaveBeenCalledTimes(1);
    });

    it('should not reconnect on intentional disconnect', () => {
      client.connect();
      client.disconnect();
      mockedSpawn.mockClear();

      vi.advanceTimersByTime(60_000);

      expect(mockedSpawn).not.toHaveBeenCalled();
    });

    it('should stop reconnecting after max attempts', () => {
      const errorHandler = vi.fn();
      client.onError(errorHandler);
      client.connect();

      // After initial connect, make spawn fail so reconnectAttempts accumulates
      mockedSpawn.mockImplementation(() => {
        throw new Error('ENOENT');
      });

      // Trigger unexpected exit — scheduleReconnect sets attempt 0, timer
      mockProc.emit('exit', 1, null);

      // Each timer fires → establishConnection → spawn throws → scheduleReconnect
      // Attempt 0: timer fires at 1000ms, spawn fails, scheduleReconnect (now attempt 1)
      vi.advanceTimersByTime(1_500);
      // Attempt 1: timer fires at 2000ms, spawn fails, scheduleReconnect (now attempt 2)
      vi.advanceTimersByTime(2_500);
      // Attempt 2: timer fires at 4000ms, spawn fails, scheduleReconnect (now attempt 3 >= MAX_RETRY_COUNT)
      vi.advanceTimersByTime(5_000);

      const hasFailedToReconnect = errorHandler.mock.calls.some(
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
        (call) => String(call[0]?.message).includes('Failed to reconnect'),
      );
      expect(hasFailedToReconnect).toBe(true);
    });

    it('should use exponential backoff for reconnection', () => {
      client.connect();

      mockProc.emit('exit', 1, null);
      mockedSpawn.mockClear();

      const newProc = createMockProcess();
      mockedSpawn.mockReturnValue(newProc);

      // First reconnect should happen after RETRY_DELAY (1000ms)
      vi.advanceTimersByTime(500);
      expect(mockedSpawn).not.toHaveBeenCalled();

      vi.advanceTimersByTime(600);
      expect(mockedSpawn).toHaveBeenCalledTimes(1);
    });
  });

  describe('onStateChange dispose', () => {
    it('should remove state change handler when dispose is called', () => {
      const handler = vi.fn();
      const dispose = client.onStateChange(handler);

      dispose();
      client.connect();

      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe('onError dispose', () => {
    it('should remove error handler when dispose is called', () => {
      const handler = vi.fn();
      const dispose = client.onError(handler);

      dispose();

      expect(() => {
        client.send({ test: true });
      }).toThrow();
      expect(handler).not.toHaveBeenCalled();
    });
  });
});
