import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  RuntimeExtensionActivation,
  RuntimeExtensionActivationContext,
  RuntimeExtensionManifest,
} from '../src/contracts.js';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const packageRoot = path.join(repositoryRoot, 'packages', 'runtime-extension');
const cliEntry = path.join(repositoryRoot, 'packages', 'cli', 'dist', 'index.js');
const npmExecPath = process.env['npm_execpath'];
const smokeRoot = mkdtempSync(path.join(tmpdir(), 'marshal-runtime-extension-'));

let packedIntegrity = '';
let repeatedIntegrity = '';
let installedPackageRoot = '';
let manifest: RuntimeExtensionManifest;
let activation: RuntimeExtensionActivation;

describe('installed Marshal runtime extension package', () => {
  beforeAll(() => {
    if (!npmExecPath) {
      throw new Error('npm_execpath is required for the installed package smoke test');
    }

    execFileSync(process.execPath, [npmExecPath, 'run', 'build:cli'], {
      cwd: repositoryRoot,
      stdio: 'pipe',
    });
    const firstTarball = packRuntimeExtension();
    packedIntegrity = sha256(firstTarball);
    const secondTarball = packRuntimeExtension();
    repeatedIntegrity = sha256(secondTarball);

    writeFileSync(
      path.join(smokeRoot, 'package.json'),
      JSON.stringify({ name: 'runtime-extension-smoke', private: true }),
    );
    execFileSync(
      process.execPath,
      [
        npmExecPath,
        'install',
        secondTarball,
        '--ignore-scripts',
        '--no-package-lock',
        '--no-audit',
        '--no-fund',
      ],
      { cwd: smokeRoot, stdio: 'pipe' },
    );

    installedPackageRoot = path.join(
      smokeRoot,
      'node_modules',
      '@agentic-browser',
      'marshal-runtime-extension',
    );
    const hostRoot = path.join(smokeRoot, 'node_modules', '@agentic-browser', 'runtime-host');
    mkdirSync(hostRoot, { recursive: true });
    writeFileSync(
      path.join(hostRoot, 'package.json'),
      JSON.stringify({ name: '@agentic-browser/runtime-host', main: 'index.cjs' }),
    );
    writeFileSync(
      path.join(hostRoot, 'index.cjs'),
      [
        'let id = 0;',
        'module.exports = {',
        '  createId: (kind) => `${kind}-${++id}`,',
        "  now: () => '2026-08-16T00:00:00.000Z',",
        '  invokeBrowserCommand: async () => ({ success: true }),',
        '  invokeSecretType: async () => ({ success: true }),',
        '  publishLifecycleEvent: async () => {},',
        '  openOrFocusPanel: async () => {},',
        '};',
      ].join('\n'),
    );

    manifest = JSON.parse(
      readFileSync(path.join(installedPackageRoot, 'runtime-extension.json'), 'utf8'),
    ) as RuntimeExtensionManifest;
    const requireFromInstall = createRequire(path.join(smokeRoot, 'smoke.cjs'));
    const runtime = requireFromInstall(path.join(installedPackageRoot, manifest.entrypoint)) as {
      activate(context: RuntimeExtensionActivationContext): RuntimeExtensionActivation;
    };
    activation = runtime.activate({
      manifest,
      search: async () => [],
      execute: async () => ({}),
    });
  }, 120_000);

  afterAll(() => {
    rmSync(smokeRoot, { recursive: true, force: true });
    if (npmExecPath) {
      execFileSync(
        process.execPath,
        [npmExecPath, 'run', 'clean', '--workspace', 'packages/runtime-extension'],
        { cwd: repositoryRoot, stdio: 'pipe' },
      );
    }
  });

  it('packs with reproducible SHA-256 integrity', () => {
    expect(packedIntegrity).toMatch(/^[a-f0-9]{64}$/);
    expect(repeatedIntegrity).toBe(packedIntegrity);
  });

  it('installs a manifest whose CommonJS entrypoint matches the package', () => {
    const packageJson = JSON.parse(
      readFileSync(path.join(installedPackageRoot, 'package.json'), 'utf8'),
    ) as Record<string, unknown>;
    expect(manifest).toEqual({
      schemaVersion: 1,
      identity: packageJson['name'],
      version: packageJson['version'],
      entrypoint: packageJson['main'],
      moduleFormat: 'commonjs-bundle-v1',
    });
    expect(readFileSync(path.join(installedPackageRoot, manifest.entrypoint))).not.toHaveLength(0);
  });

  it('activates from the installed bundled entrypoint with the injected host module', async () => {
    const provider = activation.capabilityProviders?.[0];
    expect(provider).toBeDefined();
    const descriptors = await provider?.list({
      principal: { id: 'smoke-user', kind: 'user' },
      scope: { sessionId: 'smoke-chat' },
      executionId: 'smoke-execution',
    });
    expect(descriptors?.some((descriptor) => descriptor.name === 'browser_navigate')).toBe(true);
    expect(activation.catalogProviders?.[0]).toBeDefined();
  });

  it('keeps the direct CLI entrypoint independent and operational', () => {
    const result = spawnSync(process.execPath, [cliEntry, '--help'], {
      cwd: repositoryRoot,
      encoding: 'utf8',
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('Agentic Browser CLI');
    expect(result.stderr).toContain('navigate <url>');
    expect(result.stderr).toContain('list-targets');
  });
});

function packRuntimeExtension(): string {
  if (!npmExecPath) {
    throw new Error('npm_execpath is required');
  }
  const output = execFileSync(
    process.execPath,
    [npmExecPath, 'pack', packageRoot, '--json', '--pack-destination', smokeRoot],
    { cwd: repositoryRoot, encoding: 'utf8' },
  );
  const result = JSON.parse(output) as Array<{ filename: string }>;
  const filename = result[0]?.filename;
  if (!filename) {
    throw new Error('npm pack did not return an artifact filename');
  }
  return path.join(smokeRoot, filename);
}

function sha256(filePath: string): string {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}
