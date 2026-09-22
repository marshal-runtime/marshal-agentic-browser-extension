import { describe, expect, it, vi } from 'vitest';
import { BROWSER_TOOLS } from '@agentic-browser/mcp-server/browser-tools';
import type { IBrowserAdapter } from '@agentic-browser/shared';
import { createSecretTypeHandler, getToolRegistry } from '../../../src/tools/index.js';

describe('host-only KeyVault browser command', () => {
  it('is not published through ordinary browser discovery', () => {
    expect(BROWSER_TOOLS.some((tool) => tool.name === 'browser_type_secret')).toBe(false);
    expect(getToolRegistry().some((tool) => tool.command === 'typeSecret')).toBe(false);
  });

  it('checks the live active-tab URL before passing the secret to the adapter', async () => {
    const type = vi.fn(async () => ({ ok: true as const, value: undefined }));
    const adapter = {
      getActiveTab: vi.fn(async () => ({
        ok: true as const,
        value: {
          tabId: 1,
          url: 'https://evil.example/login',
          title: '',
          active: true,
          windowId: 1,
        },
      })),
      type,
    } as unknown as IBrowserAdapter;

    await expect(
      createSecretTypeHandler(adapter)({
        selector: '#password',
        text: 'do-not-leak',
        allowedUrlPatterns: ['https://accounts.google.com/*'],
      }),
    ).rejects.toThrow('KEYVAULT_URL_DENIED');
    expect(type).not.toHaveBeenCalled();
  });
});
