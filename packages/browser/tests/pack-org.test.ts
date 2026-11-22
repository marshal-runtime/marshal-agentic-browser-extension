/**
 * The org catalog archive (scripts/pack-org.mjs): built from the current build, then extracted the way an installer
 * does (modes kept), and checked: the native helpers are executable and run, the carried Chrome extension matches its
 * lock, no links, and the sha256 / size files describe the archive. Needs a macOS build (`npm run build`), which is the
 * only build that has the helpers; elsewhere it is skipped with that reason.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { HELPERS, packOrg } from '../scripts/pack-org.mjs';
import { hashTree } from '../scripts/sync-chrome-extension.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const helpersBuilt = HELPERS.every((helper: string) => existsSync(path.join(root, helper)));
if (!helpersBuilt)
  console.warn(
    '[pack-org] SKIPPED: dist/native helpers are missing (run `npm run build` on macOS)',
  );

describe.skipIf(!helpersBuilt)('org catalog archive', () => {
  it('extracts with the helpers at 0755 (they run), the lock-matching Chrome extension, and its sha256 and size', () => {
    const out = mkdtempSync(path.join(os.tmpdir(), 'mb-pack-out-'));
    const packed = packOrg(out) as {
      archive: string;
      sha256: string;
      bytes: number;
      version: string;
      id: string;
    };
    const manifest = JSON.parse(
      readFileSync(path.join(root, 'runtime-extension.json'), 'utf8'),
    ) as {
      version: string;
    };
    expect(packed).toMatchObject({ id: '@marshal/browser', version: manifest.version });
    expect(path.basename(packed.archive)).toBe(`browser-${manifest.version}.tgz`);
    const bytes = readFileSync(packed.archive);
    expect(packed.bytes).toBe(bytes.length);
    expect(packed.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(readFileSync(`${packed.archive}.sha256`, 'utf8')).toBe(
      `${packed.sha256}  ${path.basename(packed.archive)}\n`,
    );
    expect(JSON.parse(readFileSync(path.join(out, 'index.json'), 'utf8'))).toEqual({
      archives: [
        {
          id: '@marshal/browser',
          version: manifest.version,
          sha256: packed.sha256,
          bytes: packed.bytes,
        },
      ],
    });

    const listing = execFileSync('tar', ['-tvzf', packed.archive], { encoding: 'utf8' })
      .trim()
      .split('\n');
    expect(listing.filter((line) => line.startsWith('l'))).toEqual([]);
    const names = execFileSync('tar', ['-tzf', packed.archive], { encoding: 'utf8' })
      .trim()
      .split('\n');
    expect(names).toContain('runtime-extension.json');
    expect(names.some((name) => name.startsWith('/') || name.split('/').includes('..'))).toBe(
      false,
    );
    expect(names.some((name) => name.includes('._') || name.includes('.DS_Store'))).toBe(false);

    const extracted = mkdtempSync(path.join(os.tmpdir(), 'mb-pack-x-'));
    execFileSync('tar', ['-xpzf', packed.archive, '-C', extracted]);
    for (const helper of HELPERS) {
      const mode = statSync(path.join(extracted, helper)).mode & 0o777;
      expect(mode, helper).toBe(0o755);
      // The installer keeps (mode & 0o755) | 0o600: still executable.
      expect(((mode & 0o755) | 0o600) & 0o111, helper).toBe(0o111);
      const run = spawnSync(path.join(extracted, helper), [], { input: '', timeout: 10_000 });
      expect(run.error, helper).toBeUndefined();
    }
    expect(statSync(path.join(extracted, 'dist', 'runtime.cjs')).mode & 0o777).toBe(0o644);
    const lock = JSON.parse(
      readFileSync(path.join(extracted, 'dist', 'chrome-extension.lock.json'), 'utf8'),
    ) as {
      treeSha256: string;
    };
    expect(
      (hashTree(path.join(extracted, 'dist', 'chrome-extension')) as { treeSha256: string })
        .treeSha256,
    ).toBe(lock.treeSha256);
  }, 60_000);
});
