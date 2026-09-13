import { describe, it, expect } from 'vitest';
import { resolveEngine, normalizeBrowserFlag, WEBKIT_UNSUPPORTED } from '../src/engine.js';

describe('normalizeBrowserFlag', () => {
  it('maps chrome and edge to the cdp engine', () => {
    expect(normalizeBrowserFlag('chrome')).toEqual({ engine: 'cdp', browser: 'chrome' });
    expect(normalizeBrowserFlag('edge')).toEqual({ engine: 'cdp', browser: 'edge' });
  });

  it('maps webkit and safari to the webkit engine', () => {
    expect(normalizeBrowserFlag('webkit')).toEqual({ engine: 'webkit', browser: 'webkit' });
    expect(normalizeBrowserFlag('safari')).toEqual({ engine: 'webkit', browser: 'webkit' });
  });

  it('is case-insensitive', () => {
    expect(normalizeBrowserFlag('Safari')).toEqual({ engine: 'webkit', browser: 'webkit' });
    expect(normalizeBrowserFlag('WEBKIT')).toEqual({ engine: 'webkit', browser: 'webkit' });
  });

  it('rejects unknown browsers with the supported list', () => {
    expect(() => normalizeBrowserFlag('firefox')).toThrow(/chrome, edge, webkit, safari/);
  });

  it('returns undefined for no flag', () => {
    expect(normalizeBrowserFlag(undefined)).toBeUndefined();
  });
});

describe('resolveEngine', () => {
  it('prefers the --browser flag over saved config', () => {
    expect(resolveEngine('webkit', { engine: 'cdp' })).toBe('webkit');
    expect(resolveEngine('chrome', { engine: 'webkit' })).toBe('cdp');
  });

  it('falls back to config engine, then cdp', () => {
    expect(resolveEngine(undefined, { engine: 'webkit' })).toBe('webkit');
    expect(resolveEngine(undefined, {})).toBe('cdp');
    expect(resolveEngine(undefined, undefined)).toBe('cdp');
  });
});

describe('WEBKIT_UNSUPPORTED', () => {
  it('declares CDP-only commands unsupported on webkit', () => {
    for (const cmd of ['connect', 'list-targets']) {
      expect(WEBKIT_UNSUPPORTED[cmd], `${cmd} should be unsupported`).toBeTruthy();
      expect(WEBKIT_UNSUPPORTED[cmd]).toMatch(/webkit/i);
    }
  });
});
