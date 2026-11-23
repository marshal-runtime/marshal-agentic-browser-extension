/**
 * The archive an embedding host vendors (scripts/pack-embed.mjs): exactly the bundle, manifest, package.json, README and
 * their sums; no macOS helper, no carried Chrome extension, no link; and the packed bundle, loaded by a fresh Node
 * process, exports activateEmbedded and BridgeError and lists the capabilities (tests/embed.test.ts proves the
 * embedded defaults open no listener).
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EMBED_FILES, packEmbed } from '../scripts/pack-embed.mjs';

const built = existsSync(new URL('../dist/runtime.cjs', import.meta.url));
if (!built) console.warn('[pack-embed] SKIPPED: dist/runtime.cjs is missing (npm run build first)');

describe.skipIf(!built)('pack:embed', () => {
  const out = mkdtempSync(path.join(os.tmpdir(), 'mb-pack-embed-'));
  let packed: {
    archive: string;
    sha256: string;
    folder: string;
    runtimeSha256: string;
    version: string;
  };
  beforeAll(() => {
    packed = packEmbed(out) as typeof packed;
  });
  afterAll(() => {
    rmSync(out, { recursive: true, force: true });
  });

  it('holds exactly the bundle files and their sums (no dist/native, no chrome-extension)', () => {
    const listed = execFileSync('tar', ['-tzf', packed.archive], { encoding: 'utf8' })
      .split('\n')
      .filter((line) => line && !line.endsWith('/'))
      .map((line) => line.slice(line.indexOf('/') + 1))
      .sort();
    expect(listed).toEqual([...(EMBED_FILES as string[]), 'SHA256SUMS'].sort());
    const sums = readFileSync(path.join(packed.folder, 'SHA256SUMS'), 'utf8');
    for (const rel of EMBED_FILES as string[]) {
      const hash = createHash('sha256')
        .update(readFileSync(path.join(packed.folder, rel)))
        .digest('hex');
      expect(sums).toContain(`${hash}  ${rel}`);
    }
    expect(readFileSync(`${packed.archive}.sha256`, 'utf8')).toBe(
      `${packed.sha256}  ${path.basename(packed.archive)}\n`,
    );
  });

  it('the packed bundle loads in a fresh Node: activateEmbedded, BridgeError, the capabilities', () => {
    const script = `
      const mb = require(${JSON.stringify(path.join(packed.folder, 'dist', 'runtime.cjs'))});
      (async () => {
        const activation = await mb.activateEmbedded({ decide: async () => ({ success: false, code: 'X', error: 'x' }) });
        const provider = activation.capabilityProviders[0];
        const names = (await provider.list({})).map((d) => d.name);
        const error = new mb.BridgeError('unknown', 'lost', 'outcome_unknown');
        await activation.dispose();
        process.stdout.write(JSON.stringify({ version: mb.VERSION, id: provider.id, names, code: error.code, name: error.name, own: typeof mb.activate }));
      })().catch((e) => { process.stderr.write(String(e)); process.exit(1); });`;
    const result = JSON.parse(
      execFileSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 20_000 }),
    ) as Record<string, unknown>;
    expect(result).toMatchObject({
      version: packed.version,
      id: '@marshal/browser',
      code: 'unknown',
      name: 'BridgeError',
      own: 'function',
    });
    expect(result['names']).toContain('browser.task');
  });
});
