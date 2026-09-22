import { describe, expect, it } from 'vitest';
import { matchesAllowedUrl } from '../src/url-policy.js';

describe('Safari KeyVault URL policy', () => {
  it('matches an allowed HTTPS origin and path', () => {
    expect(
      matchesAllowedUrl('https://accounts.example.test/login', ['https://accounts.example.test/*']),
    ).toBe(true);
  });

  it('rejects a different origin and non-http schemes', () => {
    const patterns = ['https://accounts.example.test/*'];
    expect(matchesAllowedUrl('https://evil.example.test/login', patterns)).toBe(false);
    expect(matchesAllowedUrl('javascript:alert(1)', patterns)).toBe(false);
  });
});
