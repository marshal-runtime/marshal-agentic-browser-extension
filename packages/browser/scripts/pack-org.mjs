// Builds the org catalog archive of @marshal/browser by hand. Marshal's own extension packer writes every file 0644,
// which strips +x from the native helpers (dist/native/*), so the org catalog takes a tar built here instead:
//   - a symlink-free stage of exactly the package's files (runtime-extension.json, package.json, README.md, dist/);
//   - dist/native/* at 0755, every other file 0644, directories 0755, owner 0:0, no macOS metadata;
//   - refused when the versions of package.json and runtime-extension.json differ, a helper is missing, anything is a
//     link, or dist/chrome-extension does not match its lock.
// Writes <out>/browser-<version>.tgz, <out>/browser-<version>.tgz.sha256 and <out>/index.json
// ({"archives":[{"id","version","sha256","bytes"}]}, the shape `pnpm org:onboarding:fill` reads).
//
//   npm run pack:org -- --out <dir>        (builds first)
//   node scripts/pack-org.mjs --out <dir>  (uses the current dist/)
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { log } from 'node:console';
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILES = ['runtime-extension.json', 'package.json', 'README.md', 'dist'];
export const HELPERS = ['dist/native/marshal-ax-helper', 'dist/native/marshal-ocr-helper'];

function argument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

/** Every entry under `dir` (relative); a link or a special file is refused. */
function walk(dir, prefix = '') {
  const out = [];
  for (const name of readdirSync(path.join(dir, prefix)).sort()) {
    const rel = prefix ? `${prefix}/${name}` : name;
    const stat = lstatSync(path.join(dir, rel));
    if (stat.isSymbolicLink()) throw new Error(`${rel} is a symbolic link`);
    if (stat.isDirectory()) out.push({ rel, dir: true }, ...walk(dir, rel));
    else if (stat.isFile()) out.push({ rel, dir: false });
    else throw new Error(`${rel} is not a regular file`);
  }
  return out;
}

export function packOrg(outDir, source = root) {
  const pkg = JSON.parse(readFileSync(path.join(source, 'package.json'), 'utf8'));
  const manifest = JSON.parse(readFileSync(path.join(source, 'runtime-extension.json'), 'utf8'));
  if (pkg.version !== manifest.version)
    throw new Error(
      `package.json ${pkg.version} and runtime-extension.json ${manifest.version} differ`,
    );
  if (!existsSync(path.join(source, 'dist', 'runtime.cjs')))
    throw new Error('dist/runtime.cjs is missing: run `npm run build` first');
  for (const helper of HELPERS)
    if (!existsSync(path.join(source, helper)))
      throw new Error(
        `${helper} is missing: build on macOS (npm run build) so the archive carries the helpers`,
      );
  execFileSync(
    process.execPath,
    [
      path.join(source, 'scripts', 'sync-chrome-extension.mjs'),
      '--check',
      '--dir',
      path.join(source, 'dist', 'chrome-extension'),
    ],
    { stdio: 'pipe' },
  );

  const stage = mkdtempSync(path.join(os.tmpdir(), 'mb-pack-org-'));
  try {
    for (const name of FILES) {
      const from = path.join(source, name);
      if (lstatSync(from).isDirectory()) walk(from);
      else if (lstatSync(from).isSymbolicLink()) throw new Error(`${name} is a symbolic link`);
      cpSync(from, path.join(stage, name), { recursive: true, verbatimSymlinks: true });
    }
    for (const entry of walk(stage)) {
      const full = path.join(stage, entry.rel);
      chmodSync(full, entry.dir || HELPERS.includes(entry.rel) ? 0o755 : 0o644);
    }
    const name = `browser-${manifest.version}.tgz`;
    mkdirSync(outDir, { recursive: true });
    const archive = path.join(path.resolve(outDir), name);
    const bsd = execFileSync('tar', ['--version'], { encoding: 'utf8' }).includes('bsdtar');
    execFileSync(
      'tar',
      [
        ...(bsd
          ? ['--no-mac-metadata', '--no-xattrs', '--uid', '0', '--gid', '0']
          : ['--owner=0', '--group=0', '--numeric-owner']),
        '-czf',
        archive,
        ...FILES,
      ],
      { cwd: stage, env: { ...process.env, COPYFILE_DISABLE: '1' } },
    );
    const bytes = statSync(archive).size;
    const sha256 = createHash('sha256').update(readFileSync(archive)).digest('hex');
    writeFileSync(`${archive}.sha256`, `${sha256}  ${name}\n`);
    const index = {
      archives: [{ id: manifest.identity, version: manifest.version, sha256, bytes }],
    };
    writeFileSync(path.join(outDir, 'index.json'), `${JSON.stringify(index, null, 2)}\n`);
    return { archive, sha256, bytes, version: manifest.version, id: manifest.identity };
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const out = argument('--out');
  if (!out) throw new Error('--out <dir> is required');
  log(JSON.stringify(packOrg(path.resolve(out)), null, 2));
}
