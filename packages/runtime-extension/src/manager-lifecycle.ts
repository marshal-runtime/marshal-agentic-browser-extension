import path from 'node:path';
import {
  createMarshalRuntimeHostBridge,
  PANEL_FOCUS_TOOL_ID,
  PANEL_OPEN_OR_FOCUS_TOOL_ID,
  PANEL_OPEN_TOOL_ID,
  type MarshalRuntimeHostBridge,
  type MarshalRuntimeHostBridgeOptions,
} from './host.js';
import type { InvocationContext } from './contracts.js';

export const MARSHAL_BROWSER_EXTENSION_IDENTITY = '@agentic-browser/marshal-runtime-extension';

export interface MarshalRuntimeExtensionIntegrity {
  readonly algorithm: 'sha256';
  readonly domain: 'marshal-runtime-extension-package-v1';
  readonly value: string;
}

export interface MarshalRuntimeExtensionRecord {
  readonly identity: string;
  readonly version: string;
  readonly integrity: MarshalRuntimeExtensionIntegrity;
  readonly entrypoint: string;
  readonly status: 'enabled' | 'disabled';
}

export interface MarshalRuntimeExtensionManagerPort {
  install(request: MarshalRuntimeExtensionInstallRequest): Promise<MarshalRuntimeExtensionRecord>;
  enable(identity: string): Promise<MarshalRuntimeExtensionRecord>;
  get(identity: string): MarshalRuntimeExtensionRecord | undefined;
  remove(identity: string): Promise<void>;
  dispose(): Promise<void>;
}

export interface MarshalRuntimeExtensionInstallRequest {
  readonly packageRoot: string;
  readonly integrity: MarshalRuntimeExtensionIntegrity;
}

export interface MarshalRuntimeExtensionContracts<TKernel = unknown, TLoader = unknown> {
  readonly computeRuntimeExtensionIntegrity: (
    packageRoot: string,
  ) => MarshalRuntimeExtensionIntegrity;
  readonly LocalRuntimeExtensionPackageLoader: new (options: {
    readonly allowedRoots: readonly string[];
    readonly modules: Readonly<Record<string, unknown>>;
  }) => TLoader;
  readonly RuntimeExtensionManager: new (options: {
    readonly kernel: TKernel;
    readonly loader: TLoader;
    readonly activationContext: InvocationContext;
  }) => MarshalRuntimeExtensionManagerPort;
}

export interface PersistedMarshalBrowserExtensionState {
  readonly schemaVersion: 1;
  readonly identity: typeof MARSHAL_BROWSER_EXTENSION_IDENTITY;
  readonly packageRoot: string;
  readonly integrity: MarshalRuntimeExtensionIntegrity;
  readonly enabled: true;
}

export interface MarshalBrowserExtensionStateStore {
  read(): Promise<unknown>;
  write(state: PersistedMarshalBrowserExtensionState): Promise<void>;
}

export interface MarshalBrowserExtensionLifecycleOptions<TKernel = unknown, TLoader = unknown> {
  readonly marshal: MarshalRuntimeExtensionContracts<TKernel, TLoader>;
  readonly kernel: TKernel;
  readonly activationContext: InvocationContext;
  readonly packageRoot: string;
  readonly allowedRoots: readonly string[];
  readonly stateStore: MarshalBrowserExtensionStateStore;
  readonly host: MarshalRuntimeHostBridgeOptions;
}

export interface MarshalPanelHostToolAdapter {
  readonly toolIds: readonly [
    typeof PANEL_OPEN_TOOL_ID,
    typeof PANEL_FOCUS_TOOL_ID,
    typeof PANEL_OPEN_OR_FOCUS_TOOL_ID,
  ];
  invoke(toolId: string, input: unknown, context: InvocationContext): Promise<unknown>;
}

export interface MarshalBrowserExtensionLifecycle {
  readonly manager: MarshalRuntimeExtensionManagerPort;
  readonly hostBridge: MarshalRuntimeHostBridge;
  readonly panelTools: MarshalPanelHostToolAdapter;
  install(): Promise<MarshalRuntimeExtensionRecord>;
  restore(): Promise<MarshalRuntimeExtensionRecord>;
  start(): Promise<MarshalRuntimeExtensionRecord>;
  dispose(): Promise<void>;
}

export function createMarshalBrowserExtensionLifecycle<TKernel, TLoader>(
  options: MarshalBrowserExtensionLifecycleOptions<TKernel, TLoader>,
): MarshalBrowserExtensionLifecycle {
  if (options.allowedRoots.length === 0) {
    throw new TypeError('At least one Marshal runtime extension allowed root is required');
  }
  const packageRoot = path.resolve(options.packageRoot);
  const hostBridge = createMarshalRuntimeHostBridge(options.host);
  const loader = new options.marshal.LocalRuntimeExtensionPackageLoader({
    allowedRoots: options.allowedRoots,
    modules: { '@agentic-browser/runtime-host': hostBridge },
  });
  const manager = new options.marshal.RuntimeExtensionManager({
    kernel: options.kernel,
    loader,
    activationContext: options.activationContext,
  });
  let operation = Promise.resolve<MarshalRuntimeExtensionRecord | undefined>(undefined);

  const exclusive = (
    callback: () => Promise<MarshalRuntimeExtensionRecord>,
  ): Promise<MarshalRuntimeExtensionRecord> => {
    const next = operation.then(callback, callback);
    operation = next;
    return next;
  };

  const activate = async (
    request: MarshalRuntimeExtensionInstallRequest,
  ): Promise<{
    readonly record: MarshalRuntimeExtensionRecord;
    readonly newlyInstalled: boolean;
  }> => {
    const existing = manager.get(MARSHAL_BROWSER_EXTENSION_IDENTITY);
    if (existing) {
      assertMatchingRecord(existing, request.integrity);
      const record =
        existing.status === 'enabled'
          ? existing
          : manager.enable(MARSHAL_BROWSER_EXTENSION_IDENTITY);
      return { record: await record, newlyInstalled: false };
    }
    const installed = await manager.install(request);
    assertMatchingRecord(installed, request.integrity);
    return { record: installed, newlyInstalled: true };
  };

  const install = (): Promise<MarshalRuntimeExtensionRecord> =>
    exclusive(async () => {
      const integrity = options.marshal.computeRuntimeExtensionIntegrity(packageRoot);
      const request = { packageRoot, integrity };
      const activated = await activate(request);
      try {
        await options.stateStore.write(toPersistedState(packageRoot, activated.record));
      } catch (error) {
        if (activated.newlyInstalled) {
          await rollbackInstall(manager, activated.record.identity, error);
        }
        throw error;
      }
      return activated.record;
    });

  const restore = (): Promise<MarshalRuntimeExtensionRecord> =>
    exclusive(async () => {
      const state = validatePersistedState(await options.stateStore.read());
      if (!state) {
        throw new Error('Marshal browser extension has no persisted installation state');
      }
      if (!samePath(state.packageRoot, packageRoot)) {
        throw new Error('Persisted Marshal browser extension package root does not match');
      }
      return (await activate({ packageRoot, integrity: state.integrity })).record;
    });

  const start = (): Promise<MarshalRuntimeExtensionRecord> =>
    exclusive(async () => {
      const state = validatePersistedState(await options.stateStore.read());
      if (!state) {
        const integrity = options.marshal.computeRuntimeExtensionIntegrity(packageRoot);
        const activated = await activate({ packageRoot, integrity });
        try {
          await options.stateStore.write(toPersistedState(packageRoot, activated.record));
        } catch (error) {
          if (activated.newlyInstalled) {
            await rollbackInstall(manager, activated.record.identity, error);
          }
          throw error;
        }
        return activated.record;
      }
      if (!samePath(state.packageRoot, packageRoot)) {
        throw new Error('Persisted Marshal browser extension package root does not match');
      }
      return (await activate({ packageRoot, integrity: state.integrity })).record;
    });

  const panelTools: MarshalPanelHostToolAdapter = Object.freeze({
    toolIds: Object.freeze([
      PANEL_OPEN_TOOL_ID,
      PANEL_FOCUS_TOOL_ID,
      PANEL_OPEN_OR_FOCUS_TOOL_ID,
    ] as const),
    invoke: (toolId: string, input: unknown, context: InvocationContext) =>
      hostBridge.invokePanelHostToolForInvocation(toolId, input, context),
  });

  return {
    manager,
    hostBridge,
    panelTools,
    install,
    restore,
    start,
    dispose: () => manager.dispose(),
  };
}

function validatePersistedState(value: unknown): PersistedMarshalBrowserExtensionState | undefined {
  if (value === undefined) return undefined;
  if (
    !isRecord(value) ||
    value['schemaVersion'] !== 1 ||
    value['identity'] !== MARSHAL_BROWSER_EXTENSION_IDENTITY ||
    value['enabled'] !== true ||
    typeof value['packageRoot'] !== 'string' ||
    !value['packageRoot'] ||
    !isRecord(value['integrity']) ||
    value['integrity']['algorithm'] !== 'sha256' ||
    value['integrity']['domain'] !== 'marshal-runtime-extension-package-v1' ||
    typeof value['integrity']['value'] !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value['integrity']['value'])
  ) {
    throw new Error('Persisted Marshal browser extension state is invalid');
  }
  return {
    schemaVersion: 1,
    identity: MARSHAL_BROWSER_EXTENSION_IDENTITY,
    enabled: true,
    packageRoot: value['packageRoot'],
    integrity: {
      algorithm: 'sha256',
      domain: 'marshal-runtime-extension-package-v1',
      value: value['integrity']['value'],
    },
  };
}

function toPersistedState(
  packageRoot: string,
  record: MarshalRuntimeExtensionRecord,
): PersistedMarshalBrowserExtensionState {
  if (record.identity !== MARSHAL_BROWSER_EXTENSION_IDENTITY || record.status !== 'enabled') {
    throw new Error('Marshal browser extension manager returned an unexpected record');
  }
  return {
    schemaVersion: 1,
    identity: MARSHAL_BROWSER_EXTENSION_IDENTITY,
    packageRoot,
    integrity: record.integrity,
    enabled: true,
  };
}

function assertMatchingRecord(
  record: MarshalRuntimeExtensionRecord,
  integrity: MarshalRuntimeExtensionIntegrity,
): void {
  if (
    record.identity !== MARSHAL_BROWSER_EXTENSION_IDENTITY ||
    record.integrity.value !== integrity.value
  ) {
    throw new Error('Active Marshal browser extension does not match the pinned installation');
  }
}

async function rollbackInstall(
  manager: MarshalRuntimeExtensionManagerPort,
  identity: string,
  persistenceError: unknown,
): Promise<never> {
  try {
    await manager.remove(identity);
  } catch (rollbackError) {
    throw new AggregateError(
      [persistenceError, rollbackError],
      'Failed to persist and roll back the Marshal browser extension installation',
    );
  }
  throw persistenceError;
}

function samePath(left: string, right: string): boolean {
  const normalizedLeft = path.normalize(path.resolve(left));
  const normalizedRight = path.normalize(path.resolve(right));
  return process.platform === 'win32'
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
