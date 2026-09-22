import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  asExpression,
  captureScreenshot,
  performAction,
  saveScreenshot,
  takeSnapshot,
  unwrapEvaluateResult,
} from '../src/browser-actions.js';
import type {
  AgenticBrowserRuntimeHost,
  BrowserCommandResult,
  BrowserRequestContext,
} from '../src/contracts.js';

const context: BrowserRequestContext = { chatId: 'c', executionId: 'e', browserSessionId: 'b' };

function hostReturning(
  handler: (name: string, input: Record<string, unknown>) => BrowserCommandResult,
): {
  readonly host: AgenticBrowserRuntimeHost;
  readonly calls: { name: string; input: Record<string, unknown> }[];
} {
  const calls: { name: string; input: Record<string, unknown> }[] = [];
  const host: AgenticBrowserRuntimeHost = {
    createId: () => 'id',
    invokeBrowserCommand: async (name, input) => {
      calls.push({ name, input });
      return handler(name, input);
    },
  };
  return { host, calls };
}

describe('live-host browser contract', () => {
  it('sends the snapshot as an expression (no top-level return) and unwraps data.result', async () => {
    const snapshot = {
      url: 'https://x/',
      title: 't',
      w: 1,
      h: 1,
      text: '',
      scroll: { y: 0, height: 1 },
      actions: [],
      marker: [],
      omittedActions: 0,
    };
    const { host, calls } = hostReturning(() => ({
      success: true,
      data: { success: true, result: snapshot },
    }));
    await expect(takeSnapshot(host, context)).resolves.toEqual(snapshot);
    const script = String(calls[0]?.input['script']);
    expect(script.startsWith('(async () => {')).toBe(true);
    expect(script.trimEnd().endsWith('})()')).toBe(true);
    // The wrapped script must be a syntactically valid expression even though the body uses top-level `return`.
    expect(() => new Function(`return ${script}`)).not.toThrow();
  });

  it('asExpression makes a body with return parseable as an expression', () => {
    expect(() => new Function(`return ${asExpression('return 1;')}`)).not.toThrow();
    expect(() => new Function('return 1;\n')).not.toThrow();
  });

  it('unwrapEvaluateResult passes raw values through', () => {
    expect(unwrapEvaluateResult({ success: true, result: { a: 1 } })).toEqual({ a: 1 });
    expect(unwrapEvaluateResult({ url: 'u' })).toEqual({ url: 'u' });
  });

  it('normalises the host screenshot shape (no mimeType) and saves it to a file', async () => {
    const png = Buffer.from('fakepng').toString('base64');
    const { host } = hostReturning(() => ({
      success: true,
      data: { success: true, data: png, format: 'png', encoding: 'base64' },
    }));
    const shot = await captureScreenshot(host, context);
    expect(shot.mimeType).toBe('image/png');
    const saved = await saveScreenshot(shot, 'run-shot');
    expect(existsSync(saved.path)).toBe(true);
    expect(readFileSync(saved.path).toString()).toBe('fakepng');
  });

  it('selects an option by in-page script instead of the ref-based browser_select', async () => {
    const { host, calls } = hostReturning(() => ({
      success: true,
      data: { success: true, result: { ok: true } },
    }));
    const result = await performAction(
      host,
      context,
      { node: '7', role: 'combobox', label: 'Sort', kind: 'select', value: 'price' },
      undefined,
    );
    expect(result).toEqual({ ok: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.name).toBe('browser_execute_script');
    expect(String(calls[0]?.input['script'])).toContain('[data-mjev-id=\\"7\\"]');
  });

  it('reports a failed in-page select', async () => {
    const { host } = hostReturning(() => ({
      success: true,
      data: { success: true, result: { ok: false } },
    }));
    const result = await performAction(
      host,
      context,
      { node: '7', kind: 'select', label: 's', value: 'x' },
      undefined,
    );
    expect(result.ok).toBe(false);
  });

  it('click: runs browser_click then a submit-control verify+fallback script afterward', async () => {
    const { host, calls } = hostReturning(() => ({
      success: true,
      data: { success: true, result: { ok: true } },
    }));
    const result = await performAction(
      host,
      context,
      { node: '8', role: 'button', label: 'Search', kind: 'click', value: '' },
      undefined,
    );

    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.name).toBe('browser_click');
    expect(calls[1]?.name).toBe('browser_execute_script');
    const script = String(calls[1]?.input['script']);
    expect(script).toContain('isSubmitControl');
    expect(script).toContain('[data-mjev-id=\\"8\\"]');
  });

  it('click: a failed submit-fallback script never fails the click itself', async () => {
    const { host } = hostReturning((name) =>
      name === 'browser_execute_script'
        ? { success: false, error: { code: 'X', message: 'boom' } }
        : { success: true, data: {} },
    );
    const result = await performAction(
      host,
      context,
      { node: '8', kind: 'click', label: 'Search', value: '' },
      undefined,
    );
    expect(result.ok).toBe(true);
  });

  it('submit: presses Enter in the given node via an in-page script', async () => {
    const { host, calls } = hostReturning(() => ({
      success: true,
      data: { success: true, result: { ok: true } },
    }));
    const result = await performAction(
      host,
      context,
      { node: '5', role: 'textbox', label: 'Search Wikipedia', kind: 'submit', value: '' },
      undefined,
    );

    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.name).toBe('browser_execute_script');
    const script = String(calls[0]?.input['script']);
    expect(script).toContain('requestSubmit');
    expect(script).toContain('KeyboardEvent');
    expect(script).toContain('[data-mjev-id=\\"5\\"]');
  });

  it('submit: reports ok:false when the in-page script reports failure', async () => {
    const { host } = hostReturning(() => ({
      success: true,
      data: { success: true, result: { ok: false } },
    }));
    const result = await performAction(
      host,
      context,
      { node: '5', kind: 'submit', label: 'Search', value: '' },
      undefined,
    );
    expect(result.ok).toBe(false);
  });
});
