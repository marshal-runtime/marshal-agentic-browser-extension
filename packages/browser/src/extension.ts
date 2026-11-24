/**
 * dist/runtime.cjs entrypoint. The extension needs nothing from another extension: its one model dependency is the
 * host's `marshal.models.decide` capability, reached through `context.execute`, and it carries both halves of the
 * person's-Chrome backend: the local bridge started here and the Chrome extension in dist/chrome-extension.
 */
import os from 'node:os';
import path from 'node:path';
import { BrowserService, type BrowserConfiguration } from './capabilities.js';
import type { RuntimeExtensionActivation, RuntimeExtensionActivationContext } from './contracts.js';
import { createHostDecider } from './engine/decider.js';
import {
  DEFAULT_CHROME_EXTENSION_DIR,
  installCarriedExtension,
  writeBridgeFile,
} from './user/carried-folder.js';
import {
  BRIDGE_PORT,
  bridgeUrlFor,
  createLocalBridgeClient,
  LocalBridge,
} from './user/local-bridge.js';
import { carriedExtension } from './user/status.js';
import { createWatchApplication } from './watch/app.js';

export async function activate(
  context: RuntimeExtensionActivationContext<
    BrowserConfiguration & Readonly<Record<string, unknown>>
  >,
): Promise<RuntimeExtensionActivation> {
  const execute = context.execute.bind(context);
  const configuration = context.configuration;
  // The Chrome extension's folder must outlive this install (each update installs elsewhere): a stable copy.
  const carried = installCarriedExtension(
    carriedExtension(),
    configuration.chromeExtensionDir ?? DEFAULT_CHROME_EXTENSION_DIR,
  );
  // Only the carried extension (its fixed id) may connect to the bridge. A port that is taken is reported by
  // browser.status (port_in_use) and retried; activation never fails on it.
  const bridgePort = configuration.bridgePort ?? BRIDGE_PORT;
  if (carried.folder) writeBridgeFile(carried.folder, bridgeUrlFor(bridgePort));
  const bridge = new LocalBridge(bridgePort, {
    ...(carried.extensionId ? { extensionId: carried.extensionId } : {}),
  });
  await bridge.start();
  const client = createLocalBridgeClient(
    bridge,
    path.join(configuration.artifactDir ?? path.join(os.tmpdir(), 'marshal-browser'), 'user-shots'),
    carried,
  );
  const service = new BrowserService(
    (invocation) => createHostDecider(execute, invocation),
    configuration,
    () => client,
    {},
    execute,
  );
  return {
    capabilityProviders: [service.provider()],
    uiApplications: [createWatchApplication()],
    dispose: async () => {
      await service.dispose();
      await bridge.stop();
    },
  };
}
