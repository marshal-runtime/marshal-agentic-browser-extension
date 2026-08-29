import { describe, it, expect, vi, beforeEach } from 'vitest';
import { z } from 'zod';
import { chrome, resetChromeMocks } from '../__mocks__/chrome.js';

vi.stubGlobal('chrome', chrome);
vi.stubGlobal('crypto', { randomUUID: () => 'batch-uuid-1234' });
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

const NavigateSchema = z.object({ url: z.string().url() });
const ClickSchema = z.object({ selector: z.string().min(1) });

describe('Multi-step batch execution', () => {
  let router: InstanceType<typeof CommandRouter>;

  beforeEach(() => {
    resetChromeMocks();
    (performance.now as ReturnType<typeof vi.fn>).mockReturnValue(0);
    router = new CommandRouter();

    router.registerHandler('navigate', NavigateSchema, async (params) => {
      return { navigatedTo: params.url };
    });
    router.registerHandler('click', ClickSchema, async (params) => {
      return { clicked: params.selector };
    });
    router.init();
  });

  describe('sequential batch', () => {
    it('should execute commands in order and return all results', async () => {
      const result = await router.executeBatch(
        [
          { command: 'navigate', params: { url: 'https://example.com' } },
          { command: 'click', params: { selector: '#btn' } },
        ],
        { mode: 'best-effort' },
      );

      expect(result.completed).toBe(true);
      expect(result.steps).toHaveLength(2);
      expect(result.steps[0]!.command).toBe('navigate');
      expect(result.steps[0]!.response.success).toBe(true);
      expect(result.steps[0]!.response.data).toEqual({ navigatedTo: 'https://example.com' });
      expect(result.steps[1]!.command).toBe('click');
      expect(result.steps[1]!.response.success).toBe(true);
      expect(result.steps[1]!.response.data).toEqual({ clicked: '#btn' });
    });

    it('should generate a checkpoint ID when not provided', async () => {
      const result = await router.executeBatch(
        [{ command: 'navigate', params: { url: 'https://example.com' } }],
        { mode: 'best-effort' },
      );

      expect(result.checkpointId).toBe('batch-uuid-1234');
    });

    it('should use provided checkpoint ID', async () => {
      const result = await router.executeBatch(
        [{ command: 'navigate', params: { url: 'https://example.com' } }],
        { mode: 'best-effort', checkpointId: 'custom-id' },
      );

      expect(result.checkpointId).toBe('custom-id');
    });

    it('should save checkpoint after each step', async () => {
      await router.executeBatch(
        [
          { command: 'navigate', params: { url: 'https://example.com' } },
          { command: 'click', params: { selector: '#btn' } },
        ],
        { mode: 'best-effort' },
      );

      const store = chrome.storage.local._getStore();
      const checkpoint = store['checkpoint:batch-uuid-1234'] as Record<string, unknown>;

      expect(checkpoint).toBeDefined();
      expect(checkpoint.stepIndex).toBe(1);
    });

    it('should include totalDuration in result', async () => {
      let callCount = 0;
      (performance.now as ReturnType<typeof vi.fn>).mockImplementation(() => {
        return callCount++ * 100;
      });

      const result = await router.executeBatch(
        [{ command: 'navigate', params: { url: 'https://example.com' } }],
        { mode: 'best-effort' },
      );

      expect(typeof result.totalDuration).toBe('number');
    });
  });

  describe('best-effort mode', () => {
    it('should continue executing after a step failure', async () => {
      router.registerHandler('navigate', NavigateSchema, async () => {
        throw new Error('navigation failed');
      });

      const result = await router.executeBatch(
        [
          { command: 'navigate', params: { url: 'https://example.com' } },
          { command: 'click', params: { selector: '#btn' } },
        ],
        { mode: 'best-effort' },
      );

      expect(result.completed).toBe(true);
      expect(result.steps).toHaveLength(2);
      expect(result.steps[0]!.response.success).toBe(false);
      expect(result.steps[1]!.response.success).toBe(true);
    });

    it('should mark batch as completed even with failures', async () => {
      router.registerHandler('navigate', NavigateSchema, async () => {
        throw new Error('fail');
      });

      const result = await router.executeBatch(
        [{ command: 'navigate', params: { url: 'https://example.com' } }],
        { mode: 'best-effort' },
      );

      expect(result.completed).toBe(true);
    });
  });

  describe('strict mode', () => {
    it('should halt on first failure in strict mode', async () => {
      router.registerHandler('navigate', NavigateSchema, async () => {
        throw new Error('navigation failed');
      });

      const result = await router.executeBatch(
        [
          { command: 'navigate', params: { url: 'https://example.com' } },
          { command: 'click', params: { selector: '#btn' } },
        ],
        { mode: 'strict' },
      );

      expect(result.completed).toBe(false);
      expect(result.steps).toHaveLength(1);
      expect(result.steps[0]!.response.success).toBe(false);
    });

    it('should complete when all steps succeed in strict mode', async () => {
      const result = await router.executeBatch(
        [
          { command: 'navigate', params: { url: 'https://example.com' } },
          { command: 'click', params: { selector: '#btn' } },
        ],
        { mode: 'strict' },
      );

      expect(result.completed).toBe(true);
      expect(result.steps).toHaveLength(2);
    });
  });

  describe('timeout', () => {
    it('should stop execution when timeout is exceeded', async () => {
      let callCount = 0;
      (performance.now as ReturnType<typeof vi.fn>).mockImplementation(() => {
        return callCount++ * 1000;
      });

      const result = await router.executeBatch(
        [
          { command: 'navigate', params: { url: 'https://example.com' } },
          { command: 'click', params: { selector: '#btn' } },
          { command: 'click', params: { selector: '#btn2' } },
        ],
        { mode: 'best-effort', timeoutMs: 1500 },
      );

      expect(result.completed).toBe(false);
      expect(result.steps.length).toBeLessThan(3);
    });

    it('should complete all steps when timeout is not exceeded', async () => {
      (performance.now as ReturnType<typeof vi.fn>).mockReturnValue(0);

      const result = await router.executeBatch(
        [
          { command: 'navigate', params: { url: 'https://example.com' } },
          { command: 'click', params: { selector: '#btn' } },
        ],
        { mode: 'best-effort', timeoutMs: 60_000 },
      );

      expect(result.completed).toBe(true);
      expect(result.steps).toHaveLength(2);
    });
  });

  describe('resume from checkpoint', () => {
    it('should skip previously completed steps on resume', async () => {
      const navigateSpy = vi.fn().mockResolvedValue({ navigatedTo: 'https://example.com' });
      const clickSpy = vi.fn().mockResolvedValue({ clicked: '#btn' });

      router.registerHandler('navigate', NavigateSchema, navigateSpy);
      router.registerHandler('click', ClickSchema, clickSpy);

      await router.executeBatch(
        [
          { command: 'navigate', params: { url: 'https://example.com' } },
          { command: 'click', params: { selector: '#btn' } },
        ],
        { mode: 'best-effort', checkpointId: 'resume-test' },
      );

      navigateSpy.mockClear();
      clickSpy.mockClear();

      const resumeResult = await router.resumeBatch(
        'resume-test',
        [
          { command: 'navigate', params: { url: 'https://example.com' } },
          { command: 'click', params: { selector: '#btn' } },
        ],
        { mode: 'best-effort' },
      );

      expect(resumeResult.completed).toBe(true);
      expect(resumeResult.steps).toHaveLength(2);
      expect(navigateSpy).not.toHaveBeenCalled();
      expect(clickSpy).not.toHaveBeenCalled();
    });

    it('should execute remaining steps after resume', async () => {
      router.registerHandler('navigate', NavigateSchema, async () => {
        throw new Error('fail');
      });

      await router.executeBatch(
        [
          { command: 'click', params: { selector: '#btn1' } },
          { command: 'navigate', params: { url: 'https://example.com' } },
        ],
        { mode: 'best-effort', checkpointId: 'partial-resume' },
      );

      router.registerHandler('navigate', NavigateSchema, async (params) => {
        return { navigatedTo: params.url };
      });

      const resumeResult = await router.resumeBatch(
        'partial-resume',
        [
          { command: 'click', params: { selector: '#btn1' } },
          { command: 'navigate', params: { url: 'https://example.com' } },
        ],
        { mode: 'best-effort' },
      );

      expect(resumeResult.completed).toBe(true);
      expect(resumeResult.steps).toHaveLength(2);
      expect(resumeResult.steps[0]!.response.success).toBe(true);
    });

    it('should return empty results for nonexistent checkpoint', async () => {
      const result = await router.resumeBatch(
        'nonexistent',
        [{ command: 'navigate', params: { url: 'https://example.com' } }],
        { mode: 'best-effort' },
      );

      expect(result.completed).toBe(true);
      expect(result.steps).toHaveLength(1);
    });
  });
});
