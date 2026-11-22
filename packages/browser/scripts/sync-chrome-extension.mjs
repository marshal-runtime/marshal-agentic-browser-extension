// Vendors the Marley Chrome extension (zyg-edge/marley-browser-extension, folder chrome-extension) at a pinned commit of
// main into vendor/chrome-extension, with a lock file of per-file sha256 and a tree hash, so one install of
// @marshal/browser carries the Chrome half of the person's-Chrome backend (build.mjs copies it to dist/chrome-extension).
// It is the developer channel: install-channel.js must say SITE_INSTALL = false and the manifest must have no
// update_url, or the extension never opens Marshal's local socket. The files are copied unchanged. That extension runs
// no model; it only exposes browser controls.
//
//   node scripts/sync-chrome-extension.mjs --repo <checkout of zyg-edge/marley-browser-extension> --commit <sha on main>
//   node scripts/sync-chrome-extension.mjs --check [--dir <folder>]   # the folder (default vendor/chrome-extension) matches the lock
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { log } from 'node:console';
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const VENDOR = path.join(root, 'vendor', 'chrome-extension');
const LOCK = path.join(root, 'vendor', 'chrome-extension.lock.json');
const REPOSITORY = 'https://github.com/zyg-edge/marley-browser-extension';
const FOLDER = 'chrome-extension';
const DEVELOPER_CHANNEL = 'export const SITE_INSTALL = false;';

/** Every regular file under `dir` (relative, sorted, `/` separators); a link or any other kind of entry is refused. */
export function listFiles(dir, prefix = '') {
  const out = [];
  for (const name of readdirSync(path.join(dir, prefix)).sort()) {
    const rel = prefix ? `${prefix}/${name}` : name;
    const stat = lstatSync(path.join(dir, rel));
    if (stat.isSymbolicLink()) throw new Error(`${rel} is a symbolic link`);
    if (stat.isDirectory()) out.push(...listFiles(dir, rel));
    else if (stat.isFile()) out.push(rel);
    else throw new Error(`${rel} is not a regular file`);
  }
  return out;
}

export function hashTree(dir) {
  const files = Object.fromEntries(
    listFiles(dir).map((rel) => [
      rel,
      createHash('sha256')
        .update(readFileSync(path.join(dir, rel)))
        .digest('hex'),
    ]),
  );
  const tree = createHash('sha256')
    .update(
      Object.entries(files)
        .map(([rel, sha]) => `${rel}\0${sha}\n`)
        .join(''),
    )
    .digest('hex');
  return { files, treeSha256: tree };
}

/** The developer channel: the local Marshal socket opens only when both hold. */
export function checkDeveloperChannel(dir) {
  const channel = readFileSync(path.join(dir, 'install-channel.js'), 'utf8');
  if (!channel.includes(DEVELOPER_CHANNEL))
    throw new Error(
      `install-channel.js does not say "${DEVELOPER_CHANNEL}" (a site or store build)`,
    );
  const manifest = JSON.parse(readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  if ('update_url' in manifest) throw new Error('manifest.json has update_url (a store build)');
  return manifest;
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function check(dir) {
  const lock = JSON.parse(readFileSync(LOCK, 'utf8'));
  const actual = hashTree(dir);
  checkDeveloperChannel(dir);
  const problems = [];
  for (const [rel, sha] of Object.entries(lock.files))
    if (actual.files[rel] !== sha)
      problems.push(`${rel}: ${actual.files[rel] ? 'changed' : 'missing'}`);
  for (const rel of Object.keys(actual.files))
    if (!(rel in lock.files)) problems.push(`${rel}: not in the lock`);
  if (actual.treeSha256 !== lock.treeSha256) problems.push('tree hash differs');
  if (problems.length)
    throw new Error(`${dir} does not match ${LOCK}:\n  ${problems.join('\n  ')}`);
  log(
    `ok: ${dir} matches ${lock.repository}@${lock.commit.slice(0, 7)} (${String(Object.keys(lock.files).length)} files)`,
  );
}

function sync(repo, commit) {
  const resolved = execFileSync('git', ['-C', repo, 'rev-parse', `${commit}^{commit}`], {
    encoding: 'utf8',
  }).trim();
  // Pinned to main: an unmerged branch (such as #4) is never vendored.
  execFileSync('git', ['-C', repo, 'merge-base', '--is-ancestor', resolved, 'origin/main']);
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'mb-chrome-extension-'));
  try {
    const archive = execFileSync('git', ['-C', repo, 'archive', '--format=tar', resolved, FOLDER]);
    execFileSync('tar', ['-x', '-C', scratch], { input: archive });
    const source = path.join(scratch, FOLDER);
    const manifest = checkDeveloperChannel(source);
    const { files, treeSha256 } = hashTree(source);
    rmSync(VENDOR, { recursive: true, force: true });
    for (const rel of Object.keys(files)) {
      mkdirSync(path.dirname(path.join(VENDOR, rel)), { recursive: true });
      writeFileSync(path.join(VENDOR, rel), readFileSync(path.join(source, rel)));
    }
    const lock = {
      repository: REPOSITORY,
      branch: 'main',
      commit: resolved,
      path: FOLDER,
      channel: 'developer',
      version: manifest.version,
      files,
      treeSha256,
    };
    writeFileSync(LOCK, `${JSON.stringify(lock, null, 2)}\n`);
    log(
      `vendored ${REPOSITORY}@${resolved.slice(0, 7)} (${String(Object.keys(files).length)} files, Marley ${manifest.version})`,
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--check')) check(path.resolve(argument('--dir') ?? VENDOR));
  else {
    const repo = argument('--repo');
    const commit = argument('--commit') ?? 'origin/main';
    if (!repo)
      throw new Error('--repo <checkout of zyg-edge/marley-browser-extension> is required');
    sync(path.resolve(repo), commit);
  }
}
