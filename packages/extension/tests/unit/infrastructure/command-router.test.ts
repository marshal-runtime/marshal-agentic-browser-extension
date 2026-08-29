import { describe, it, expect, vi, beforeEach } from 'vitest';
import { z } from 'zod';
import { chrome, resetChromeMocks } from '../../__mocks__/chrome.js';

vi.stubGlobal('chrome', chrome);
vi.stubGlobal('performance', { now: vi.fn().mockReturnValue(0) });

vi.mock('../../../src/infrastructure/logger.js', () => {
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

const { CommandRouter } = await import('../../../src/background/command-router.js');

const TestParamsSchema = z.object({
  url: z.string().url(),
});

function makeRequest(overrides: Record<string, unknown> = {}) {
  return {
    id: 'req-1',
    command: 'navigate' as const,
    params: { url: 'https://example.com' },
    timestamp: Date.now(),
    ...overrides,
  };
}

describe('CommandRouter', () => {
  let router: InstanceType<typeof CommandRouter>;

  beforeEach(() => {
    resetChromeMocks();
    router = new CommandRouter();
  });

  describe('registerHandler', () => {
    it('should register a handler for a command', () => {
      router.registerHandler('navigate', TestParamsSchema, async () => ({}));

      expect(router.handlerCount()).toBe(1);
    });

    it('should overwrite existing handler for same command', () => {
      router.registerHandler('navigate', TestParamsSchema, async () => 'first');
      router.registerHandler('navigate', TestParamsSchema, async () => 'second');

      expect(router.handlerCount()).toBe(1);
    });
  });

  describe('init', () => {
    it('should mark router as initialized', () => {
      router.init();

      expect(router.isInitialized()).toBe(true);
    });

    it('should start as not initialized', () => {
      expect(router.isInitialized()).toBe(false);
    });
  });

  describe('route', () => {
    it('should route valid command to handler and return success', async () => {
      router.registerHandler('navigate', TestParamsSchema, async (params) => {
        return { navigatedTo: params.url };
      });

      const response = await router.route(makeRequest());

      expect(response.success).toBe(true);
      expect(response.id).toBe('req-1');
      expect(response.data).toEqual({ navigatedTo: 'https://example.com' });
      expect(response.metadata).toBeDefined();
    });

    it('should return UNKNOWN_COMMAND for unregistered command', async () => {
      const response = await router.route(makeRequest());

      expect(response.success).toBe(false);
      expect(response.error).toBeDefined();
      expect(response.error!.code).toBe('UNKNOWN_COMMAND');
    });

    it('should return INVALID_PARAMS when params fail schema validation', async () => {
      router.registerHandler('navigate', TestParamsSchema, async () => ({}));

      const response = await router.route(makeRequest({ params: { url: 'not-a-url' } }));

      expect(response.success).toBe(false);
      expect(response.error!.code).toBe('INVALID_PARAMS');
      expect(response.error!.details).toBeDefined();
    });

    it('should return INVALID_PARAMS for invalid envelope', async () => {
      const response = await router.route({
        id: 'invalid-request',
        command: 'not-a-command',
        params: {},
        timestamp: Date.now(),
      });

      expect(response.success).toBe(false);
      expect(response.id).toBe('invalid-request');
      expect(response.error!.code).toBe('INVALID_PARAMS');
    });

    it('should return INTERNAL_ERROR when handler throws', async () => {
      router.registerHandler('navigate', TestParamsSchema, async () => {
        throw new Error('handler crashed');
      });

      const response = await router.route(makeRequest());

      expect(response.success).toBe(false);
      expect(response.error!.code).toBe('INTERNAL_ERROR');
      expect(response.error!.message).toBe('handler crashed');
    });

    it('should return INTERNAL_ERROR with string for non-Error throws', async () => {
      router.registerHandler('navigate', TestParamsSchema, async () => {
        throw 'string error';
      });

      const response = await router.route(makeRequest());

      expect(response.success).toBe(false);
      expect(response.error!.code).toBe('INTERNAL_ERROR');
      expect(response.error!.message).toBe('string error');
    });

    it('should include metadata with duration and timestamp', async () => {
      router.registerHandler('navigate', TestParamsSchema, async () => ({}));

      const response = await router.route(makeRequest());

      expect(response.metadata).toBeDefined();
      expect(typeof response.metadata!.duration).toBe('number');
      expect(typeof response.metadata!.timestamp).toBe('number');
    });

    it('should preserve request id in response', async () => {
      router.registerHandler('navigate', TestParamsSchema, async () => ({}));

      const response = await router.route(makeRequest({ id: 'custom-id-42' }));

      expect(response.id).toBe('custom-id-42');
    });

    it('should echo Marshal request identity in response metadata', async () => {
      router.registerHandler('navigate', TestParamsSchema, async () => ({}));
      const context = {
        chatId: 'chat-1',
        executionId: 'exec-1',
        browserSessionId: 'browser-session-1',
      };

      const response = await router.route(makeRequest({ context }));

      expect(response.metadata?.context).toEqual(context);
    });
  });

  describe('handlerCount', () => {
    it('should return 0 when no handlers registered', () => {
      expect(router.handlerCount()).toBe(0);
    });

    it('should return correct count after registrations', () => {
      router.registerHandler('navigate', TestParamsSchema, async () => ({}));
      router.registerHandler('click', z.object({ selector: z.string() }), async () => ({}));

      expect(router.handlerCount()).toBe(2);
    });
  });
});
