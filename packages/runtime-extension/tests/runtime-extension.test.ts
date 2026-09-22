import { describe, expect, it, vi } from 'vitest';
import { BROWSER_TOOLS } from '@agentic-browser/mcp-server/browser-tools';
import {
  createRuntimeActivation,
  PANEL_FOCUS_TOOL_ID,
  PANEL_OPEN_OR_FOCUS_TOOL_ID,
  PANEL_OPEN_TOOL_ID,
} from '../src/activation.js';
import type {
  BrowserCommandResult,
  BrowserRequestContext,
  BrowserLifecycleEvent,
  CapabilityProvider,
  InvocationContext,
  MarshalBrowserRuntimeHostModule,
  RuntimeCatalogProvider,
  RuntimeExtensionActivationContext,
} from '../src/contracts.js';

function createActivationContext(): RuntimeExtensionActivationContext {
  return {
    manifest: {
      schemaVersion: 1,
      identity: '@agentic-browser/marshal-runtime-extension',
      version: '0.1.0',
      entrypoint: 'dist/runtime.cjs',
      moduleFormat: 'commonjs-bundle-v1',
    },
    search: vi.fn(),
    execute: vi.fn(),
  };
}

function createInvocationContext(chatId: string, executionId: string): InvocationContext {
  return {
    principal: { id: 'user-1', kind: 'user' },
    identity: { harnessId: 'marshal', installationId: 'install-1' },
    scope: { workspaceId: 'workspace-1', sessionId: chatId },
    executionId,
  };
}

describe('Marshal runtime activation', () => {
  it('exposes only native-routable browser tools and the panel host-tool bridge', async () => {
    const host = createHost();
    const activation = createRuntimeActivation(createActivationContext(), host.module);
    const provider = getProvider(activation.capabilityProviders);
    const catalog = getCatalogProvider(activation.catalogProviders);

    const descriptors = await provider.list(createInvocationContext('chat-a', 'exec-1'));
    const names = descriptors.map((descriptor) => descriptor.name);
    const unsupportedNames = [
      'browser_keyboard',
      'browser_list_targets',
      'browser_connect_remote',
      'browser_disconnect_remote',
      'browser_switch_backend',
      'browser_list_tools',
      'browser_export_session',
      'browser_import_session',
    ];
    expect(names).toHaveLength(BROWSER_TOOLS.length - 8);
    expect(names).toContain('browser_get_dialog_info');
    expect(names.filter((name) => unsupportedNames.includes(name))).toEqual([]);

    const entries = await catalog.list(createInvocationContext('chat-a', 'exec-1'));
    expect(entries.map((entry) => entry.action.toolId)).toEqual([
      PANEL_OPEN_OR_FOCUS_TOOL_ID,
      PANEL_OPEN_TOOL_ID,
      PANEL_FOCUS_TOOL_ID,
    ]);
  });

  it('keeps browser sessions stable per chat and execution and isolates concurrent executions', async () => {
    const host = createHost();
    const activation = createRuntimeActivation(createActivationContext(), host.module);
    const provider = getProvider(activation.capabilityProviders);

    await provider.invoke(
      'browser_navigate',
      { url: 'https://example.com' },
      createInvocationContext('chat-a', 'exec-1'),
    );
    await provider.invoke(
      'browser_click',
      { selector: '#continue' },
      createInvocationContext('chat-a', 'exec-1'),
    );
    await provider.invoke(
      'browser_navigate',
      { url: 'https://example.org' },
      createInvocationContext('chat-b', 'exec-3'),
    );
    await provider.invoke(
      'browser_click',
      { selector: '#isolated' },
      createInvocationContext('chat-a', 'exec-2'),
    );

    const first = getAt(host.invocations, 0).context;
    const second = getAt(host.invocations, 1).context;
    const third = getAt(host.invocations, 2).context;
    const fourth = getAt(host.invocations, 3).context;

    expect(first.chatId).toBe('chat-a');
    expect(first.executionId).toBe('exec-1');
    expect(second.executionId).toBe('exec-1');
    expect(first.browserSessionId).toBe(second.browserSessionId);
    expect(third.chatId).toBe('chat-b');
    expect(third.browserSessionId).not.toBe(first.browserSessionId);
    expect(fourth.chatId).toBe('chat-a');
    expect(fourth.executionId).toBe('exec-2');
    expect(fourth.browserSessionId).not.toBe(first.browserSessionId);

    expect(host.events.map((event) => event.type)).toEqual([
      'created',
      'navigation',
      'completion',
      'interaction',
      'completion',
      'created',
      'navigation',
      'completion',
      'created',
      'interaction',
      'completion',
    ]);
    expect(host.panelRequests).toEqual([
      expect.objectContaining({ chatId: 'chat-a', executionId: 'exec-1' }),
      expect.objectContaining({ chatId: 'chat-b', executionId: 'exec-3' }),
      expect.objectContaining({ chatId: 'chat-a', executionId: 'exec-2' }),
    ]);
  });

  it('does not let an older interleaved execution focus after a newer execution starts', async () => {
    const invocations = new Map<string, () => void>();
    const host = createHost();
    host.module.invokeBrowserCommand = vi.fn((_name, _input, context) => {
      return new Promise<BrowserCommandResult>((resolve) => {
        invocations.set(context.executionId, () => resolve({ success: true }));
      });
    });
    const activation = createRuntimeActivation(createActivationContext(), host.module);
    const provider = getProvider(activation.capabilityProviders);

    const older = provider.invoke(
      'browser_navigate',
      { url: 'https://older.example' },
      createInvocationContext('chat-a', 'exec-older'),
    );
    await vi.waitFor(() => expect(invocations.has('exec-older')).toBe(true));
    const newer = provider.invoke(
      'browser_navigate',
      { url: 'https://newer.example' },
      createInvocationContext('chat-a', 'exec-newer'),
    );
    await vi.waitFor(() => expect(invocations.has('exec-newer')).toBe(true));

    invocations.get('exec-older')?.();
    await older;
    expect(host.panelRequests).toEqual([]);
    invocations.get('exec-newer')?.();
    await newer;

    expect(host.panelRequests).toEqual([expect.objectContaining({ executionId: 'exec-newer' })]);
  });

  it('emits pause and failure lifecycle events with propagated identity', async () => {
    const host = createHost({
      success: false,
      error: { code: 'TIMEOUT', message: 'Timed out' },
    });
    const activation = createRuntimeActivation(createActivationContext(), host.module);
    const provider = getProvider(activation.capabilityProviders);

    const result = await provider.invoke(
      'browser_wait_for_selector',
      { selector: '#ready' },
      createInvocationContext('chat-a', 'exec-4'),
    );

    expect(result.output).toMatchObject({ success: false });
    expect(host.events.map((event) => event.type)).toEqual(['created', 'pause', 'failure']);
    expect(getAt(host.events, 2).context).toEqual(getAt(host.invocations, 0).context);
    expect(host.panelRequests).toHaveLength(0);
  });

  it('opens or focuses the panel only once for repeated commands in one execution', async () => {
    const host = createHost();
    const activation = createRuntimeActivation(createActivationContext(), host.module);
    const provider = getProvider(activation.capabilityProviders);
    const context = createInvocationContext('chat-a', 'exec-1');

    await provider.invoke('browser_navigate', { url: 'https://example.com' }, context);
    await provider.invoke('browser_click', { selector: '#continue' }, context);

    expect(host.panelRequests).toHaveLength(1);
    expect(host.invocations).toHaveLength(2);
  });

  it('continues browser execution and reports a panel open-or-focus failure', async () => {
    const host = createHost({ success: true }, new Error('Panel unavailable'));
    const activation = createRuntimeActivation(createActivationContext(), host.module);
    const provider = getProvider(activation.capabilityProviders);

    const result = await provider.invoke(
      'browser_navigate',
      { url: 'https://example.com' },
      createInvocationContext('chat-a', 'exec-1'),
    );

    expect(result.output).toEqual({ success: true });
    expect(result.metadata).toMatchObject({
      panelError: { name: 'Error', message: 'Panel unavailable' },
    });
    expect(host.invocations).toHaveLength(1);
    expect(host.events.map((event) => event.type)).toEqual([
      'created',
      'navigation',
      'failure',
      'completion',
    ]);
    expect(getAt(host.events, 2).details).toMatchObject({
      phase: 'panel-open-or-focus',
    });
  });

  it('does not deduplicate panel requests across isolated browser sessions', async () => {
    const host = createHost();
    const activation = createRuntimeActivation(createActivationContext(), host.module);
    const provider = getProvider(activation.capabilityProviders);
    const first = createInvocationContext('chat-a', 'exec-1');
    const second: InvocationContext = {
      ...first,
      scope: { ...first.scope, workspaceId: 'workspace-2' },
    };

    await provider.invoke('browser_navigate', { url: 'https://example.com' }, first);
    await provider.invoke('browser_navigate', { url: 'https://example.org' }, second);

    expect(host.panelRequests).toHaveLength(2);
    expect(host.panelRequests[0]?.browserSessionId).not.toBe(
      host.panelRequests[1]?.browserSessionId,
    );
  });
});

interface TestHost {
  readonly module: MarshalBrowserRuntimeHostModule;
  readonly events: BrowserLifecycleEvent[];
  readonly panelRequests: BrowserRequestContext[];
  readonly invocations: Array<{
    name: string;
    input: Record<string, unknown>;
    context: {
      chatId: string;
      executionId: string;
      browserSessionId: string;
    };
  }>;
}

function createHost(
  result: BrowserCommandResult = { success: true },
  panelError?: Error,
): TestHost {
  let id = 0;
  const events: BrowserLifecycleEvent[] = [];
  const panelRequests: BrowserRequestContext[] = [];
  const invocations: Array<{
    name: string;
    input: Record<string, unknown>;
    context: {
      chatId: string;
      executionId: string;
      browserSessionId: string;
    };
  }> = [];

  const module: MarshalBrowserRuntimeHostModule = {
    createId: (kind) => `${kind}-${String(++id)}`,
    now: () => '2026-08-16T00:00:00.000Z',
    invokeBrowserCommand: (name, input, context) => {
      invocations.push({ name, input, context });
      return Promise.resolve(result);
    },
    invokeSecretType: () => Promise.resolve(result),
    publishLifecycleEvent: (event) => {
      events.push(event);
      return Promise.resolve();
    },
    openOrFocusPanel: (context) => {
      panelRequests.push(context);
      return panelError === undefined ? Promise.resolve() : Promise.reject(panelError);
    },
  };

  return { module, events, invocations, panelRequests };
}

function getProvider(providers: readonly CapabilityProvider[] | undefined): CapabilityProvider {
  const provider = providers?.[0];
  if (!provider) {
    throw new Error('Expected a capability provider');
  }
  return provider;
}

function getCatalogProvider(
  providers: readonly RuntimeCatalogProvider[] | undefined,
): RuntimeCatalogProvider {
  const provider = providers?.[0];
  if (!provider) {
    throw new Error('Expected a catalog provider');
  }
  return provider;
}

function getAt<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) {
    throw new Error(`Expected item at index ${String(index)}`);
  }
  return item;
}
