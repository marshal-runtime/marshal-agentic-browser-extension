import type {
  BrowserLifecycleEvent,
  InvocationContext,
  MarshalBrowserRuntimeHostModule,
  RuntimeExtensionActivationContext,
} from './contracts.js';

const owner = {
  extensionId: '@agentic-browser/marshal-runtime-extension',
  applicationId: 'browser-session',
};
export const browserApplication = {
  id: owner.applicationId,
  title: 'Agentic Browser',
  description: 'Browser for the current Marshal chat.',
  renderId: 'marshal.agentic-browser.v1',
  resource: { uri: 'runtime://browser/ui/application/v1', mimeType: 'text/html', text: '' },
  application: { version: '1.0.0', presentationModes: ['inline', 'pip'], actions: [], tools: [] },
};

interface OperationError {
  readonly message?: string;
}

interface OperationOutput {
  readonly ok?: boolean;
  readonly error?: OperationError;
  readonly value?: unknown;
}

interface OperationResult {
  readonly status?: string;
  readonly error?: OperationError;
  readonly result?: { readonly output?: OperationOutput };
}

interface PanelInstance {
  readonly instanceId: string;
  readonly surface?: string;
}

interface PanelListOutput {
  readonly instances?: readonly PanelInstance[];
}

interface TextBlock {
  readonly type?: string;
  readonly text?: string;
}

interface CommandResultDetails {
  readonly data?: { readonly content?: readonly TextBlock[] };
}

type ResolvedBrowserSession = ReturnType<
  NonNullable<MarshalBrowserRuntimeHostModule['resolveBrowserSession']>
>;

const MISSING_INSTANCE = 'Runtime UI instance was not found for this owner and scope';

/** Own panel lifetime in the reloadable extension; do not reuse the desktop host's stale UI IDs. */
export function withRecoverablePanels(
  activation: RuntimeExtensionActivationContext,
  host: MarshalBrowserRuntimeHostModule,
): MarshalBrowserRuntimeHostModule {
  const contexts = new Map<string, InvocationContext>();
  const states = new Map<string, Record<string, unknown>>();
  const queues = new Map<string, Promise<void>>();

  async function operation(
    target: string,
    input: Record<string, unknown>,
    context: InvocationContext,
  ): Promise<unknown> {
    const result = await activation.execute<OperationResult>(
      { protocolVersion: '1.0.0', targetType: 'operation', target, input: { ...owner, ...input } },
      context,
    );
    if (result.status !== 'success')
      throw new Error(result.error?.message ?? 'Browser panel operation failed.');
    const output = result.result?.output;
    if (output?.ok === false)
      throw new Error(output.error?.message ?? 'Browser panel operation failed.');
    return output?.value ?? output;
  }

  function sync(id: string): Promise<void> {
    const pending = (queues.get(id) ?? Promise.resolve())
      .catch(() => undefined)
      .then(async () => {
        const context = contexts.get(id);
        if (!context) throw new Error('Missing browser invocation scope.');
        // List by owner and scope each time: a closed panel must not leave a stale cached ID.
        const listed = (await operation('ui.application.list', { surface: 'panel' }, context)) as
          | PanelListOutput
          | undefined;
        const existing = listed?.instances?.find((instance) => instance.surface === 'panel');
        const state = states.get(id) ?? { status: 'active' };
        const open = (): Promise<unknown> =>
          operation(
            'ui.application.open',
            { surface: 'panel', state, idempotencyKey: host.createId('event') },
            context,
          );
        if (!existing) {
          await open();
          return;
        }
        try {
          await operation(
            'ui.application.update',
            { instanceId: existing.instanceId, state, idempotencyKey: host.createId('event') },
            context,
          );
        } catch (error) {
          // A user may close the panel between list and update. Recreate only our scoped panel.
          if (!(error instanceof Error) || !error.message.includes(MISSING_INSTANCE)) throw error;
          await open();
        }
      });
    queues.set(id, pending);
    return pending;
  }

  if (!host.resolveBrowserSession)
    throw new Error('withRecoverablePanels requires a host with resolveBrowserSession.');
  const resolveSession = host.resolveBrowserSession.bind(host);

  return {
    ...host,
    resolveBrowserSession(context): ResolvedBrowserSession {
      const session = resolveSession(context);
      contexts.set(session.context.browserSessionId, context);
      return session;
    },
    async publishLifecycleEvent(event: BrowserLifecycleEvent): Promise<void> {
      const id = event.context.browserSessionId;
      const state: Record<string, unknown> = {
        ...states.get(id),
        executionId: event.context.executionId,
        updatedAt: event.occurredAt,
        command: event.command,
        status:
          event.type === 'completion'
            ? 'completed'
            : event.type === 'failure'
              ? 'failed'
              : event.type === 'navigation'
                ? 'navigating'
                : 'active',
      };
      const input = event.details?.input as Record<string, unknown> | undefined;
      if (typeof input?.url === 'string') state.url = input.url;
      const result = event.details?.result as CommandResultDetails | undefined;
      for (const block of result?.data?.content ?? []) {
        if (block.type !== 'text' || typeof block.text !== 'string') continue;
        const url = /Page URL:\s*(\S+)/.exec(block.text)?.[1];
        const title = /Page Title:\s*(.+)/.exec(block.text)?.[1];
        const tree =
          /(?:Page Snapshot|Accessibility(?: Tree)?):\s*```(?:ya?ml)?\s*([\s\S]*?)```/i.exec(
            block.text,
          )?.[1];
        if (url) state.url = url;
        if (title) state.title = title;
        state.accessibility = (tree ?? block.text).slice(0, 16000);
      }
      if (event.type === 'failure') {
        const failure = event.details?.error as OperationError | undefined;
        state.error = String(failure?.message ?? 'Browser command failed.').slice(0, 1024);
      }
      if (event.type === 'completion') delete state.error;
      states.set(id, state);
      // Keep native telemetry, but its obsolete panel cache must never abort a command.
      try {
        await host.publishLifecycleEvent(event);
      } catch (error) {
        if (!(error instanceof Error) || !error.message.includes(MISSING_INSTANCE)) throw error;
      }
      await sync(id);
    },
    openOrFocusPanel: (context) => sync(context.browserSessionId),
    async dispose(): Promise<void> {
      await Promise.allSettled(queues.values());
      contexts.clear();
      states.clear();
      queues.clear();
      await host.dispose?.();
    },
  };
}
