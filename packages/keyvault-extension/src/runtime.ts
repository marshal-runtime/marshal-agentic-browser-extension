import type { RuntimeExtensionActivation, RuntimeExtensionActivationContext } from './contracts.js';
import { KEYVAULT_SECRET_INPUT_SERVICE, KEYVAULT_STORE_SERVICE } from './contracts.js';
import { createKeyVaultProvider } from './provider.js';

export function activate(context: RuntimeExtensionActivationContext): RuntimeExtensionActivation {
  const store = context.services.get(KEYVAULT_STORE_SERVICE);
  const sink = context.services.get(KEYVAULT_SECRET_INPUT_SERVICE);
  return Object.freeze({
    capabilityProviders: Object.freeze([createKeyVaultProvider({ store, sink })]),
  });
}

export { KEYVAULT_SECRET_INPUT_SERVICE, KEYVAULT_STORE_SERVICE };
export { createAgenticBrowserSecretInputSink, createKeyVaultProvider } from './provider.js';
export { InMemoryKeyVaultStore } from './memory-store.js';
export { validateEntry, validateUrlPattern, assertWindowOpen } from './validation.js';
export type {
  AgenticBrowserRuntimeHost,
  InvocationContext,
  KeyVaultEntry,
  KeyVaultEntryMetadata,
  KeyVaultStore,
  SecretInputRequest,
  SecretInputSink,
} from './contracts.js';
