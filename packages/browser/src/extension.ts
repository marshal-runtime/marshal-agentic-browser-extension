/**
 * dist/runtime.cjs entrypoints.
 *
 * `activate`: the Marshal extension. Its one model dependency is the host's `marshal.models.decide` capability, reached
 * through `context.execute`, and it carries both halves of the person's-Chrome backend: the local bridge started here
 * and the Chrome extension in dist/chrome-extension (each can be switched off: `localBridge`, `carryChromeExtension`).
 *
 * `activateEmbedded`: the same provider for a host that is not Marshal (a brand VM's runtime). Secure by default
 * there: no loopback listener and no extension folder unless configured; the host gives its own decide function,
 * its own transport to the person's Chrome and its own setup words.
 */
import os from 'node:os';
import path from 'node:path';
import { BrowserService, type BrowserConfiguration } from './capabilities.js';
import type {
  InvocationContext,
  RuntimeExecuteFn,
  RuntimeExtensionActivation,
  RuntimeExtensionActivationContext,
} from './contracts.js';
import type { PrepareLaunch } from './chrome/launcher.js';
import { createHostDecider, decideFunctionExecute, type DecideFunction } from './engine/decider.js';
import type { BridgeClient } from './user/bridge.js';
import { DEFAULT_CHROME_EXTENSION_DIR, installCarriedExtension } from './user/carried-folder.js';
import { BRIDGE_PORT, createLocalBridgeClient, LocalBridge } from './user/local-bridge.js';
import { carriedExtension, type UserSetupOverride } from './user/status.js';
import { createWatchApplication } from './watch/app.js';

type Configuration = BrowserConfiguration & Readonly<Record<string, unknown>>;

interface Assembly {
  readonly configuration: Configuration;
  readonly execute?: RuntimeExecuteFn;
  readonly bridgeFor?: (context?: InvocationContext) => BridgeClient;
  readonly userSetup?: UserSetupOverride;
  readonly prepareLaunch?: PrepareLaunch;
  /** Defaults of the switches when configuration leaves them out. */
  readonly defaults: { readonly localBridge: boolean; readonly carryChromeExtension: boolean };
}

async function assemble(assembly: Assembly): Promise<RuntimeExtensionActivation> {
  const { configuration, execute } = assembly;
  const carry = configuration.carryChromeExtension ?? assembly.defaults.carryChromeExtension;
  const listen = configuration.localBridge ?? assembly.defaults.localBridge;
  // The Chrome extension's folder must outlive this install (each update installs elsewhere): a stable copy.
  const carried = carry
    ? installCarriedExtension(
        carriedExtension(),
        configuration.chromeExtensionDir ?? DEFAULT_CHROME_EXTENSION_DIR,
      )
    : carriedExtension();
  let bridge: LocalBridge | null = null;
  let bridgeFor = assembly.bridgeFor;
  if (listen) {
    // Only the carried extension (its fixed id) may connect to the bridge. A port that is taken is reported by
    // browser.status (port_in_use) and retried; activation never fails on it.
    bridge = new LocalBridge(configuration.bridgePort ?? BRIDGE_PORT, {
      ...(carried.extensionId ? { extensionId: carried.extensionId } : {}),
    });
    await bridge.start();
    const client = createLocalBridgeClient(
      bridge,
      path.join(
        configuration.artifactDir ?? path.join(os.tmpdir(), 'marshal-browser'),
        'user-shots',
      ),
      carried,
    );
    // A host's own transport wins over the loopback socket when both are given.
    bridgeFor ??= () => client;
  }
  const decideVia: RuntimeExecuteFn =
    execute ??
    (() =>
      Promise.resolve({
        protocolVersion: '1.0.0',
        status: 'not_found',
        error: { code: 'NOT_FOUND', message: 'this host offers no decide' },
      }));
  const service = new BrowserService(
    (invocation) => createHostDecider(decideVia, invocation),
    configuration,
    bridgeFor,
    {},
    execute,
    {
      ...(assembly.userSetup ? { userSetup: assembly.userSetup } : {}),
      ...(assembly.prepareLaunch ? { prepareLaunch: assembly.prepareLaunch } : {}),
    },
  );
  const stopBridge = bridge;
  return {
    capabilityProviders: [service.provider()],
    uiApplications: [createWatchApplication()],
    dispose: async () => {
      await service.dispose();
      await stopBridge?.stop();
    },
  };
}

export async function activate(
  context: RuntimeExtensionActivationContext<Configuration>,
): Promise<RuntimeExtensionActivation> {
  return assemble({
    configuration: context.configuration,
    execute: context.execute.bind(context),
    defaults: { localBridge: true, carryChromeExtension: true },
  });
}

/** What a host that is not Marshal gives `activateEmbedded`. */
export interface EmbeddedBrowserOptions {
  /** The same keys as runtime-extension.json's configuration (plain JSON). */
  readonly configuration?: Configuration;
  /**
   * The host's decide: `marshal.models.decide`'s input in, its output out. Required unless `execute` answers
   * `marshal.models.decide`; wins over `execute` for that capability when both are given.
   */
  readonly decide?: DecideFunction;
  /** The host's own execute (other capabilities, e.g. opening the watch panel); optional. */
  readonly execute?: RuntimeExecuteFn;
  /** The host's transport to the person's own Chrome (`on: "user"`), per invocation; absent: that backend is off. */
  readonly bridge?: (context?: InvocationContext) => BridgeClient;
  /** The host's own setup words for the person's Chrome (its pairing page), replacing the Load-unpacked steps. */
  readonly userSetup?: UserSetupOverride;
  /** Called before each Chrome start (start a display, Chrome's environment, headed). */
  readonly prepareLaunch?: PrepareLaunch;
}

export async function activateEmbedded(
  options: EmbeddedBrowserOptions,
): Promise<RuntimeExtensionActivation> {
  if (typeof options.decide !== 'function' && typeof options.execute !== 'function')
    throw new Error('BROWSER_BAD_CONFIGURATION: an embedded browser needs decide or execute');
  if (options.bridge !== undefined && typeof options.bridge !== 'function')
    throw new Error('BROWSER_BAD_CONFIGURATION: bridge must be a function returning a client');
  const execute = options.decide
    ? decideFunctionExecute(options.decide, options.execute)
    : options.execute;
  return assemble({
    configuration: options.configuration ?? {},
    ...(execute ? { execute } : {}),
    ...(options.bridge ? { bridgeFor: options.bridge } : {}),
    ...(options.userSetup ? { userSetup: options.userSetup } : {}),
    ...(options.prepareLaunch ? { prepareLaunch: options.prepareLaunch } : {}),
    defaults: { localBridge: false, carryChromeExtension: false },
  });
}
