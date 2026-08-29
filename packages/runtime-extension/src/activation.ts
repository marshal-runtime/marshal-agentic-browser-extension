import { BROWSER_TOOLS } from '@agentic-browser/mcp-server/browser-tools';
import type {
  BrowserCommandResult,
  BrowserRequestContext,
  BrowserLifecycleEventType,
  CapabilityDescriptor,
  CapabilityInvocationResult,
  CapabilityProvider,
  InvocationContext,
  JsonSchema,
  MarshalBrowserRuntimeHostModule,
  RuntimeCatalogEntry,
  RuntimeCatalogProvider,
  RuntimeExtensionActivation,
  RuntimeExtensionActivationContext,
} from './contracts.js';
import { BrowserSessionRegistry } from './session-registry.js';

export const PANEL_OPEN_TOOL_ID = 'marshal.browser.panel.open';
export const PANEL_FOCUS_TOOL_ID = 'marshal.browser.panel.focus';
export const PANEL_OPEN_OR_FOCUS_TOOL_ID = 'marshal.browser.panel.open-or-focus';

const PROVIDER_ID = 'agentic-browser.extension';
const PANEL_CATALOG_PROVIDER_ID = 'agentic-browser.panel';

const UNSUPPORTED_RUNTIME_TOOL_NAMES = new Set([
  'browser_keyboard',
  'browser_list_targets',
  'browser_connect_remote',
  'browser_disconnect_remote',
  'browser_switch_backend',
  'browser_list_tools',
  'browser_export_session',
  'browser_import_session',
]);

const COMMAND_OUTPUT_SCHEMA: JsonSchema = {
  type: 'object',
  required: ['success'],
  properties: {
    success: { type: 'boolean' },
    data: {},
    error: {
      type: 'object',
      required: ['code', 'message'],
      properties: {
        code: { type: 'string' },
        message: { type: 'string' },
        details: {},
      },
      additionalProperties: false,
    },
    metadata: { type: 'object' },
  },
  additionalProperties: false,
};

const NAVIGATION_COMMANDS = new Set([
  'browser_navigate',
  'browser_go_back',
  'browser_go_forward',
  'browser_reload',
  'browser_create_tab',
  'browser_switch_tab',
  'browser_close_tab',
]);

const PAUSE_COMMANDS = new Set([
  'browser_wait_for_selector',
  'browser_wait_for_navigation',
  'browser_wait_for_network_idle',
  'browser_wait_for_condition',
]);

export function createRuntimeActivation(
  activationContext: RuntimeExtensionActivationContext,
  host: MarshalBrowserRuntimeHostModule,
): RuntimeExtensionActivation {
  const sessions = new BrowserSessionRegistry(host);
  const descriptors = createCapabilityDescriptors(activationContext.manifest.version);
  const descriptorByName = new Map(descriptors.map((descriptor) => [descriptor.name, descriptor]));

  const capabilityProvider: CapabilityProvider = {
    id: PROVIDER_ID,
    version: activationContext.manifest.version,
    list: () => descriptors,
    get: (name) => descriptorByName.get(name),
    invoke: async (name, input, context) => {
      if (!descriptorByName.has(name)) {
        throw new Error(`Unknown browser capability: ${name}`);
      }
      if (context.signal?.aborted === true) {
        throw new Error('Browser capability invocation was aborted');
      }

      const params = asRecord(input);
      const session = sessions.resolve(context);
      const operationId = host.createId('event');

      if (session.created) {
        await publishEvent(host, 'created', session.context, name);
      }

      await publishEvent(host, classifyCommand(name), session.context, name, {
        operationId,
        input: params,
      });

      try {
        const result = await host.invokeBrowserCommand(name, params, session.context);
        let panelError: Readonly<Record<string, unknown>> | undefined;
        if (result.success) {
          try {
            await sessions.openOrFocusPanel(session.context, () =>
              host.openOrFocusPanel(session.context),
            );
          } catch (error: unknown) {
            panelError = toErrorDetails(error);
            await publishEvent(host, 'failure', session.context, name, {
              operationId,
              phase: 'panel-open-or-focus',
              error: panelError,
            });
          }
          await publishEvent(host, 'completion', session.context, name, {
            operationId,
            result,
          });
        } else {
          await publishEvent(host, 'failure', session.context, name, {
            operationId,
            error: result.error,
          });
        }
        return toInvocationResult(result, session.context, panelError);
      } catch (error: unknown) {
        await publishEvent(host, 'failure', session.context, name, {
          operationId,
          error: toErrorDetails(error),
        });
        throw error;
      }
    },
  };

  const catalogProvider = createPanelCatalogProvider();

  return {
    capabilityProviders: [capabilityProvider],
    catalogProviders: [catalogProvider],
    dispose: async () => {
      sessions.clear();
      await host.dispose?.();
    },
  };
}

function createCapabilityDescriptors(version: string): readonly CapabilityDescriptor[] {
  return BROWSER_TOOLS.filter((tool) => !UNSUPPORTED_RUNTIME_TOOL_NAMES.has(tool.name)).map(
    (tool) => ({
      protocolVersion: '1.0.0',
      name: tool.name,
      version,
      title: tool.name,
      description: tool.description,
      tags: ['browser', 'agentic-browser', 'native-messaging'],
      inputSchema: tool.inputSchema as JsonSchema,
      outputSchema: COMMAND_OUTPUT_SCHEMA,
      annotations: {
        providerId: PROVIDER_ID,
        transport: 'native-messaging',
      },
    }),
  );
}

function createPanelCatalogProvider(): RuntimeCatalogProvider {
  return {
    id: PANEL_CATALOG_PROVIDER_ID,
    list: (context) => createPanelEntries(context),
    get: (id, context) => createPanelEntries(context).find((entry) => entry.id === id),
  };
}

function createPanelEntries(context: InvocationContext): readonly RuntimeCatalogEntry[] {
  const metadata: Record<string, unknown> = {
    panelId: 'agentic-browser',
  };
  const chatId =
    typeof context.metadata?.['chatId'] === 'string'
      ? context.metadata['chatId']
      : context.scope?.sessionId;
  if (chatId !== undefined) {
    metadata['chatId'] = chatId;
  }
  if (context.executionId !== undefined) {
    metadata['executionId'] = context.executionId;
  }

  return [
    {
      id: 'agentic-browser.panel.open-or-focus',
      kind: 'host_tool',
      title: 'Open or focus Marshal browser panel',
      description:
        'Open the Marshal browser panel for the current execution, or focus its existing panel.',
      tags: ['browser', 'panel', 'marshal'],
      action: { type: 'host_tool', toolId: PANEL_OPEN_OR_FOCUS_TOOL_ID },
      metadata,
    },
    {
      id: 'agentic-browser.panel.open',
      kind: 'host_tool',
      title: 'Open Marshal browser panel',
      description: 'Open the Marshal browser panel for the current chat.',
      tags: ['browser', 'panel', 'marshal'],
      action: { type: 'host_tool', toolId: PANEL_OPEN_TOOL_ID },
      metadata,
    },
    {
      id: 'agentic-browser.panel.focus',
      kind: 'host_tool',
      title: 'Focus Marshal browser panel',
      description: 'Focus the existing Marshal browser panel for the current chat.',
      tags: ['browser', 'panel', 'marshal'],
      action: { type: 'host_tool', toolId: PANEL_FOCUS_TOOL_ID },
      metadata,
    },
  ];
}

function classifyCommand(name: string): BrowserLifecycleEventType {
  if (NAVIGATION_COMMANDS.has(name)) {
    return 'navigation';
  }
  if (PAUSE_COMMANDS.has(name)) {
    return 'pause';
  }
  return 'interaction';
}

async function publishEvent(
  host: MarshalBrowserRuntimeHostModule,
  type: BrowserLifecycleEventType,
  context: BrowserRequestContext,
  command: string,
  details?: Readonly<Record<string, unknown>>,
): Promise<void> {
  await host.publishLifecycleEvent({
    protocolVersion: '1.0.0',
    id: host.createId('event'),
    type,
    occurredAt: host.now(),
    context,
    command,
    details,
  });
}

function toInvocationResult(
  result: BrowserCommandResult,
  context: BrowserRequestContext,
  panelError?: Readonly<Record<string, unknown>>,
): CapabilityInvocationResult<BrowserCommandResult> {
  return {
    output: result,
    metadata: panelError === undefined ? { ...context } : { ...context, panelError },
  };
}

function asRecord(input: unknown): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new TypeError('Browser capability input must be an object');
  }
  return input as Record<string, unknown>;
}

function toErrorDetails(error: unknown): Readonly<Record<string, unknown>> {
  if (error instanceof Error) {
    return { name: error.name, message: error.message };
  }
  return { message: String(error) };
}
