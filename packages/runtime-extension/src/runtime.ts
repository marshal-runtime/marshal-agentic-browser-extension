import host from '@agentic-browser/runtime-host';
import { createRuntimeActivation } from './activation.js';
import type { RuntimeExtensionActivation, RuntimeExtensionActivationContext } from './contracts.js';

export function activate(context: RuntimeExtensionActivationContext): RuntimeExtensionActivation {
  return createRuntimeActivation(context, host);
}
