import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('runtime extension package contract', () => {
  it('has a strict Marshal manifest aligned with package.json', () => {
    const manifest = JSON.parse(
      readFileSync(path.join(packageRoot, 'runtime-extension.json'), 'utf8'),
    ) as Record<string, unknown>;
    const packageJson = JSON.parse(
      readFileSync(path.join(packageRoot, 'package.json'), 'utf8'),
    ) as Record<string, unknown>;

    expect(Object.keys(manifest).sort()).toEqual(
      ['entrypoint', 'identity', 'moduleFormat', 'schemaVersion', 'version'].sort(),
    );
    expect(manifest).toEqual({
      schemaVersion: 1,
      identity: packageJson['name'],
      version: packageJson['version'],
      entrypoint: packageJson['main'],
      moduleFormat: 'commonjs-bundle-v1',
    });
    expect(packageJson['type']).toBe('commonjs');
    expect(packageJson['types']).toBe('dist/types/runtime.d.ts');
    expect(packageJson['exports']).toMatchObject({
      '.': { types: './dist/types/runtime.d.ts', require: './dist/runtime.cjs' },
      './host': { types: './dist/types/host.d.ts', require: './dist/host.cjs' },
    });
    expect(String(manifest['entrypoint'])).toMatch(/\.cjs$/);
  });
});
