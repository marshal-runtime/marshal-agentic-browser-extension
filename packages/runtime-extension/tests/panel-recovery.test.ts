import { expect, it, vi } from 'vitest';
import { withRecoverablePanels } from '../src/panel-recovery.js';
it('opens on the first command and recreates a closed panel without changing browser session', async () => {
  let seq = 0;
  const panels = new Map<string, any>(),
    opens: string[] = [],
    contexts: any[] = [];
  const activation: any = {
    execute: vi.fn(async (r: any, c: any) => {
      contexts.push(c.scope.sessionId);
      const id = c.scope.sessionId;
      let value: any = {};
      if (r.target === 'ui.application.list')
        value = { instances: panels.has(id) ? [panels.get(id)] : [] };
      else if (r.target === 'ui.application.open') {
        const panel = { instanceId: String(++seq), surface: 'panel' };
        panels.set(id, panel);
        opens.push(id);
        value = { instance: panel };
      } else if (r.target === 'ui.application.update')
        expect(r.input.instanceId).toBe(panels.get(id)?.instanceId);
      return { status: 'success', result: { output: { ok: true, value } } };
    }),
  };
  const base: any = {
    createId: () => String(++seq),
    now: () => '',
    resolveBrowserSession: (c: any) => ({
      created: false,
      context: {
        browserSessionId: c.scope.sessionId,
        executionId: c.executionId,
        chatId: c.scope.sessionId,
      },
    }),
    publishLifecycleEvent: vi.fn(async () => {
      throw new Error('Runtime UI instance was not found for this owner and scope.');
    }),
    invokeBrowserCommand: vi.fn(async () => ({ success: true })),
    invokeSecretType: vi.fn(async () => ({ success: true })),
    dispose: vi.fn(),
  };
  const host = withRecoverablePanels(activation, base);
  const resolve = host.resolveBrowserSession;
  if (!resolve) throw new Error('wrapped host lost resolveBrowserSession');
  const a = resolve({
    scope: { sessionId: 'a' },
    executionId: '1',
    principal: { id: 'test', kind: 'agent' },
  }).context;
  const event: any = {
    id: '1',
    context: a,
    type: 'navigation',
    command: 'browser_navigate',
    occurredAt: 'now',
    details: { input: { url: 'https://example.com' } },
  };
  await host.publishLifecycleEvent(event);
  expect(opens).toEqual(['a']);
  await host.invokeBrowserCommand('browser_navigate', {}, a);
  const old = panels.get('a').instanceId;
  panels.delete('a');
  await host.publishLifecycleEvent({ ...event, id: '2' });
  expect(panels.get('a').instanceId).not.toBe(old);
  expect(opens).toEqual(['a', 'a']);
  await host.invokeBrowserCommand('browser_navigate', {}, a);
  expect(base.invokeBrowserCommand).toHaveBeenCalledTimes(2);
  const b = resolve({
    scope: { sessionId: 'b' },
    executionId: '2',
    principal: { id: 'test', kind: 'agent' },
  }).context;
  await host.openOrFocusPanel(b);
  expect(opens).toEqual(['a', 'a', 'b']);
  await host.dispose();
});
it('does not suppress an authorization failure', async () => {
  const host = withRecoverablePanels(
    {} as any,
    {
      resolveBrowserSession: () => {
        throw new Error('unused');
      },
      publishLifecycleEvent: async () => {
        throw new Error('permission denied');
      },
    } as any,
  );
  await expect(
    host.publishLifecycleEvent({ context: { browserSessionId: 'a' }, type: 'navigation' } as any),
  ).rejects.toThrow('permission denied');
});
