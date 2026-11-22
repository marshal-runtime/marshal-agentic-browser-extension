/**
 * The Marley Chrome extension carried in this package (vendor/chrome-extension, copied by build.mjs to
 * dist/chrome-extension): unchanged from the pinned commit of zyg-edge/marley-browser-extension main, the developer
 * channel, no links, and no model inside it.
 */
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { checkDeveloperChannel, hashTree, listFiles } from '../scripts/sync-chrome-extension.mjs';
import { installCarriedExtension } from '../src/user/carried-folder.js';
import { setupFor } from '../src/user/status.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const lock = JSON.parse(
  readFileSync(path.join(root, 'vendor', 'chrome-extension.lock.json'), 'utf8'),
) as {
  repository: string;
  branch: string;
  commit: string;
  channel: string;
  version: string;
  files: Record<string, string>;
  treeSha256: string;
};
const PINNED = '48cf63fb02b6533750bd114a7ae381cff2ce839b';

/** A test of build output fails with this reason, not a confusing one, on a checkout that was not built. */
function built(folder: string): string {
  const full = path.join(root, folder);
  if (!existsSync(full))
    throw new Error(
      `${folder} is missing: run \`npm run build\` first (this test checks the build output)`,
    );
  return full;
}

function noLinks(dir: string): string[] {
  const links: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    const stat = lstatSync(full);
    if (stat.isSymbolicLink()) links.push(full);
    else if (stat.isDirectory()) links.push(...noLinks(full));
  }
  return links;
}

describe('carried Chrome extension', () => {
  it('the lock pins a commit of main, developer channel, Marley 0.5.0', () => {
    expect(lock).toMatchObject({
      repository: 'https://github.com/zyg-edge/marley-browser-extension',
      branch: 'main',
      commit: PINNED,
      channel: 'developer',
      version: '0.5.0',
    });
  });

  for (const folder of ['vendor/chrome-extension', 'dist/chrome-extension'])
    it(`${folder} is byte-for-byte the locked tree, with no links`, () => {
      const dir = folder.startsWith('dist') ? built(folder) : path.join(root, folder);
      expect(noLinks(dir)).toEqual([]);
      const actual = hashTree(dir) as { files: Record<string, string>; treeSha256: string };
      expect(actual.files).toEqual(lock.files);
      expect(actual.treeSha256).toBe(lock.treeSha256);
      const manifest = checkDeveloperChannel(dir) as { version: string; manifest_version: number };
      expect(manifest.version).toBe(lock.version);
      expect(manifest.manifest_version).toBe(3);
    });

  it('dist carries the lock beside the folder (setup reads its version and commit)', () => {
    expect(JSON.parse(readFileSync(built('dist/chrome-extension.lock.json'), 'utf8'))).toEqual(
      lock,
    );
  });

  it('runs no model: no provider endpoint or key in any carried file', () => {
    for (const rel of Object.keys(lock.files)) {
      const text = readFileSync(path.join(root, 'vendor', 'chrome-extension', rel), 'utf8');
      for (const forbidden of [
        'api.openai.com',
        'OPENAI_API_KEY',
        'anthropic',
        'generativelanguage.googleapis',
        'gpt-',
        'claude-',
      ])
        expect(text.includes(forbidden), `${rel}: ${forbidden}`).toBe(false);
    }
  });

  it('the developer check refuses a site build, a store build (update_url), and the sync refuses links', () => {
    const make = (channel: string, manifest: Record<string, unknown>): string => {
      const dir = mkdtempSync(path.join(os.tmpdir(), 'mb-carry-'));
      writeFileSync(path.join(dir, 'install-channel.js'), channel);
      writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
      return dir;
    };
    expect(() =>
      checkDeveloperChannel(make('export const SITE_INSTALL = false;\n', { version: '1' })),
    ).not.toThrow();
    expect(() =>
      checkDeveloperChannel(make('export const SITE_INSTALL = true;\n', { version: '1' })),
    ).toThrow(/site or store build/);
    expect(() =>
      checkDeveloperChannel(
        make('export const SITE_INSTALL = false;\n', {
          version: '1',
          update_url: 'https://clients2.google.com/',
        }),
      ),
    ).toThrow(/update_url/);
    const linked = make('export const SITE_INSTALL = false;\n', { version: '1' });
    mkdirSync(path.join(linked, 'sub'));
    symlinkSync('/etc/hosts', path.join(linked, 'sub', 'hosts'));
    expect(() => listFiles(linked)).toThrow(/symbolic link/);
  });
});

describe('stable folder for Load unpacked (outlives updates of this package)', () => {
  // The vendored folder (lock beside it), so these run without a build; the same files ship as dist/chrome-extension.
  const source = {
    folder: path.join(root, 'vendor', 'chrome-extension'),
    version: lock.version,
    commit: lock.commit,
  };
  const fresh = (): string =>
    path.join(mkdtempSync(path.join(os.tmpdir(), 'mb-stable-')), 'browser', 'chrome-extension');

  it('copies the locked files once, names the copy, and leaves an unchanged copy untouched', () => {
    const target = fresh();
    const carried = installCarriedExtension(source, target);
    expect(carried).toEqual({ folder: target, version: '0.5.0', commit: PINNED });
    expect((hashTree(target) as { treeSha256: string }).treeSha256).toBe(lock.treeSha256);
    const before = statSync(path.join(target, 'background.js')).mtimeMs;
    const inode = statSync(target).ino;
    expect(installCarriedExtension(source, target).folder).toBe(target);
    expect(statSync(path.join(target, 'background.js')).mtimeMs).toBe(before);
    expect(statSync(target).ino).toBe(inode);
    expect(setupFor('not_connected', undefined, carried).steps.join('\n')).toContain(
      `pick this folder: ${target}`,
    );
  });

  it('a changed or extra-damaged copy is replaced whole by the locked files', () => {
    const target = fresh();
    installCarriedExtension(source, target);
    writeFileSync(path.join(target, 'background.js'), '// tampered');
    expect(installCarriedExtension(source, target).folder).toBe(target);
    expect(readFileSync(path.join(target, 'background.js'), 'utf8')).not.toContain('tampered');
    expect((hashTree(target) as { files: Record<string, string> }).files).toEqual(lock.files);
  });

  it('a link at the target or its parent is refused, never followed: setup names the install folder with a note', () => {
    for (const where of ['target', 'parent'] as const) {
      const target = fresh();
      const elsewhere = mkdtempSync(path.join(os.tmpdir(), 'mb-elsewhere-'));
      if (where === 'parent') symlinkSync(elsewhere, path.dirname(target));
      else {
        mkdirSync(path.dirname(target), { recursive: true });
        symlinkSync(elsewhere, target);
      }
      const carried = installCarriedExtension(source, target);
      expect(carried.folder, where).toBe(source.folder);
      expect(carried.folderNote, where).toMatch(/symbolic link/);
      expect(readdirSync(elsewhere), where).toEqual([]);
      expect(setupFor('not_connected', undefined, carried).steps.join('\n'), where).toContain(
        'load it again after an update',
      );
    }
  });

  it('a carried folder that does not match its lock is not copied', () => {
    const broken = path.join(mkdtempSync(path.join(os.tmpdir(), 'mb-broken-')), 'chrome-extension');
    cpSync(source.folder, broken, { recursive: true });
    writeFileSync(path.join(broken, '..', 'chrome-extension.lock.json'), JSON.stringify(lock));
    writeFileSync(path.join(broken, 'page.js'), '// changed');
    const target = fresh();
    const carried = installCarriedExtension({ folder: broken }, target);
    expect(carried.folder).toBe(broken);
    expect(carried.folderNote).toMatch(/does not match its lock/);
    expect(existsSync(target)).toBe(false);
  });
});
