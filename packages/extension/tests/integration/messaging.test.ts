import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { z } from 'zod';
import { chrome, resetChromeMocks } from '../__mocks__/chrome.js';

vi.stubGlobal('chrome', chrome);
vi.stubGlobal('crypto', { randomUUID: () => 'test-uuid-1234' });
vi.stubGlobal('performance', { now: vi.fn().mockReturnValue(0) });

vi.mock('../../src/infrastructure/logger.js', () => {
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

const { CommandRouter } = await import('../../src/background/command-router.js');
const { MessageBridge } = await import('../../src/content/message-bridge.js');

const NavigateSchema = z.object({ url: z.string().url() });

function createMessageBridge(): ReturnType<typeof MessageBridge.getInstance> {
  // Reset singleton so each test gets a fresh instance
  (MessageBridge as unknown as { instance: undefined }).instance = undefined;
  return MessageBridge.getInstance();
}

describe('Messaging pipeline integration', () => {
  let router: InstanceType<typeof CommandRouter>;
  let bridge: ReturnType<typeof MessageBridge.getInstance>;

  beforeEach(() => {
    resetChromeMocks();
    vi.useFakeTimers();

    router = new CommandRouter();
    bridge = createMessageBridge();
  });

  afterEach(() => {
    bridge.destroy();
    vi.useRealTimers();
  });

  /**
   * Wires the chrome.runtime.sendMessage mock to route messages through the
   * CommandRouter, simulating the service worker's onMessage listener.
   */
  function wireMessaging(): void {
    chrome.runtime.sendMessage.mockImplementation(
      (message: unknown, callback?: (response: unknown) => void) => {
        void router.route(message as Parameters<typeof router.route>[0]).then((response) => {
          callback?.(response);
        });
        return undefined;
      },
    );
  }

  describe('happy path round-trip', () => {
    it('should send message from content script, route through command router, and return correlated response', async () => {
      router.registerHandler('navigate', NavigateSchema, async (params) => {
        return { navigatedTo: params.url };
      });
      router.init();

      wireMessaging();
      bridge.init();

      const response = await bridge.sendToBackground('navigate', { url: 'https://example.com' });

      expect(response.id).toBe('test-uuid-1234');
      expect(response.success).toBe(true);
      expect(response.data).toEqual({ navigatedTo: 'https://example.com' });
      expect(response.metadata).toBeDefined();
    });

    it('should preserve correlation ID through the pipeline', async () => {
      router.registerHandler('navigate', NavigateSchema, async () => ({ ok: true }));
      router.init();

      wireMessaging();
      bridge.init();

      const response = await bridge.sendToBackground('navigate', { url: 'https://test.dev' });

      expect(response.id).toBe('test-uuid-1234');
    });
  });

  describe('error case: invalid command', () => {
    it('should return structured UNKNOWN_COMMAND error for unregistered command', async () => {
      router.init();

      wireMessaging();
      bridge.init();

      const response = await bridge.sendToBackground('navigate', { url: 'https://example.com' });

      expect(response.id).toBe('test-uuid-1234');
      expect(response.success).toBe(false);
      expect(response.error).toBeDefined();
      expect(response.error!.code).toBe('UNKNOWN_COMMAND');
      expect(response.error!.message).toContain('navigate');
    });

    it('should return structured INVALID_PARAMS error for invalid parameters', async () => {
      router.registerHandler('navigate', NavigateSchema, async () => ({ ok: true }));
      router.init();

      wireMessaging();
      bridge.init();

      const response = await bridge.sendToBackground('navigate', { url: 'not-a-valid-url' });

      expect(response.id).toBe('test-uuid-1234');
      expect(response.success).toBe(false);
      expect(response.error).toBeDefined();
      expect(response.error!.code).toBe('INVALID_PARAMS');
    });

    it('should return INTERNAL_ERROR when handler throws', async () => {
      router.registerHandler('navigate', NavigateSchema, async () => {
        throw new Error('handler exploded');
      });
      router.init();

      wireMessaging();
      bridge.init();

      const response = await bridge.sendToBackground('navigate', { url: 'https://example.com' });

      expect(response.success).toBe(false);
      expect(response.error!.code).toBe('INTERNAL_ERROR');
      expect(response.error!.message).toBe('handler exploded');
    });
  });

  describe('timeout case', () => {
    it('should reject with timeout error when service worker does not respond', async () => {
      chrome.runtime.sendMessage.mockImplementation(() => {
        // Simulate no callback invocation — message is never answered
        return undefined;
      });

      bridge.init();

      const responsePromise = bridge.sendToBackground('navigate', { url: 'https://example.com' }, 500);

      vi.advanceTimersByTime(501);

      await expect(responsePromise).rejects.toThrow(/timed out/i);
    });

    it('should not reject before timeout elapses', async () => {
      chrome.runtime.sendMessage.mockImplementation(() => undefined);

      bridge.init();

      const responsePromise = bridge.sendToBackground('navigate', { url: 'https://example.com' }, 1000);

      vi.advanceTimersByTime(500);

      let resolved = false;
      let rejected = false;
      void responsePromise.then(() => { resolved = true; }, () => { rejected = true; });

      await vi.advanceTimersByTimeAsync(0);

      expect(resolved).toBe(false);
      expect(rejected).toBe(false);

      vi.advanceTimersByTime(501);
      await expect(responsePromise).rejects.toThrow(/timed out/i);
    });
  });

  describe('chrome.runtime.lastError handling', () => {
    it('should reject when chrome.runtime.lastError is set', async () => {
      chrome.runtime.sendMessage.mockImplementation(
        (_message: unknown, callback?: (response: unknown) => void) => {
          chrome.runtime.lastError = { message: 'Extension context invalidated' };
          callback?.(undefined);
          chrome.runtime.lastError = null;
          return undefined;
        },
      );

      bridge.init();

      await expect(
        bridge.sendToBackground('navigate', { url: 'https://example.com' }),
      ).rejects.toThrow('Extension context invalidated');
    });
  });
});
