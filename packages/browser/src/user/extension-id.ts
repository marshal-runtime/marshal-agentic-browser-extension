/**
 * Chrome's id for an extension whose manifest carries a `key` (the base64 DER public key): the first 16 bytes of its
 * sha256, each hex digit mapped 0-f to a-p. The carried Marley Chrome extension has a `key`, so its id is fixed and the
 * bridge accepts only `chrome-extension://<that id>`.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'fs';
import path from 'node:path';

export function extensionIdFromKey(keyBase64: string): string {
  return createHash('sha256')
    .update(Buffer.from(keyBase64, 'base64'))
    .digest('hex')
    .slice(0, 32)
    .replace(/[0-9a-f]/g, (digit) => String.fromCharCode(97 + parseInt(digit, 16)));
}

/** The id of the extension in `folder`, or undefined when its manifest has no usable `key`. */
export function extensionIdOf(folder: string): string | undefined {
  try {
    const { key } = JSON.parse(readFileSync(path.join(folder, 'manifest.json'), 'utf8')) as {
      key?: unknown;
    };
    return typeof key === 'string' && key.length > 0 ? extensionIdFromKey(key) : undefined;
  } catch {
    return undefined;
  }
}

export const EXTENSION_ID = /^[a-p]{32}$/;
