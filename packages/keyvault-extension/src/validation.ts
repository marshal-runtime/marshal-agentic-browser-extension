import type { KeyVaultEntry } from './contracts.js';

const MAX_KEY_LENGTH = 1_024;
const MAX_PATTERN_LENGTH = 2_048;

export function validateEntry(entry: KeyVaultEntry): KeyVaultEntry {
  if (
    typeof entry.key !== 'string' ||
    entry.key.trim().length === 0 ||
    entry.key.length > MAX_KEY_LENGTH
  ) {
    throw new Error(
      'KEYVAULT_INVALID_KEY: key must be a non-empty string of at most 1024 characters',
    );
  }
  if (typeof entry.username !== 'string' || typeof entry.password !== 'string') {
    throw new Error('KEYVAULT_INVALID_CREDENTIAL: username and password must be strings');
  }
  const patterns: readonly unknown[] = entry.allowedUrlPatterns;
  if (
    patterns.length === 0 ||
    patterns.length > 128 ||
    patterns.some((pattern) => typeof pattern !== 'string')
  ) {
    throw new Error('KEYVAULT_INVALID_URL_ALLOWLIST: at least one URL pattern is required');
  }
  const stringPatterns = patterns.filter(
    (pattern): pattern is string => typeof pattern === 'string',
  );
  for (const pattern of stringPatterns) validateUrlPattern(pattern);

  const notBefore = parseTimestamp(entry.notBefore, 'notBefore');
  const expiresAt = parseTimestamp(entry.expiresAt, 'expiresAt');
  if (expiresAt <= notBefore) {
    throw new Error('KEYVAULT_INVALID_WINDOW: expiresAt must be after notBefore');
  }
  return Object.freeze({
    ...entry,
    key: entry.key,
    allowedUrlPatterns: Object.freeze([...stringPatterns]),
  });
}

export function assertWindowOpen(entry: KeyVaultEntry, now = new Date()): void {
  const time = now.getTime();
  const notBefore = parseTimestamp(entry.notBefore, 'notBefore');
  const expiresAt = parseTimestamp(entry.expiresAt, 'expiresAt');
  if (time < notBefore) throw new Error('KEYVAULT_WINDOW_CLOSED: credential window has not opened');
  if (time >= expiresAt) throw new Error('KEYVAULT_WINDOW_CLOSED: credential window has expired');
}

export function validateUrlPattern(pattern: string): void {
  if (typeof pattern !== 'string' || pattern.length === 0 || pattern.length > MAX_PATTERN_LENGTH) {
    throw new Error('KEYVAULT_INVALID_URL_ALLOWLIST: URL patterns must be non-empty and bounded');
  }
  if (!/^https?:\/\//i.test(pattern) || pattern.includes('\\')) {
    throw new Error('KEYVAULT_INVALID_URL_ALLOWLIST: only http(s) URL patterns are allowed');
  }
  const withoutWildcards = pattern.replaceAll('*', 'placeholder.invalid');
  let parsed: URL;
  try {
    parsed = new URL(withoutWildcards);
  } catch {
    throw new Error('KEYVAULT_INVALID_URL_ALLOWLIST: malformed URL pattern');
  }
  if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error(
      'KEYVAULT_INVALID_URL_ALLOWLIST: credentials and non-http schemes are not allowed',
    );
  }
}

function parseTimestamp(value: string, field: string): number {
  if (typeof value !== 'string')
    throw new Error(`KEYVAULT_INVALID_WINDOW: ${field} must be an ISO timestamp`);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed))
    throw new Error(`KEYVAULT_INVALID_WINDOW: ${field} must be an ISO timestamp`);
  return parsed;
}
