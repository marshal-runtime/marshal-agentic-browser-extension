import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { loadConfig } from '../../config/server-config.js';
import { DEFAULT_TIMEOUT } from '@agentic-browser/shared';

vi.mock('node:fs', () => ({
  readFileSync: vi.fn(),
}));

import { readFileSync } from 'node:fs';

const mockedReadFileSync = vi.mocked(readFileSync);

describe('loadConfig', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetAllMocks();
    process.env = { ...originalEnv };
    delete process.env.AGENTIC_BROWSER_SERVER_NAME;
    delete process.env.AGENTIC_BROWSER_SERVER_VERSION;
    delete process.env.AGENTIC_BROWSER_NM_HOST_PATH;
    delete process.env.AGENTIC_BROWSER_LOG_LEVEL;
    delete process.env.AGENTIC_BROWSER_TIMEOUT;
    delete process.env.AGENTIC_BROWSER_EXTENSION_ID;
    delete process.env.AGENTIC_BROWSER_CONFIG;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('default values', () => {
    it('should return defaults when no env vars are set', () => {
      const config = loadConfig();

      expect(config.serverName).toBe('agentic-browser');
      expect(config.serverVersion).toBe('0.1.0');
      expect(config.nativeMessagingHostPath).toBe('com.agentic_browser.mcp_host');
      expect(config.logLevel).toBe('info');
      expect(config.timeout).toBe(DEFAULT_TIMEOUT);
      expect(config.extensionId).toBe('');
    });
  });

  describe('environment variables', () => {
    it('should load serverName from env', () => {
      process.env.AGENTIC_BROWSER_SERVER_NAME = 'my-server';

      const config = loadConfig();

      expect(config.serverName).toBe('my-server');
    });

    it('should load serverVersion from env', () => {
      process.env.AGENTIC_BROWSER_SERVER_VERSION = '2.0.0';

      const config = loadConfig();

      expect(config.serverVersion).toBe('2.0.0');
    });

    it('should load nativeMessagingHostPath from env', () => {
      process.env.AGENTIC_BROWSER_NM_HOST_PATH = '/usr/bin/host';

      const config = loadConfig();

      expect(config.nativeMessagingHostPath).toBe('/usr/bin/host');
    });

    it('should load valid logLevel from env', () => {
      process.env.AGENTIC_BROWSER_LOG_LEVEL = 'debug';

      const config = loadConfig();

      expect(config.logLevel).toBe('debug');
    });

    it('should fallback to default for invalid logLevel', () => {
      process.env.AGENTIC_BROWSER_LOG_LEVEL = 'trace';

      const config = loadConfig();

      expect(config.logLevel).toBe('info');
    });

    it('should load timeout from env', () => {
      process.env.AGENTIC_BROWSER_TIMEOUT = '5000';

      const config = loadConfig();

      expect(config.timeout).toBe(5000);
    });

    it('should fallback to default for invalid timeout', () => {
      process.env.AGENTIC_BROWSER_TIMEOUT = 'not-a-number';

      const config = loadConfig();

      expect(config.timeout).toBe(DEFAULT_TIMEOUT);
    });

    it('should fallback to default for negative timeout', () => {
      process.env.AGENTIC_BROWSER_TIMEOUT = '-1';

      const config = loadConfig();

      expect(config.timeout).toBe(DEFAULT_TIMEOUT);
    });

    it('should load extensionId from env', () => {
      process.env.AGENTIC_BROWSER_EXTENSION_ID = 'abcdef123456';

      const config = loadConfig();

      expect(config.extensionId).toBe('abcdef123456');
    });
  });

  describe('config file loading', () => {
    it('should load config from JSON file', () => {
      process.env.AGENTIC_BROWSER_CONFIG = '/path/to/config.json';
      mockedReadFileSync.mockReturnValue(
        JSON.stringify({
          serverName: 'file-server',
          logLevel: 'warn',
          timeout: 10000,
        }),
      );

      const config = loadConfig();

      expect(config.serverName).toBe('file-server');
      expect(config.logLevel).toBe('warn');
      expect(config.timeout).toBe(10000);
      expect(mockedReadFileSync).toHaveBeenCalledWith('/path/to/config.json', 'utf-8');
    });

    it('should override config file values with env vars', () => {
      process.env.AGENTIC_BROWSER_CONFIG = '/path/to/config.json';
      process.env.AGENTIC_BROWSER_SERVER_NAME = 'env-server';
      mockedReadFileSync.mockReturnValue(JSON.stringify({ serverName: 'file-server' }));

      const config = loadConfig();

      expect(config.serverName).toBe('env-server');
    });

    it('should fallback gracefully when config file read fails', () => {
      process.env.AGENTIC_BROWSER_CONFIG = '/nonexistent/config.json';
      mockedReadFileSync.mockImplementation(() => {
        throw new Error('ENOENT');
      });

      const config = loadConfig();

      expect(config.serverName).toBe('agentic-browser');
      expect(config.logLevel).toBe('info');
    });

    it('should fallback gracefully when config file has invalid JSON', () => {
      process.env.AGENTIC_BROWSER_CONFIG = '/path/to/bad.json';
      mockedReadFileSync.mockReturnValue('not valid json {{{');

      const config = loadConfig();

      expect(config.serverName).toBe('agentic-browser');
    });

    it('should not read file when AGENTIC_BROWSER_CONFIG is not set', () => {
      loadConfig();

      expect(mockedReadFileSync).not.toHaveBeenCalled();
    });
  });

  describe('log level validation', () => {
    it.each(['debug', 'info', 'warn', 'error'] as const)('should accept log level: %s', (level) => {
      process.env.AGENTIC_BROWSER_LOG_LEVEL = level;

      const config = loadConfig();

      expect(config.logLevel).toBe(level);
    });
  });
});

describe('createServer', () => {
  it('should return server, client, and executor', async () => {
    vi.doMock('@modelcontextprotocol/sdk/server/mcp.js', () => ({
      McpServer: vi.fn().mockImplementation(() => ({
        server: { setRequestHandler: vi.fn() },
      })),
    }));

    const { createServer } = await import('../../server.js');

    const result = createServer({
      serverName: 'test',
      serverVersion: '1.0.0',
      nativeMessagingHostPath: '/test/path',
      logLevel: 'info',
      timeout: 5000,
      extensionId: 'test-id',
    });

    expect(result.server).toBeDefined();
    expect(result.client).toBeDefined();
    expect(result.executor).toBeDefined();
  });
});
