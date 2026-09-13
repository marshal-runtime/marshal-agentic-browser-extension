import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';

// AGENTIC_BROWSER_CONFIG_DIR lets tests (and parallel engine setups) use an
// isolated state directory instead of the user's real one.
const CONFIG_DIR = process.env['AGENTIC_BROWSER_CONFIG_DIR'] ?? join(homedir(), '.agentic-browser');
const CONFIG_FILE = join(CONFIG_DIR, 'config.json');

export interface Config {
  port: number;
  host: string;
  browser: 'chrome' | 'edge' | 'webkit';
  /** 'cdp' (Chrome/Edge, the default) or 'webkit' (Playwright WebKit daemon). */
  engine?: 'cdp' | 'webkit';
  currentTargetId?: string;
  profileDir?: string;
}

const DEFAULT_CONFIG: Config = {
  port: 9222,
  host: '127.0.0.1',
  browser: 'chrome',
};

export function loadConfig(): Config {
  try {
    if (existsSync(CONFIG_FILE)) {
      const raw = readFileSync(CONFIG_FILE, 'utf-8');
      return { ...DEFAULT_CONFIG, ...JSON.parse(raw) } as Config;
    }
  } catch {
    // Ignore parse errors, return defaults
  }
  return { ...DEFAULT_CONFIG };
}

export function saveConfig(config: Partial<Config>): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  const existing = loadConfig();
  const merged = { ...existing, ...config };
  writeFileSync(CONFIG_FILE, JSON.stringify(merged, null, 2), 'utf-8');
}

export function getConfigPath(): string {
  return CONFIG_FILE;
}

export function getConfigDir(): string {
  return CONFIG_DIR;
}
