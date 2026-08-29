import { readFileSync } from 'node:fs';
import { DEFAULT_TIMEOUT, NATIVE_MESSAGING_HOST_ID } from '@agentic-browser/shared';

/** Environment variable prefix for all server configuration. */
const ENV_PREFIX = 'AGENTIC_BROWSER_';

/** Type-safe server configuration. */
export interface ServerConfig {
  /** Server display name for MCP capability handshake. */
  readonly serverName: string;
  /** Server version string. */
  readonly serverVersion: string;
  /** Path to the native messaging host executable. */
  readonly nativeMessagingHostPath: string;
  /** Log level for server diagnostics. */
  readonly logLevel: 'debug' | 'info' | 'warn' | 'error';
  /** Timeout for tool execution in milliseconds. */
  readonly timeout: number;
  /** Chrome extension ID for native messaging. */
  readonly extensionId: string;
}

/** Default configuration values. */
const DEFAULTS: ServerConfig = {
  serverName: 'agentic-browser',
  serverVersion: '0.1.0',
  nativeMessagingHostPath: NATIVE_MESSAGING_HOST_ID,
  logLevel: 'info',
  timeout: DEFAULT_TIMEOUT,
  extensionId: '',
};

const VALID_LOG_LEVELS = new Set<string>(['debug', 'info', 'warn', 'error']);

/**
 * Loads server configuration from environment variables and an
 * optional JSON config file.
 *
 * Environment variables use the `AGENTIC_BROWSER_` prefix:
 * - `AGENTIC_BROWSER_SERVER_NAME`
 * - `AGENTIC_BROWSER_SERVER_VERSION`
 * - `AGENTIC_BROWSER_NM_HOST_PATH`
 * - `AGENTIC_BROWSER_LOG_LEVEL`
 * - `AGENTIC_BROWSER_TIMEOUT`
 * - `AGENTIC_BROWSER_EXTENSION_ID`
 * - `AGENTIC_BROWSER_CONFIG` — path to a JSON config file
 *
 * Config file values are overridden by environment variables.
 */
export function loadConfig(): ServerConfig {
  const fileConfig = loadConfigFile();

  const logLevel = resolveLogLevel(process.env[`${ENV_PREFIX}LOG_LEVEL`], fileConfig.logLevel);

  const timeoutRaw = process.env[`${ENV_PREFIX}TIMEOUT`] ?? fileConfig.timeout?.toString();
  const timeout = parseTimeout(timeoutRaw);

  return {
    serverName:
      process.env[`${ENV_PREFIX}SERVER_NAME`] ?? fileConfig.serverName ?? DEFAULTS.serverName,
    serverVersion:
      process.env[`${ENV_PREFIX}SERVER_VERSION`] ??
      fileConfig.serverVersion ??
      DEFAULTS.serverVersion,
    nativeMessagingHostPath:
      process.env[`${ENV_PREFIX}NM_HOST_PATH`] ??
      fileConfig.nativeMessagingHostPath ??
      DEFAULTS.nativeMessagingHostPath,
    logLevel,
    timeout,
    extensionId:
      process.env[`${ENV_PREFIX}EXTENSION_ID`] ?? fileConfig.extensionId ?? DEFAULTS.extensionId,
  };
}

interface PartialFileConfig {
  serverName?: string;
  serverVersion?: string;
  nativeMessagingHostPath?: string;
  logLevel?: string;
  timeout?: number;
  extensionId?: string;
}

function loadConfigFile(): PartialFileConfig {
  const configPath = process.env[`${ENV_PREFIX}CONFIG`];
  if (!configPath) {
    return {};
  }

  try {
    const raw = readFileSync(configPath, 'utf-8');
    return JSON.parse(raw) as PartialFileConfig;
  } catch {
    return {};
  }
}

function resolveLogLevel(
  envValue: string | undefined,
  fileValue: string | undefined,
): ServerConfig['logLevel'] {
  const value = envValue ?? fileValue;
  if (value && VALID_LOG_LEVELS.has(value)) {
    return value as ServerConfig['logLevel'];
  }
  return DEFAULTS.logLevel;
}

function parseTimeout(raw: string | undefined): number {
  if (!raw) {
    return DEFAULTS.timeout;
  }
  const parsed = Number(raw);
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed;
  }
  return DEFAULTS.timeout;
}
