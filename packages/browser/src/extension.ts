/**
 * dist/runtime.cjs entrypoint. The extension needs nothing from another extension: its one model dependency is the
 * host's `marshal.models.decide` capability, reached through `context.execute`.
 */
import { BrowserService, type BrowserConfiguration } from './capabilities.js';
import type { RuntimeExtensionActivation, RuntimeExtensionActivationContext } from './contracts.js';
import { createHostDecider } from './engine/decider.js';
import { createHostBridge } from './user/bridge.js';

export function activate(
  context: RuntimeExtensionActivationContext<
    BrowserConfiguration & Readonly<Record<string, unknown>>
  >,
): Promise<RuntimeExtensionActivation> {
  try {
    const execute = context.execute.bind(context);
    const service = new BrowserService(
      (invocation) => createHostDecider(execute, invocation),
      context.configuration,
      (invocation) => createHostBridge(execute, invocation),
    );
    return Promise.resolve({
      capabilityProviders: [service.provider()],
      dispose: () => service.dispose(),
    });
  } catch (error) {
    return Promise.reject(error as Error);
  }
}
