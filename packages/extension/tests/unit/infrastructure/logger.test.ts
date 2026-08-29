import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Logger } from '../../../src/infrastructure/logger.js';
import type { LogEntry } from '../../../src/infrastructure/logger.js';

describe('Logger', () => {
  let logger: Logger;
  let debugSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // Access singleton and reset state
    logger = Logger.getInstance();
    logger.setLevel('debug');
    logger.clearRequestId();

    debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('getInstance', () => {
    it('should return the same instance on multiple calls', () => {
      const a = Logger.getInstance();
      const b = Logger.getInstance();

      expect(a).toBe(b);
    });
  });

  describe('log levels', () => {
    it('should emit debug messages when level is debug', () => {
      logger.setLevel('debug');

      logger.debug('test message');

      expect(debugSpy).toHaveBeenCalledOnce();
    });

    it('should suppress debug messages when level is info', () => {
      logger.setLevel('info');

      logger.debug('suppressed');

      expect(debugSpy).not.toHaveBeenCalled();
    });

    it('should suppress debug and info when level is warn', () => {
      logger.setLevel('warn');

      logger.debug('suppressed');
      logger.info('suppressed');

      expect(debugSpy).not.toHaveBeenCalled();
    });

    it('should only emit error when level is error', () => {
      logger.setLevel('error');

      logger.debug('no');
      logger.info('no');
      logger.warn('no');
      logger.error('yes');

      expect(debugSpy).not.toHaveBeenCalled();
      expect(warnSpy).not.toHaveBeenCalled();
      expect(errorSpy).toHaveBeenCalledOnce();
    });

    it('should route info through console.debug', () => {
      logger.setLevel('debug');

      logger.info('routed through debug');

      expect(debugSpy).toHaveBeenCalledOnce();
    });

    it('should route warn through console.warn', () => {
      logger.warn('warning');

      expect(warnSpy).toHaveBeenCalledOnce();
    });

    it('should route error through console.error', () => {
      logger.error('error');

      expect(errorSpy).toHaveBeenCalledOnce();
    });

    it('should report current level via getLevel', () => {
      logger.setLevel('warn');

      expect(logger.getLevel()).toBe('warn');
    });
  });

  describe('JSON structure', () => {
    it('should emit valid JSON with required fields', () => {
      logger.info('structured');

      const raw = debugSpy.mock.calls[0]![0] as string;
      const entry: LogEntry = JSON.parse(raw);

      expect(entry.timestamp).toBeDefined();
      expect(entry.level).toBe('info');
      expect(entry.message).toBe('structured');
    });

    it('should include context when provided', () => {
      logger.info('with context', { key: 'value' });

      const entry: LogEntry = JSON.parse(debugSpy.mock.calls[0]![0] as string);

      expect(entry.context).toEqual({ key: 'value' });
    });

    it('should omit context when not provided', () => {
      logger.info('no context');

      const entry: LogEntry = JSON.parse(debugSpy.mock.calls[0]![0] as string);

      expect(entry.context).toBeUndefined();
    });

    it('should produce ISO-8601 timestamp', () => {
      logger.info('timestamp check');

      const entry: LogEntry = JSON.parse(debugSpy.mock.calls[0]![0] as string);
      const parsed = new Date(entry.timestamp);

      expect(parsed.toISOString()).toBe(entry.timestamp);
    });
  });

  describe('request ID', () => {
    it('should include requestId when set', () => {
      logger.setRequestId('req-123');

      logger.info('with request id');

      const entry: LogEntry = JSON.parse(debugSpy.mock.calls[0]![0] as string);

      expect(entry.requestId).toBe('req-123');
    });

    it('should omit requestId when not set', () => {
      logger.clearRequestId();

      logger.info('no request id');

      const entry: LogEntry = JSON.parse(debugSpy.mock.calls[0]![0] as string);

      expect(entry.requestId).toBeUndefined();
    });

    it('should return current requestId via getRequestId', () => {
      logger.setRequestId('req-456');

      expect(logger.getRequestId()).toBe('req-456');
    });

    it('should return undefined after clearRequestId', () => {
      logger.setRequestId('req-789');
      logger.clearRequestId();

      expect(logger.getRequestId()).toBeUndefined();
    });
  });
});
