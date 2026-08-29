import { execFileSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createMarshalBrowserExtensionLifecycle,
  MARSHAL_BROWSER_EXTENSION_IDENTITY,
  PANEL_FOCUS_TOOL_ID,
  type MarshalBrowserExtensionStateStore,
  type MarshalRuntimeExtensionContracts,
  type PersistedMarshalBrowserExtensionState,
} from '../src/host.js';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const sourcePackageRoot = path.join(repositoryRoot, 'packages', 'runtime-extension');
const marshalRuntimeRoot = process.env['MARSHAL_RUNTIME_ROOT'];
const contractDescribe = marshalRuntimeRoot ? describe : describe.skip;
const tempRoots: string[] = [];
const runtimeBundlePath = path.join(sourcePackageRoot, 'dist', 'runtime.cjs');
const hostBundlePath = path.join(sourcePackageRoot, 'dist', 'host.cjs');

let fixturePackageRoot = '';
let marshal: MarshalRuntimeExtensionContracts;
let createRuntimeKernel: (options: unknown) => unknown;
let createAllowAllPermissionBroker: () => unknown;

contractDescribe('Marshal manager lifecycle contract', () => {
  beforeAll(async () => {
    if (!marshalRuntimeRoot) return;
    buildRuntimeExtensionIfNeeded();
    fixturePackageRoot = snapshotPackageFixture();
    const extensionsUrl = pathToFileURL(
      path.join(marshalRuntimeRoot, 'packages', 'agent-runtime-extensions', 'dist', 'index.js'),
    ).href;
    const coreUrl = pathToFileURL(
      path.join(marshalRuntimeRoot, 'packages', 'agent-runtime-core', 'dist', 'index.js'),
    ).href;
    const extensionModule: unknown = await import(/* @vite-ignore */ extensionsUrl);
    const coreModule: unknown = await import(/* @vite-ignore */ coreUrl);
    if (
      !isRecord(coreModule) ||
      typeof coreModule['createRuntimeKernel'] !== 'function' ||
      typeof coreModule['createAllowAllPermissionBroker'] !== 'function'
    ) {
      throw new Error('Built Marshal runtime core exports are unavailable');
    }
    marshal = extensionModule as MarshalRuntimeExtensionContracts;
    createRuntimeKernel = coreModule['createRuntimeKernel'] as typeof createRuntimeKernel;
    createAllowAllPermissionBroker = coreModule[
      'createAllowAllPermissionBroker'
    ] as typeof createAllowAllPermissionBroker;
  }, 120_000);

  afterAll(() => {
    for (const root of tempRoots.splice(0).reverse()) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('installs once, persists enablement, restores on a new manager, and wires panel context', async () => {
    const packageRoot = materializePackage();
    const store = memoryStore();
    const firstPanelFocus = vi.fn().mockResolvedValue({ focused: true });
    const first = integration(packageRoot, store, firstPanelFocus);

    const [one, two] = await Promise.all([first.lifecycle.start(), first.lifecycle.start()]);

    expect(one).toEqual(two);
    expect(one).toMatchObject({
      identity: MARSHAL_BROWSER_EXTENSION_IDENTITY,
      status: 'enabled',
    });
    expect(first.lifecycle.manager.get(MARSHAL_BROWSER_EXTENSION_IDENTITY)).toEqual(one);
    await expect(first.kernel.get('browser_navigate', invocationContext())).resolves.toMatchObject({
      provider: { id: 'agentic-browser.extension' },
    });

    const resolved = first.lifecycle.hostBridge.resolveBrowserSession?.(invocationContext());
    await first.lifecycle.panelTools.invoke(
      PANEL_FOCUS_TOOL_ID,
      { source: 'catalog' },
      invocationContext(),
    );
    expect(firstPanelFocus).toHaveBeenCalledWith({
      toolId: PANEL_FOCUS_TOOL_ID,
      input: { source: 'catalog' },
      context: resolved?.context,
    });
    expect(store.state?.integrity).toEqual(one.integrity);
    await first.lifecycle.dispose();

    const restarted = integration(packageRoot, store, vi.fn());
    await expect(restarted.lifecycle.restore()).resolves.toMatchObject({
      identity: MARSHAL_BROWSER_EXTENSION_IDENTITY,
      status: 'enabled',
      integrity: one.integrity,
    });
    await expect(
      restarted.kernel.get('browser_navigate', invocationContext()),
    ).resolves.toMatchObject({ provider: { id: 'agentic-browser.extension' } });
    await restarted.lifecycle.dispose();
  });

  it('fails closed for changed package integrity after restart', async () => {
    const packageRoot = materializePackage();
    const store = memoryStore();
    const first = integration(packageRoot, store, vi.fn());
    await first.lifecycle.start();
    await first.lifecycle.dispose();
    writeFileSync(path.join(packageRoot, 'README.md'), 'tampered after install', 'utf8');

    const restarted = integration(packageRoot, store, vi.fn());
    await expect(restarted.lifecycle.restore()).rejects.toMatchObject({
      code: 'INTEGRITY_MISMATCH',
    });
    expect(restarted.lifecycle.manager.get(MARSHAL_BROWSER_EXTENSION_IDENTITY)).toBeUndefined();
    await restarted.lifecycle.dispose();
  });

  it('fails closed for an invalid manifest and a package outside the allowed root', async () => {
    const invalidPackage = materializePackage();
    const manifestPath = path.join(invalidPackage, 'runtime-extension.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
    writeFileSync(manifestPath, JSON.stringify({ ...manifest, schemaVersion: 2 }), 'utf8');
    const invalid = integration(invalidPackage, memoryStore(), vi.fn());
    await expect(invalid.lifecycle.start()).rejects.toMatchObject({ code: 'INVALID_MANIFEST' });
    await invalid.lifecycle.dispose();

    const packageRoot = materializePackage();
    const deniedRoot = temporaryDirectory('marshal-browser-denied-root-');
    const denied = integration(packageRoot, memoryStore(), vi.fn(), [deniedRoot]);
    await expect(denied.lifecycle.start()).rejects.toMatchObject({ code: 'ROOT_NOT_ALLOWED' });
    await denied.lifecycle.dispose();
  });
});

function integration(
  packageRoot: string,
  stateStore: MarshalBrowserExtensionStateStore,
  focus: ReturnType<typeof vi.fn>,
  allowedRoots: readonly string[] = [path.dirname(packageRoot)],
): {
  readonly kernel: TestKernel;
  readonly lifecycle: ReturnType<typeof createMarshalBrowserExtensionLifecycle>;
} {
  const kernel = createRuntimeKernel({
    permissionBroker: createAllowAllPermissionBroker(),
  }) as TestKernel;
  const lifecycle = createMarshalBrowserExtensionLifecycle({
    marshal,
    kernel,
    activationContext: invocationContext(),
    packageRoot,
    allowedRoots,
    stateStore,
    host: {
      lifecycle: {
        apply: async (_kind, request, callback) => callback(request),
      },
      panel: {
        open: vi.fn(),
        focus,
        openOrFocus: vi.fn(),
      },
      nativeMessagingHostPath: 'unused-contract-test-host',
    },
  });
  return { kernel, lifecycle };
}

function invocationContext(): {
  readonly principal: { readonly id: string; readonly kind: string };
  readonly identity: { readonly harnessId: string; readonly installationId: string };
  readonly scope: { readonly workspaceId: string; readonly sessionId: string };
  readonly executionId: string;
} {
  return {
    principal: { id: 'contract-user', kind: 'user' },
    identity: { harnessId: 'marshal', installationId: 'contract-installation' },
    scope: { workspaceId: 'workspace-1', sessionId: 'chat-1' },
    executionId: 'execution-1',
  };
}

function memoryStore(): MarshalBrowserExtensionStateStore & {
  state?: PersistedMarshalBrowserExtensionState;
} {
  return {
    state: undefined,
    read() {
      return Promise.resolve(this.state);
    },
    write(state) {
      this.state = state;
      return Promise.resolve();
    },
  };
}

function materializePackage(): string {
  const root = temporaryDirectory('marshal-browser-package-root-');
  const packageRoot = path.join(root, 'browser-extension');
  mkdirSync(packageRoot);
  for (const relativePath of ['package.json', 'runtime-extension.json', 'README.md', 'dist']) {
    cpSync(path.join(fixturePackageRoot, relativePath), path.join(packageRoot, relativePath), {
      recursive: true,
    });
  }
  return packageRoot;
}

function snapshotPackageFixture(): string {
  const root = temporaryDirectory('marshal-browser-package-fixture-');
  const packageRoot = path.join(root, 'runtime-extension');
  mkdirSync(packageRoot);
  for (const relativePath of ['package.json', 'runtime-extension.json', 'README.md', 'dist']) {
    cpSync(path.join(sourcePackageRoot, relativePath), path.join(packageRoot, relativePath), {
      recursive: true,
    });
  }
  return packageRoot;
}

function buildRuntimeExtensionIfNeeded(): void {
  if (existsSync(runtimeBundlePath) && existsSync(hostBundlePath)) return;

  const npmExecPath = process.env['npm_execpath'];
  if (!npmExecPath) {
    throw new Error(
      'npm_execpath is required to build the Marshal runtime extension contract fixture',
    );
  }
  execFileSync(process.execPath, [npmExecPath, 'run', 'build:runtime-extension'], {
    cwd: repositoryRoot,
    stdio: 'pipe',
  });
}

function temporaryDirectory(prefix: string): string {
  const root = mkdtempSync(path.join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

interface TestKernel {
  get(name: string, context: ReturnType<typeof invocationContext>): Promise<unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
