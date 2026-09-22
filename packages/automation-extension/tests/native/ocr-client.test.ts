import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { OcrClient, resolveOcrHelperPath } from '../../src/native/ocr-client.js';

const helperPath = fileURLToPath(new URL('./fake-ocr-helper.mjs', import.meta.url));

describe('OcrClient', () => {
  let client: OcrClient | undefined;

  afterEach(async () => {
    await client?.dispose();
    client = undefined;
  });

  it('ocr(): sends a request and resolves the correlated response', async () => {
    client = new OcrClient({ helperPath });
    const result = await client.ocr('/tmp/whatever.png', { cacheKey: 'k1' });
    expect(result.lines).toEqual([
      { text: 'Fake line', x: 1, y: 2, w: 30, h: 10, confidence: 0.9 },
    ]);
    expect(result.read).toBe(1);
  });

  it('capture(): sends a capture request and resolves path/geometry', async () => {
    client = new OcrClient({ helperPath });
    const result = await client.capture({ pid: 123 });
    expect(result).toMatchObject({
      path: '/tmp/fake.png',
      w: 800,
      h: 600,
      originX: 0,
      originY: 0,
      scale: 2,
    });
  });

  it('correlates concurrent calls by id, not arrival order', async () => {
    client = new OcrClient({ helperPath });
    const [ocrResult, captureResult] = await Promise.all([
      client.ocr('/tmp/a.png'),
      client.capture({ pid: 1 }),
    ]);
    expect(ocrResult.lines[0]?.text).toBe('Fake line');
    expect(captureResult.path).toBe('/tmp/fake.png');
  });

  it('rejects on an unknown op with the helper-reported error', async () => {
    client = new OcrClient({ helperPath });
    await expect(
      (async () => {
        const raw = await (
          client as unknown as { call: (r: Record<string, unknown>) => Promise<{ error?: string }> }
        )['call']({ op: 'bogus' });
        if (raw.error) throw new Error(raw.error);
      })(),
    ).rejects.toThrow('unknown op bogus');
  });

  it('times out and rejects when the helper never responds', async () => {
    client = new OcrClient({ helperPath, timeoutMs: 150, maxRestarts: 0 });
    await expect(
      (client as unknown as { call: (r: Record<string, unknown>) => Promise<unknown> })['call']({
        op: 'hang',
      }),
    ).rejects.toThrow(/timed out/);
  });

  it('rejects pending calls when the helper process exits unexpectedly', async () => {
    client = new OcrClient({ helperPath, timeoutMs: 5000 });
    await expect(client.ocr('/tmp/x.png')).resolves.toBeDefined();
    await expect(
      (client as unknown as { call: (r: Record<string, unknown>) => Promise<unknown> })['call']({
        op: 'crash',
      }),
    ).rejects.toThrow(/exited/);
  });

  it('dispose() rejects any in-flight calls and stops the process', async () => {
    const local = new OcrClient({ helperPath, timeoutMs: 5000 });
    const pending = (
      local as unknown as { call: (r: Record<string, unknown>) => Promise<unknown> }
    )['call']({
      op: 'hang',
    });
    await local.dispose();
    await expect(pending).rejects.toThrow('OcrClient disposed');
  });
});

describe('resolveOcrHelperPath', () => {
  it('returns the configured path unchanged when given', () => {
    expect(resolveOcrHelperPath('/pkg', '/custom/helper')).toBe('/custom/helper');
  });

  it('falls back to the .build/release path when no staged dist binary exists', () => {
    const packageRoot = mkdtempSync(path.join(tmpdir(), 'ocr-helper-path-'));
    try {
      expect(resolveOcrHelperPath(packageRoot)).toBe(
        path.join(packageRoot, 'native', 'ocr-helper', '.build', 'release', 'marshal-ocr-helper'),
      );
    } finally {
      rmSync(packageRoot, { recursive: true, force: true });
    }
  });
});
