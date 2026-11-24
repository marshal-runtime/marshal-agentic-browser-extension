/**
 * Gives the carried Chrome extension a folder that outlives this install. Marshal installs each version of an extension
 * into a new folder, so a Chrome extension loaded unpacked from `dist/chrome-extension` would vanish with the next
 * update. At activation the carried files (as listed and hashed in their lock) are copied to a stable folder, by
 * default ~/.marshal/browser/chrome-extension, and setup names that folder. Unchanged files are not rewritten; a new pin
 * replaces the folder in one rename, and Chrome picks it up on its next start (or Reload in chrome://extensions).
 * A link at or inside the target is refused, never followed. When the copy cannot be made, setup names the install's
 * own folder and says why.
 */
import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'fs';
import os from 'node:os';
import path from 'node:path';
import type { CarriedExtension } from './status.js';

export const DEFAULT_CHROME_EXTENSION_DIR = path.join(
  os.homedir(),
  '.marshal',
  'browser',
  'chrome-extension',
);

interface Lock {
  readonly version?: string;
  readonly commit?: string;
  readonly files: Readonly<Record<string, string>>;
}

const sha256 = (data: Buffer): string => createHash('sha256').update(data).digest('hex');

/** True when every locked file is in `folder` with its hash, and nothing in the way is a link. */
function matches(folder: string, lock: Lock): boolean {
  if (!existsSync(folder) || !lstatSync(folder).isDirectory()) return false;
  for (const [rel, hash] of Object.entries(lock.files)) {
    const file = path.join(folder, rel);
    if (!existsSync(file)) return false;
    const stat = lstatSync(file);
    if (!stat.isFile() || sha256(readFileSync(file)) !== hash) return false;
  }
  return true;
}

/** The target and the folder above it are ours to create; a link at either is refused, never followed. */
function refuseLinks(target: string): void {
  for (const entry of [path.dirname(target), target])
    if (existsSync(entry) && lstatSync(entry).isSymbolicLink())
      throw new Error(`${entry} is a symbolic link`);
}

/** The file in the loaded folder the Marley extension (0.5.1+) reads its default local bridge address from. */
export const BRIDGE_FILE = 'marshal-bridge.json';

/**
 * Writes `marshal-bridge.json` ({bridgeUrl}) into the folder Chrome loads, so an unpacked install connects to this
 * Marshal's bridge with no popup step (the extension ignores it on store and site installs, and a value typed in its
 * popup wins). Not part of the lock: it names this machine's port. Returns why it could not be written, or undefined.
 */
export function writeBridgeFile(folder: string, bridgeUrl: string): string | undefined {
  try {
    const file = path.join(folder, BRIDGE_FILE);
    if (existsSync(file) && lstatSync(file).isSymbolicLink())
      throw new Error(`${file} is a symbolic link`);
    const body = `${JSON.stringify({ bridgeUrl })}\n`;
    if (existsSync(file) && readFileSync(file, 'utf8') === body) return undefined;
    writeFileSync(file, body, { mode: 0o644 });
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/**
 * Copies the carried folder (`source`, with `chrome-extension.lock.json` beside it) to `target` unless it already
 * matches. Returns the folder setup should name.
 */
export function installCarriedExtension(
  source: CarriedExtension,
  target: string = DEFAULT_CHROME_EXTENSION_DIR,
): CarriedExtension {
  if (!source.folder) return source;
  try {
    const lock = JSON.parse(
      readFileSync(path.join(source.folder, '..', 'chrome-extension.lock.json'), 'utf8'),
    ) as Lock;
    if (!matches(source.folder, lock))
      throw new Error('the carried folder does not match its lock');
    refuseLinks(target);
    if (!matches(target, lock)) {
      const parent = path.dirname(target);
      mkdirSync(parent, { recursive: true, mode: 0o700 });
      const staged = mkdtempSync(path.join(parent, '.chrome-extension-'));
      try {
        for (const rel of Object.keys(lock.files)) {
          mkdirSync(path.dirname(path.join(staged, rel)), { recursive: true });
          writeFileSync(path.join(staged, rel), readFileSync(path.join(source.folder, rel)), {
            flag: 'wx',
          });
        }
        if (!matches(staged, lock)) throw new Error('the copy does not match the lock');
        const previous = existsSync(target) ? `${staged}.previous` : null;
        if (previous) renameSync(target, previous);
        renameSync(staged, target);
        if (previous) rmSync(previous, { recursive: true, force: true });
      } finally {
        rmSync(staged, { recursive: true, force: true });
      }
    }
    return {
      folder: target,
      ...(lock.version ? { version: lock.version } : {}),
      ...(lock.commit ? { commit: lock.commit } : {}),
      ...(source.extensionId ? { extensionId: source.extensionId } : {}),
    };
  } catch (error) {
    return {
      ...source,
      folderNote: `Could not copy it to ${target} (${error instanceof Error ? error.message : String(error)}); this folder moves when @marshal/browser is updated, so load it again after an update.`,
    };
  }
}
