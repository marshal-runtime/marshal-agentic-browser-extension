import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ToolExecutor } from '../../tools/tool-executor.js';
import type { NativeMessagingClient } from '../../transport/native-messaging-client.js';

describe('MCP E2E: browser_navigate flow', () => {
  let mockClient: {
    onMessage: ReturnType<typeof vi.fn>;
    send: ReturnType<typeof vi.fn>;
  };
  let executor: ToolExecutor;

  beforeEach(() => {
    mockClient = {
      onMessage: vi.fn(),
      send: vi.fn(),
    };
    executor = new ToolExecutor(mockClient as unknown as NativeMessagingClient, 5000);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should execute browser_navigate and return success from mock NM response', async () => {
    mockClient.onMessage.mockImplementation((callback: (msg: unknown) => void) => {
      setTimeout(() => {
        const sentRequest = mockClient.send.mock.calls[0]![0] as { id: string };
        callback({
          id: sentRequest.id,
          success: true,
          data: {
            url: 'https://example.com',
            title: 'Example Domain',
            status: 200,
          },
          metadata: {
            duration: 250,
            timestamp: Date.now(),
          },
        });
      }, 10);
      return vi.fn();
    });

    const result = await executor.execute('browser_navigate', {
      url: 'https://example.com',
    });

    expect(result.success).toBe(true);
    expect(result.data).toEqual({
      url: 'https://example.com',
      title: 'Example Domain',
      status: 200,
    });
    expect(result.metadata).toBeDefined();
    expect(result.metadata!.duration).toBe(250);

    expect(mockClient.send).toHaveBeenCalledTimes(1);
    const sentCommand = mockClient.send.mock.calls[0]![0] as {
      id: string;
      command: string;
      params: Record<string, unknown>;
      timestamp: number;
    };
    expect(sentCommand.command).toBe('navigate');
    expect(sentCommand.params).toEqual({ url: 'https://example.com' });
    expect(sentCommand.id).toBeDefined();
    expect(sentCommand.timestamp).toBeDefined();
  });

  it('should return error result when NM responds with failure', async () => {
    mockClient.onMessage.mockImplementation((callback: (msg: unknown) => void) => {
      setTimeout(() => {
        const sentRequest = mockClient.send.mock.calls[0]![0] as { id: string };
        callback({
          id: sentRequest.id,
          success: false,
          error: {
            code: 'NAVIGATION_FAILED',
            message: 'ERR_NAME_NOT_RESOLVED',
          },
        });
      }, 10);
      return vi.fn();
    });

    const result = await executor.execute('browser_navigate', {
      url: 'https://nonexistent.invalid',
    });

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error!.code).toBe('NAVIGATION_FAILED');
    expect(result.error!.message).toBe('ERR_NAME_NOT_RESOLVED');
    expect(result.data).toBeUndefined();
  });

  it('should handle timeout when NM does not respond', async () => {
    vi.useFakeTimers();

    mockClient.onMessage.mockReturnValue(vi.fn());

    const promise = executor.execute('browser_navigate', {
      url: 'https://example.com',
    });

    await vi.advanceTimersByTimeAsync(5100);
    const result = await promise;

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('TIMEOUT');

    vi.useRealTimers();
  });

  it('should reject when NM client fails to send', async () => {
    mockClient.onMessage.mockReturnValue(vi.fn());
    mockClient.send.mockImplementation(() => {
      throw new Error('Native messaging host not connected');
    });

    await expect(
      executor.execute('browser_navigate', { url: 'https://example.com' }),
    ).rejects.toThrow('Failed to send command');
  });

  it('should reject unknown tool names before sending to NM', async () => {
    await expect(executor.execute('browser_unknown', {})).rejects.toThrow(
      'Unknown tool',
    );

    expect(mockClient.send).not.toHaveBeenCalled();
  });

  it('should reject missing required parameters before sending to NM', async () => {
    await expect(executor.execute('browser_navigate', {})).rejects.toThrow(
      'Missing required parameters',
    );

    expect(mockClient.send).not.toHaveBeenCalled();
  });

  it('should handle multiple sequential tool executions', async () => {
    let callCount = 0;
    mockClient.onMessage.mockImplementation((callback: (msg: unknown) => void) => {
      const currentCall = callCount++;
      setTimeout(() => {
        const sentRequest = mockClient.send.mock.calls[currentCall]![0] as { id: string };
        callback({
          id: sentRequest.id,
          success: true,
          data: { step: currentCall },
        });
      }, 10);
      return vi.fn();
    });

    const result1 = await executor.execute('browser_navigate', {
      url: 'https://example.com',
    });
    const result2 = await executor.execute('browser_click', {
      selector: '#button',
    });

    expect(result1.success).toBe(true);
    expect((result1.data as { step: number }).step).toBe(0);
    expect(result2.success).toBe(true);
    expect((result2.data as { step: number }).step).toBe(1);

    expect(mockClient.send).toHaveBeenCalledTimes(2);
    const cmd1 = mockClient.send.mock.calls[0]![0] as { command: string };
    const cmd2 = mockClient.send.mock.calls[1]![0] as { command: string };
    expect(cmd1.command).toBe('navigate');
    expect(cmd2.command).toBe('click');
  });
});
