import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DESCRIPTORS } from '../src/descriptors.js';

const manifest = JSON.parse(
  readFileSync(fileURLToPath(new URL('../runtime-extension.json', import.meta.url)), 'utf8'),
) as {
  identity: string;
  schemaVersion: number;
  moduleFormat: string;
  entrypoint: string;
  dependencies?: unknown;
  agentGuidance: Record<string, string>;
  contributes: { capabilities: string[] };
  configuration: { schema: { additionalProperties: boolean } };
};
const bundlePath = fileURLToPath(new URL('../dist/runtime.cjs', import.meta.url));

describe('runtime-extension.json', () => {
  it('declares the @marshal/browser identity, a portable .cjs entrypoint and no extension dependency', () => {
    expect(manifest.identity).toBe('@marshal/browser');
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.moduleFormat).toBe('commonjs-bundle-v1');
    expect(manifest.entrypoint).toBe('dist/runtime.cjs');
    expect(manifest.dependencies).toBeUndefined();
    expect(manifest.configuration.schema.additionalProperties).toBe(false);
  });

  it('contributes exactly the capabilities the provider describes', () => {
    expect([...manifest.contributes.capabilities].sort()).toEqual(
      DESCRIPTORS.map((descriptor) => descriptor.name).sort(),
    );
  });

  it('keeps every agentGuidance field within 300 characters', () => {
    for (const key of ['purpose', 'when', 'recipe', 'boundaries']) {
      const value = manifest.agentGuidance[key];
      expect(value, key).toBeTruthy();
      expect((value as string).length, key).toBeLessThanOrEqual(300);
    }
  });

  it('declares closed object schemas for every capability', () => {
    for (const descriptor of DESCRIPTORS) {
      expect(descriptor.inputSchema?.['type'], descriptor.name).toBe('object');
      expect(descriptor.inputSchema?.['additionalProperties'], descriptor.name).toBe(false);
      expect(descriptor.outputSchema['type'], descriptor.name).toBe('object');
      expect(descriptor.outputSchema['additionalProperties'], descriptor.name).toBe(false);
    }
  });
});

describe('dist/runtime.cjs', () => {
  const bundle = existsSync(bundlePath) ? readFileSync(bundlePath, 'utf8') : '';

  it('is built (run `npm run build` first)', () => {
    expect(bundle.length).toBeGreaterThan(0);
  });

  // Exactly DEFAULT_NODE_BUILTIN_MODULES of the host's extension loader (same list as
  // automation-extension's manifest test): no node:fs, no readline, no net.
  it('requires only the builtins the extension loader provides', () => {
    const allowed = new Set([
      'buffer',
      'events',
      'fs',
      'http',
      'https',
      'node:child_process',
      'node:crypto',
      'node:fs/promises',
      'node:os',
      'node:path',
      'node:sqlite',
      'node:url',
      'node:util',
      'os',
      'path',
      'stream',
      'tty',
      'url',
      'util',
      'zlib',
    ]);
    const required = [...bundle.matchAll(/require\("([^"]+)"\)/g)].map(
      (match) => match[1] as string,
    );
    expect(required.length).toBeGreaterThan(0);
    expect(required.filter((name) => !allowed.has(name))).toEqual([]);
  });

  it('holds no model provider: no endpoint, key name, model name or Jev dependency (models only through marshal.models.decide)', () => {
    for (const forbidden of [
      'api.openai.com',
      'OPENAI_API_KEY',
      'typesafe.ai',
      '@marshal/jev',
      'gpt-',
      'claude-',
      'anthropic',
      '/v1/decisions',
    ]) {
      expect(bundle.includes(forbidden), forbidden).toBe(false);
    }
    expect(bundle).toContain('marshal.models.decide');
  });

  it('never intercepts a request (no Fetch domain, no request interception): rule SB21', () => {
    for (const forbidden of [
      'Fetch.enable',
      'Fetch.',
      'setRequestInterception',
      'Network.setBlockedURLs',
    ]) {
      expect(bundle.includes(forbidden), forbidden).toBe(false);
    }
  });

  it('opens no debugging port (pipe only)', () => {
    expect(bundle).toContain('--remote-debugging-pipe');
    expect(bundle.includes('--remote-debugging-port')).toBe(false);
  });
});
