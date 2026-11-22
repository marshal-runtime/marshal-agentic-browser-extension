// Builds the archive an embedding host vendors (a brand VM's runtime, Linux): exactly
//   runtime-extension.json, package.json, README.md, dist/runtime.cjs and SHA256SUMS (sha256 of each of those files),
// and nothing else: no macOS helpers (dist/native), no carried Chrome extension (an embedded host carries none), no
// links. Every file 0644, directories 0755, owner 0:0, no macOS metadata. Refused when the versions of package.json
// and runtime-extension.json differ or dist/runtime.cjs is missing.
// Writes <out>/marshal-browser-embed-<version>.tgz, its .sha256, and the unpacked folder
// <out>/marshal-browser-embed-<version>/ (the same files, for a host that vendors them as they are).
//
//   npm run pack:embed -- --out <dir>        (builds first)
//   node scripts/pack-embed.mjs --out <dir>  (uses the current dist/)
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { log } from 'node:console';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
export const EMBED_FILES = [
  'runtime-extension.json',
  'package.json',
  'README.md',
  'dist/runtime.cjs',
];

const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

export function packEmbed(outDir, source = root) {
  const pkg = JSON.parse(readFileSync(path.join(source, 'package.json'), 'utf8'));
  const manifest = JSON.parse(readFileSync(path.join(source, 'runtime-extension.json'), 'utf8'));
  if (pkg.version !== manifest.version)
    throw new Error(
      `package.json ${pkg.version} and runtime-extension.json ${manifest.version} differ`,
    );
  if (!existsSync(path.join(source, 'dist', 'runtime.cjs')))
    throw new Error('dist/runtime.cjs is missing: run `npm run build` first');
  const name = `marshal-browser-embed-${manifest.version}`;
  mkdirSync(outDir, { recursive: true });
  const folder = path.join(path.resolve(outDir), name);
  rmSync(folder, { recursive: true, force: true });
  for (const rel of EMBED_FILES) {
    const from = path.join(source, rel);
    if (!lstatSync(from).isFile()) throw new Error(`${rel} is not a regular file`);
    mkdirSync(path.dirname(path.join(folder, rel)), { recursive: true, mode: 0o755 });
    copyFileSync(from, path.join(folder, rel));
    chmodSync(path.join(folder, rel), 0o644);
  }
  chmodSync(path.join(folder, 'dist'), 0o755);
  chmodSync(folder, 0o755);
  const sums = EMBED_FILES.map((rel) => `${sha256(path.join(folder, rel))}  ${rel}`).join('\n');
  writeFileSync(path.join(folder, 'SHA256SUMS'), `${sums}\n`, { mode: 0o644 });
  const archive = `${folder}.tgz`;
  const bsd = execFileSync('tar', ['--version'], { encoding: 'utf8' }).includes('bsdtar');
  execFileSync(
    'tar',
    [
      ...(bsd
        ? ['--no-mac-metadata', '--no-xattrs', '--uid', '0', '--gid', '0']
        : ['--owner=0', '--group=0', '--numeric-owner']),
      '-czf',
      archive,
      name,
    ],
    { cwd: path.resolve(outDir), env: { ...process.env, COPYFILE_DISABLE: '1' } },
  );
  const archiveSha = sha256(archive);
  writeFileSync(`${archive}.sha256`, `${archiveSha}  ${path.basename(archive)}\n`);
  return {
    archive,
    sha256: archiveSha,
    bytes: statSync(archive).size,
    folder,
    runtimeSha256: sha256(path.join(folder, 'dist', 'runtime.cjs')),
    version: manifest.version,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const out = process.argv[process.argv.indexOf('--out') + 1];
  if (!process.argv.includes('--out') || !out) {
    log('usage: node scripts/pack-embed.mjs --out <dir>');
    process.exit(2);
  }
  log(JSON.stringify(packEmbed(out), null, 2));
}
