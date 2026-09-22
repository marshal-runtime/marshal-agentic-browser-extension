import { browserApplication, withRecoverablePanels } from './panel-recovery.js';
import host from '@agentic-browser/runtime-host';
import { createRuntimeActivation } from './activation.js';
import type { RuntimeExtensionActivation, RuntimeExtensionActivationContext } from './contracts.js';

export function activate(context: RuntimeExtensionActivationContext): RuntimeExtensionActivation {
  const activation = createRuntimeActivation(
    context,
    host.resolveBrowserSession ? withRecoverablePanels(context, host) : host,
  );
  return { ...activation, uiApplications: [browserApplication] };
}
