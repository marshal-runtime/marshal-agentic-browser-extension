import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { AxHelperClient } from '../../src/native/ax-helper-client.js';

const binaryPath = fileURLToPath(new URL('./fake-ax-helper.mjs', import.meta.url));

describe('AxHelperClient', () => {
  let client: AxHelperClient | undefined;

  afterEach(async () => {
    await client?.dispose();
    client = undefined;
  });

  it('sends a request and resolves the correlated response', async () => {
    client = new AxHelperClient({ binaryPath });
    const response = await client.call({ op: 'permissions' });
    expect(response).toMatchObject({ ok: true, accessibility: true, screenRecording: true });
  });

  it('correlates concurrent calls by id, not arrival order', async () => {
    client = new AxHelperClient({ binaryPath });
    const [permissions, snapshot] = await Promise.all([
      client.call({ op: 'permissions' }),
      client.call({ op: 'snapshot', pid: 111 }),
    ]);
    expect(permissions['accessibility']).toBe(true);
    expect(snapshot['app']).toMatchObject({ bundleId: 'com.apple.TextEdit' });
  });

  it('surfaces a helper-reported error for an unknown op', async () => {
    client = new AxHelperClient({ binaryPath });
    const response = await client.call({ op: 'bogus' });
    expect(response.ok).toBe(false);
    expect(response.error).toMatch(/unknown op bogus/);
  });

  it('times out when the helper never responds', async () => {
    client = new AxHelperClient({ binaryPath, callTimeoutMs: 150 });
    await expect(client.call({ op: 'hang' })).rejects.toThrow(/AX_HELPER_TIMEOUT/);
  });

  it('rejects pending calls when the process exits unexpectedly, and restarts on the next call', async () => {
    client = new AxHelperClient({ binaryPath });
    await expect(client.call({ op: 'crash' })).rejects.toThrow(/AX_HELPER_CRASHED/);
    const response = await client.call({ op: 'permissions' });
    expect(response.ok).toBe(true);
  });

  it('callWithRestart retries exactly once after a crash, against a fresh process', async () => {
    client = new AxHelperClient({ binaryPath });
    const markerPath = path.join(
      mkdtempSync(path.join(tmpdir(), 'ax-helper-test-')),
      'crashed-once',
    );
    const response = await client.callWithRestart({ op: 'crashOnce', markerPath });
    expect(response).toMatchObject({ ok: true, restarted: true });
  });

  it('dispose() rejects in-flight calls and stops the process', async () => {
    const local = new AxHelperClient({ binaryPath });
    const pending = local.call({ op: 'hang' });
    await local.dispose();
    await expect(pending).rejects.toThrow('AX_HELPER_DISPOSED');
  });
});
