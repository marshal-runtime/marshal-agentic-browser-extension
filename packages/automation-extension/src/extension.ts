/**
 * dist/runtime.cjs entrypoint. Wires the real @marshal/jev:client service
 * (resolved by Symbol injection - see contracts.ts JEV_CLIENT_SERVICE_TOKEN
 * and CLAUDE.md's backend-abstraction convention of never importing another
 * extension's runtime values) and the host-injected agentic browser module
 * (see runtime-host-module.d.ts - build.mjs marks it `external` and the
 * bundle's output format is `cjs`, so esbuild compiles this import down to
 * the same `require("@agentic-browser/runtime-host")` call as before; see
 * electron/marshal-runtime/agentic-browser-external-extension.integration.test.ts
 * line ~178 for the same pattern from an external extension's own bundle).
 */
import path from 'node:path';
import browserHostModule from '@agentic-browser/runtime-host';
import type {
  AgenticBrowserRuntimeHost,
  JevClient,
  RuntimeExtensionActivation,
  RuntimeExtensionActivationContext,
} from './contracts.js';
import { JEV_CLIENT_SERVICE_TOKEN } from './contracts.js';
import {
  createAutomationCapabilityProvider,
  type AutomationConfiguration,
} from './capabilities.js';
import { createNativeCapabilityProvider } from './native/native-capabilities.js';

// Not `async`: this has no `await`, and an `async` function with no `await`
// trips @typescript-eslint/require-await. The try/catch replicates async's
// throw-becomes-rejection behavior exactly (a plain sync function would
// instead throw synchronously out of the call, changing observable
// behavior for a caller that only `.catch()`s the returned promise).
export function activate(
  context: RuntimeExtensionActivationContext<AutomationConfiguration>,
): Promise<RuntimeExtensionActivation> {
  try {
    const jevClient = context.services.tryGet<JevClient>(JEV_CLIENT_SERVICE_TOKEN);
    if (!jevClient) {
      throw new Error(
        '@agentic-browser/automation-extension requires the @marshal/jev:client service (from @marshal/jev) to be active first.',
      );
    }

    // `configuration` is always provided by the host (non-optional in
    // RuntimeExtensionActivationContext); no need for a `?? {}` fallback.
    const configuration = context.configuration;
    // The host module has no shipped types (see runtime-host-module.d.ts);
    // cast at the single use site, same as the original code's
    // `require(...) as AgenticBrowserRuntimeHost`.
    const provider = createAutomationCapabilityProvider({
      host: browserHostModule as AgenticBrowserRuntimeHost,
      jevClient,
      execute: context.execute.bind(context),
      configuration,
    });

    // dist/runtime.cjs (this bundle's entrypoint) lives directly under the
    // package root's dist/ directory - see build.mjs's outfile.
    const packageRoot = path.join(__dirname, '..');
    const nativeProvider = createNativeCapabilityProvider({
      jevClient,
      execute: context.execute.bind(context),
      configuration,
      packageRoot,
    });

    return Promise.resolve({ capabilityProviders: [provider, nativeProvider] });
  } catch (error) {
    // Reject with exactly what was thrown (matching async/await's own
    // throw-to-rejection semantics precisely - no wrapping). The cast is
    // only to satisfy prefer-promise-reject-errors' static check; it has no
    // runtime effect, so the rejection value is unchanged either way.
    return Promise.reject(error as Error);
  }
}
