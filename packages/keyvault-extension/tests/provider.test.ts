import { describe, expect, it, vi } from 'vitest';
import { createKeyVaultProvider, KEYVAULT_WRITE_TO_INPUT_BOX } from '../src/provider.js';
import type { InvocationContext, KeyVaultEntry, SecretInputRequest } from '../src/contracts.js';

const entry: KeyVaultEntry = {
  key: 'Google-zyg',
  username: 'operator@example.com',
  password: 'never-return-this',
  allowedUrlPatterns: ['https://accounts.google.com/*'],
  notBefore: '2026-09-15T00:00:00.000Z',
  expiresAt: '2026-09-16T00:00:00.000Z',
};

const context: InvocationContext = {
  principal: { id: 'agent-1', kind: 'agent' },
  scope: { sessionId: 'session-1' },
  executionId: 'execution-1',
};

describe('KeyVault capability', () => {
  it('accepts arbitrary operator-chosen keys and never returns the credential', async () => {
    const request: SecretInputRequest[] = [];
    const provider = createKeyVaultProvider({
      store: { get: vi.fn(async () => entry), put: vi.fn(async () => {}) },
      sink: {
        typeSecret: vi.fn(async (value) => {
          request.push(value);
          return { success: true };
        }),
      },
      now: () => new Date('2026-09-15T12:00:00.000Z'),
    });

    const result = await provider.invoke(
      KEYVAULT_WRITE_TO_INPUT_BOX,
      {
        key: 'Google-zyg',
        usernameSelector: '#email',
        passwordSelector: '#password',
        clearFirst: true,
      },
      context,
    );

    expect(result.output).toEqual({
      success: true,
      key: 'Google-zyg',
      filled: ['username', 'password'],
    });
    expect(JSON.stringify(result.output)).not.toContain('never-return-this');
    expect(request).toEqual([
      expect.objectContaining({ selector: '#email', text: 'operator@example.com' }),
      expect.objectContaining({ selector: '#password', text: 'never-return-this' }),
    ]);
  });

  it('rejects access outside the configured time window before touching the sink', async () => {
    const typeSecret = vi.fn(async () => ({ success: true }));
    const provider = createKeyVaultProvider({
      store: { get: vi.fn(async () => entry), put: vi.fn(async () => {}) },
      sink: { typeSecret },
      now: () => new Date('2026-09-16T00:00:00.000Z'),
    });

    await expect(
      provider.invoke(
        KEYVAULT_WRITE_TO_INPUT_BOX,
        {
          key: 'Google-zyg',
          passwordSelector: '#password',
        },
        context,
      ),
    ).rejects.toThrow('KEYVAULT_WINDOW_CLOSED');
    expect(typeSecret).not.toHaveBeenCalled();
  });

  it('requires an explicit input selector and aborts without writing', async () => {
    const typeSecret = vi.fn(async () => ({ success: true }));
    const provider = createKeyVaultProvider({
      store: { get: vi.fn(async () => entry), put: vi.fn(async () => {}) },
      sink: { typeSecret },
      now: () => new Date('2026-09-15T12:00:00.000Z'),
    });

    await expect(
      provider.invoke(KEYVAULT_WRITE_TO_INPUT_BOX, { key: 'Google-zyg' }, context),
    ).rejects.toThrow('KEYVAULT_SELECTOR_REQUIRED');
    await expect(
      provider.invoke(
        KEYVAULT_WRITE_TO_INPUT_BOX,
        { key: 'Google-zyg', passwordSelector: '#password' },
        {
          ...context,
          signal: { aborted: true },
        },
      ),
    ).rejects.toThrow('KEYVAULT_ABORTED');
    expect(typeSecret).not.toHaveBeenCalled();
  });
});
