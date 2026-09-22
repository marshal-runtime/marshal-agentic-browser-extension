import { describe, expect, it } from 'vitest';
import { DomAdapter } from '../src/dom-adapter.js';
import type {
  AgenticBrowserRuntimeHost,
  BrowserCommandResult,
  BrowserRequestContext,
} from '../src/contracts.js';
import type { PageSnapshot } from '../src/types.js';

const context: BrowserRequestContext = {
  chatId: 'chat-1',
  executionId: 'exec-1',
  browserSessionId: 'browser-1',
};

function fullSnapshot(marker: readonly unknown[] = ['A']): PageSnapshot {
  return {
    url: 'https://example.com/',
    title: 'Example',
    w: 1024,
    h: 768,
    text: 'hello',
    scroll: { y: 0, height: 1000 },
    actions: [],
    marker,
    omittedActions: 0,
  };
}

interface ScriptCall {
  readonly script: string;
}

function makeHost(): { host: AgenticBrowserRuntimeHost; scriptCalls: ScriptCall[] } {
  const scriptCalls: ScriptCall[] = [];
  const host: AgenticBrowserRuntimeHost = {
    createId: (kind) => `${kind}-1`,
    invokeBrowserCommand: async (name, input): Promise<BrowserCommandResult> => {
      if (name === 'browser_execute_script') {
        const script = String((input as { script?: unknown }).script ?? '');
        scriptCalls.push({ script });
        // The full snapshot script stamps data-mjev-id; the marker fast path never does.
        if (script.includes('data-mjev-id')) return { success: true, data: fullSnapshot(['A']) };
        return { success: true, data: ['A', 0, 0, 1024, 768, 'Example', 'hello', '[]', 'null'] };
      }
      if (name === 'browser_click' || name === 'browser_type') return { success: true, data: {} };
      return { success: true, data: {} };
    },
  };
  return { host, scriptCalls };
}

describe('DomAdapter', () => {
  it('kind is "dom" and target describes the bound chat', () => {
    const { host } = makeHost();
    const adapter = new DomAdapter(host, context);
    expect(adapter.kind).toBe('dom');
    expect(adapter.target).toContain('chat-1');
  });

  it('snapshot() runs the full stamping script and returns a PageSnapshot', async () => {
    const { host, scriptCalls } = makeHost();
    const adapter = new DomAdapter(host, context);
    const snapshot = await adapter.snapshot();
    expect(snapshot.url).toBe('https://example.com/');
    expect(scriptCalls).toHaveLength(1);
    expect(scriptCalls[0]?.script).toContain('data-mjev-id');
  });

  it('marker() runs the cheap marker-only script, not the full snapshot script', async () => {
    const { host, scriptCalls } = makeHost();
    const adapter = new DomAdapter(host, context);
    if (!adapter.marker) throw new Error('expected DomAdapter to implement marker()');
    const marker = await adapter.marker();
    expect(marker).toEqual(['A', 0, 0, 1024, 768, 'Example', 'hello', '[]', 'null']);
    expect(scriptCalls).toHaveLength(1);
    expect(scriptCalls[0]?.script).not.toContain('data-mjev-id');
  });

  it('marker() throws AUTOMATION_INVALID_MARKER when the host does not return an array', async () => {
    const host: AgenticBrowserRuntimeHost = {
      createId: (kind) => `${kind}-1`,
      invokeBrowserCommand: async (): Promise<BrowserCommandResult> => ({
        success: true,
        data: { not: 'an array' },
      }),
    };
    const adapter = new DomAdapter(host, context);
    if (!adapter.marker) throw new Error('expected DomAdapter to implement marker()');
    await expect(adapter.marker()).rejects.toThrow('AUTOMATION_INVALID_MARKER');
  });

  it('act() scrolls an offscreen element into view before performing the action', async () => {
    const scrollCalls: string[] = [];
    const host: AgenticBrowserRuntimeHost = {
      createId: (kind) => `${kind}-1`,
      invokeBrowserCommand: async (name, input): Promise<BrowserCommandResult> => {
        if (name === 'browser_execute_script') {
          const script = String((input as { script?: unknown }).script ?? '');
          scrollCalls.push(script);
          return { success: true, data: { ok: true } };
        }
        if (name === 'browser_click') return { success: true, data: {} };
        return { success: true, data: {} };
      },
    };
    const adapter = new DomAdapter(host, context);
    const result = await adapter.act({
      node: '9',
      role: 'button',
      label: 'Buy',
      kind: 'click',
      value: '',
      offscreen: true,
    });

    expect(result.ok).toBe(true);
    // One scrollIntoView call plus performAction's own post-click submit-control verify+fallback script.
    const scrollIntoViewCalls = scrollCalls.filter((s) => s.includes('scrollIntoView'));
    expect(scrollIntoViewCalls).toHaveLength(1);
    expect(scrollIntoViewCalls[0]).toContain('9');
  });

  it('act() does not attempt to scroll an onscreen element', async () => {
    const scrollCalls: string[] = [];
    const host: AgenticBrowserRuntimeHost = {
      createId: (kind) => `${kind}-1`,
      invokeBrowserCommand: async (name, input): Promise<BrowserCommandResult> => {
        if (name === 'browser_execute_script') {
          scrollCalls.push(String((input as { script?: unknown }).script ?? ''));
          return { success: true, data: { ok: true } };
        }
        if (name === 'browser_click') return { success: true, data: {} };
        return { success: true, data: {} };
      },
    };
    const adapter = new DomAdapter(host, context);
    await adapter.act({ node: '9', role: 'button', label: 'Buy', kind: 'click', value: '' });

    expect(scrollCalls.filter((s) => s.includes('scrollIntoView'))).toHaveLength(0);
  });

  it('act() routes a "sh:"-prefixed node to browser_execute_script (the in-page resolver), never browser_click', async () => {
    const scriptCalls: string[] = [];
    let clickCalls = 0;
    const host: AgenticBrowserRuntimeHost = {
      createId: (kind) => `${kind}-1`,
      invokeBrowserCommand: async (name, input): Promise<BrowserCommandResult> => {
        if (name === 'browser_execute_script') {
          scriptCalls.push(String((input as { script?: unknown }).script ?? ''));
          return { success: true, data: { ok: true } };
        }
        if (name === 'browser_click') {
          clickCalls++;
          return { success: true, data: {} };
        }
        return { success: true, data: {} };
      },
    };
    const adapter = new DomAdapter(host, context);
    const result = await adapter.act({
      node: 'sh:12/34',
      role: 'button',
      label: 'Add to cart',
      kind: 'click',
      value: '',
    });

    expect(result.ok).toBe(true);
    expect(clickCalls).toBe(0);
    expect(scriptCalls).toHaveLength(1);
    expect(scriptCalls[0]).toContain('__mjevResolve');
    expect(scriptCalls[0]).toContain(JSON.stringify('sh:12/34'));
  });

  it('act() routes an "if:"-prefixed fill to browser_execute_script, never browser_type, and passes the typed text', async () => {
    const scriptCalls: string[] = [];
    let typeCalls = 0;
    const host: AgenticBrowserRuntimeHost = {
      createId: (kind) => `${kind}-1`,
      invokeBrowserCommand: async (name, input): Promise<BrowserCommandResult> => {
        if (name === 'browser_execute_script') {
          scriptCalls.push(String((input as { script?: unknown }).script ?? ''));
          return { success: true, data: { ok: true } };
        }
        if (name === 'browser_type') {
          typeCalls++;
          return { success: true, data: {} };
        }
        return { success: true, data: {} };
      },
    };
    const adapter = new DomAdapter(host, context);
    const result = await adapter.act(
      { node: 'if:7/9', role: 'textbox', label: 'Email', kind: 'fill', value: '' },
      'ada@example.com',
    );

    expect(result.ok).toBe(true);
    expect(typeCalls).toBe(0);
    expect(scriptCalls).toHaveLength(1);
    expect(scriptCalls[0]).toContain(JSON.stringify('ada@example.com'));
  });

  it('act() with {strategy: "js"} on a click drives an in-page scrollIntoView+focus+click script instead of browser_click', async () => {
    const scriptCalls: string[] = [];
    let clickCalls = 0;
    const host: AgenticBrowserRuntimeHost = {
      createId: (kind) => `${kind}-1`,
      invokeBrowserCommand: async (name, input): Promise<BrowserCommandResult> => {
        if (name === 'browser_execute_script') {
          scriptCalls.push(String((input as { script?: unknown }).script ?? ''));
          return { success: true, data: { ok: true } };
        }
        if (name === 'browser_click') {
          clickCalls++;
          return { success: true, data: {} };
        }
        return { success: true, data: {} };
      },
    };
    const adapter = new DomAdapter(host, context);
    const result = await adapter.act(
      { node: '8', role: 'button', label: 'Search', kind: 'click', value: '' },
      undefined,
      {
        strategy: 'js',
      },
    );

    expect(result.ok).toBe(true);
    expect(clickCalls).toBe(0);
    expect(scriptCalls).toHaveLength(1);
    expect(scriptCalls[0]).toContain('scrollIntoView');
    expect(scriptCalls[0]).toContain('el.click()');
    expect(scriptCalls[0]).toContain('8');
  });

  it('act() with {strategy: "js"} passes role/label/box so a re-rendered (restamped) element can be re-resolved by proximity', async () => {
    const scriptCalls: string[] = [];
    const host: AgenticBrowserRuntimeHost = {
      createId: (kind) => `${kind}-1`,
      invokeBrowserCommand: async (name, input): Promise<BrowserCommandResult> => {
        if (name === 'browser_execute_script') {
          scriptCalls.push(String((input as { script?: unknown }).script ?? ''));
          return { success: true, data: { ok: true } };
        }
        return { success: true, data: {} };
      },
    };
    const adapter = new DomAdapter(host, context);
    const result = await adapter.act(
      {
        node: '4',
        role: 'button',
        label: 'Search',
        kind: 'click',
        value: '',
        box: [669, 17, 71, 32],
      },
      undefined,
      { strategy: 'js' },
    );

    expect(result.ok).toBe(true);
    expect(scriptCalls).toHaveLength(1);
    expect(scriptCalls[0]).toContain('__mjevResolveByRoleLabelBox');
    expect(scriptCalls[0]).toContain(JSON.stringify('button'));
    expect(scriptCalls[0]).toContain(JSON.stringify('Search'));
    expect(scriptCalls[0]).toContain(JSON.stringify([669, 17, 71, 32]));
    // Falls back to the resolver only when the stamped selector itself finds nothing.
    expect(scriptCalls[0]).toContain('let el = document.querySelector');
    expect(scriptCalls[0]).toContain('if (!el) el = __mjevResolveByRoleLabelBox');
  });

  it('act() ignores {strategy: "js"} for a non-click kind (falls back to the normal performAction path)', async () => {
    let typeCalls = 0;
    const host: AgenticBrowserRuntimeHost = {
      createId: (kind) => `${kind}-1`,
      invokeBrowserCommand: async (name): Promise<BrowserCommandResult> => {
        if (name === 'browser_type') {
          typeCalls++;
          return { success: true, data: {} };
        }
        return { success: true, data: {} };
      },
    };
    const adapter = new DomAdapter(host, context);
    const result = await adapter.act(
      { node: '3', role: 'textbox', label: 'Email', kind: 'fill', value: '' },
      'ada@example.com',
      { strategy: 'js' },
    );

    expect(result.ok).toBe(true);
    expect(typeCalls).toBe(1);
  });

  it('act() routes a top-document "submit" kind through performAction (in-page Enter press), not browser_click', async () => {
    let clickCalls = 0;
    const scriptCalls: string[] = [];
    const host: AgenticBrowserRuntimeHost = {
      createId: (kind) => `${kind}-1`,
      invokeBrowserCommand: async (name, input): Promise<BrowserCommandResult> => {
        if (name === 'browser_execute_script') {
          scriptCalls.push(String((input as { script?: unknown }).script ?? ''));
          return { success: true, data: { ok: true } };
        }
        if (name === 'browser_click') {
          clickCalls++;
          return { success: true, data: {} };
        }
        return { success: true, data: {} };
      },
    };
    const adapter = new DomAdapter(host, context);
    const result = await adapter.act({
      node: '9',
      role: 'searchbox',
      label: 'Search Wikipedia',
      kind: 'submit',
      value: '',
    });

    expect(result.ok).toBe(true);
    expect(clickCalls).toBe(0);
    expect(scriptCalls).toHaveLength(1);
    expect(scriptCalls[0]).toContain('requestSubmit');
  });

  it('act() reports ok:false for a deep node when the resolver cannot find the element', async () => {
    const host: AgenticBrowserRuntimeHost = {
      createId: (kind) => `${kind}-1`,
      invokeBrowserCommand: async (name): Promise<BrowserCommandResult> => {
        if (name === 'browser_execute_script') return { success: true, data: { ok: false } };
        return { success: true, data: {} };
      },
    };
    const adapter = new DomAdapter(host, context);
    const result = await adapter.act({
      node: 'sh:1/2',
      role: 'button',
      label: 'Ghost',
      kind: 'click',
      value: '',
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain('sh:1/2');
  });
});
