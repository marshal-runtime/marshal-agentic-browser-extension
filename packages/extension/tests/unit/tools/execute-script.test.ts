import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createExecuteScriptHandler, createExecuteConsoleHandler } from '../../../src/tools/execute-script.js';
import type { IBrowserAdapter } from '@agentic-browser/shared';
import { ok, err, ErrorCode } from '@agentic-browser/shared';

function createMockAdapter(overrides: Partial<IBrowserAdapter> = {}): IBrowserAdapter {
  return {
    connect: vi.fn(),
    disconnect: vi.fn(),
    isConnected: vi.fn().mockReturnValue(true),
    navigate: vi.fn(),
    waitForLoad: vi.fn(),
    goBack: vi.fn(),
    goForward: vi.fn(),
    reload: vi.fn(),
    click: vi.fn(),
    type: vi.fn(),
    hover: vi.fn(),
    scroll: vi.fn(),
    select: vi.fn(),
    focus: vi.fn(),
    getAttribute: vi.fn(),
    getProperty: vi.fn(),
    createTab: vi.fn(),
    closeTab: vi.fn(),
    switchTab: vi.fn(),
    listTabs: vi.fn(),
    getActiveTab: vi.fn(),
    handleDialog: vi.fn(),
    getDialogInfo: vi.fn(),
    captureScreenshot: vi.fn(),
    captureFullPageScreenshot: vi.fn(),
    getAccessibilityTree: vi.fn(),
    getPageContent: vi.fn(),
    getOuterHtml: vi.fn(),
    getInnerHtml: vi.fn(),
    querySelector: vi.fn(),
    querySelectorAll: vi.fn(),
    getAttributes: vi.fn(),
    executeScript: vi.fn().mockResolvedValue(ok(42)),
    evaluateExpression: vi.fn(),
    executeConsoleCommand: vi.fn().mockResolvedValue(ok({ returnValue: undefined, consoleOutput: [] })),
    injectScript: vi.fn(),
    removeScript: vi.fn(),
    sendCdpCommand: vi.fn(),
    attachDebugger: vi.fn(),
    detachDebugger: vi.fn(),
    setOuterHtml: vi.fn(),
    setInnerHtml: vi.fn(),
    insertAdjacentHtml: vi.fn(),
    addStyleSheet: vi.fn(),
    modifyStyle: vi.fn(),
    getComputedStyle: vi.fn(),
    getCookies: vi.fn(),
    setCookie: vi.fn(),
    waitForSelector: vi.fn(),
    waitForNavigation: vi.fn(),
    waitForCondition: vi.fn(),
    executeSteps: vi.fn(),
    ...overrides,
  } as IBrowserAdapter;
}

describe('createExecuteScriptHandler', () => {
  let adapter: IBrowserAdapter;
  let executeScript: ReturnType<typeof createExecuteScriptHandler>;

  beforeEach(() => {
    adapter = createMockAdapter();
    executeScript = createExecuteScriptHandler(adapter);
  });

  describe('simple script execution', () => {
    it('should execute a script and return the result', async () => {
      const result = await executeScript({ script: 'return 2 + 2' });

      expect(result).toBe(42);
      expect(adapter.executeScript).toHaveBeenCalledWith({
        script: 'return 2 + 2',
        args: undefined,
        timeout: 30_000,
      });
    });

    it('should return null for undefined results', async () => {
      adapter = createMockAdapter({
        executeScript: vi.fn().mockResolvedValue(ok(undefined)),
      });
      executeScript = createExecuteScriptHandler(adapter);

      const result = await executeScript({ script: 'void 0' });

      expect(result).toBeNull();
    });

    it('should return null for null results', async () => {
      adapter = createMockAdapter({
        executeScript: vi.fn().mockResolvedValue(ok(null)),
      });
      executeScript = createExecuteScriptHandler(adapter);

      const result = await executeScript({ script: 'null' });

      expect(result).toBeNull();
    });

    it('should return primitive values directly', async () => {
      adapter = createMockAdapter({
        executeScript: vi.fn().mockResolvedValue(ok('hello')),
      });
      executeScript = createExecuteScriptHandler(adapter);

      const result = await executeScript({ script: '"hello"' });

      expect(result).toBe('hello');
    });
  });

  describe('DOM manipulation', () => {
    it('should execute DOM manipulation scripts', async () => {
      adapter = createMockAdapter({
        executeScript: vi.fn().mockResolvedValue(ok({ tagName: 'DIV', id: 'test' })),
      });
      executeScript = createExecuteScriptHandler(adapter);

      const result = await executeScript({
        script: 'document.createElement("div")',
      });

      expect(result).toEqual({ tagName: 'DIV', id: 'test' });
    });

    it('should pass args to the script', async () => {
      await executeScript({ script: 'return arguments[0]', args: ['value1'] });

      expect(adapter.executeScript).toHaveBeenCalledWith(
        expect.objectContaining({ args: ['value1'] }),
      );
    });
  });

  describe('error handling', () => {
    it('should throw on invalid params (missing script)', async () => {
      await expect(executeScript({})).rejects.toThrow('Invalid executeScript params');
    });

    it('should throw on empty script', async () => {
      await expect(executeScript({ script: '' })).rejects.toThrow('Invalid executeScript params');
    });

    it('should throw when adapter returns error', async () => {
      adapter = createMockAdapter({
        executeScript: vi.fn().mockResolvedValue(
          err({ code: ErrorCode.SCRIPT_EXECUTION_FAILED, message: 'ReferenceError: x is not defined' }),
        ),
      });
      executeScript = createExecuteScriptHandler(adapter);

      await expect(executeScript({ script: 'x' })).rejects.toThrow('[SCRIPT_EXECUTION_FAILED]');
    });

    it('should throw with error message from adapter', async () => {
      adapter = createMockAdapter({
        executeScript: vi.fn().mockResolvedValue(
          err({ code: ErrorCode.TIMEOUT, message: 'Script timed out' }),
        ),
      });
      executeScript = createExecuteScriptHandler(adapter);

      await expect(executeScript({ script: 'while(true){}' })).rejects.toThrow('Script timed out');
    });
  });

  describe('sandbox isolation', () => {
    it('should pass custom timeout', async () => {
      await executeScript({ script: 'return 1', timeout: 5000 });

      expect(adapter.executeScript).toHaveBeenCalledWith(
        expect.objectContaining({ timeout: 5000 }),
      );
    });

    it('should use default timeout of 30s when not specified', async () => {
      await executeScript({ script: 'return 1' });

      expect(adapter.executeScript).toHaveBeenCalledWith(
        expect.objectContaining({ timeout: 30_000 }),
      );
    });

    it('should serialize object results via JSON round-trip', async () => {
      const complexObj = { nested: { arr: [1, 2, 3] } };
      adapter = createMockAdapter({
        executeScript: vi.fn().mockResolvedValue(ok(complexObj)),
      });
      executeScript = createExecuteScriptHandler(adapter);

      const result = await executeScript({ script: 'return obj' });

      expect(result).toEqual(complexObj);
    });
  });
});

describe('createExecuteConsoleHandler', () => {
  let adapter: IBrowserAdapter;
  let executeConsole: ReturnType<typeof createExecuteConsoleHandler>;

  beforeEach(() => {
    adapter = createMockAdapter();
    executeConsole = createExecuteConsoleHandler(adapter);
  });

  describe('log capture', () => {
    it('should execute a console command and return output', async () => {
      const consoleOutput = {
        returnValue: 42,
        consoleOutput: [
          { level: 'log', message: 'hello' },
        ],
      };
      adapter = createMockAdapter({
        executeConsoleCommand: vi.fn().mockResolvedValue(ok(consoleOutput)),
      });
      executeConsole = createExecuteConsoleHandler(adapter);

      const result = await executeConsole({ command: 'console.log("hello"); 42' });

      expect(result).toEqual(consoleOutput);
      expect(adapter.executeConsoleCommand).toHaveBeenCalledWith({
        command: 'console.log("hello"); 42',
        timeout: 30_000,
      });
    });

    it('should capture multiple console entries', async () => {
      const consoleOutput = {
        returnValue: undefined,
        consoleOutput: [
          { level: 'log', message: 'first' },
          { level: 'log', message: 'second' },
          { level: 'log', message: 'third' },
        ],
      };
      adapter = createMockAdapter({
        executeConsoleCommand: vi.fn().mockResolvedValue(ok(consoleOutput)),
      });
      executeConsole = createExecuteConsoleHandler(adapter);

      const result = await executeConsole({ command: 'multi()' }) as typeof consoleOutput;

      expect(result.consoleOutput).toHaveLength(3);
    });
  });

  describe('level distinction', () => {
    it('should distinguish log, warn, and error levels', async () => {
      const consoleOutput = {
        returnValue: undefined,
        consoleOutput: [
          { level: 'log', message: 'info message' },
          { level: 'warn', message: 'warning message' },
          { level: 'error', message: 'error message' },
        ],
      };
      adapter = createMockAdapter({
        executeConsoleCommand: vi.fn().mockResolvedValue(ok(consoleOutput)),
      });
      executeConsole = createExecuteConsoleHandler(adapter);

      const result = await executeConsole({ command: 'test()' }) as typeof consoleOutput;

      expect(result.consoleOutput[0]!.level).toBe('log');
      expect(result.consoleOutput[1]!.level).toBe('warn');
      expect(result.consoleOutput[2]!.level).toBe('error');
    });
  });

  describe('error handling', () => {
    it('should throw on invalid params (missing command)', async () => {
      await expect(executeConsole({})).rejects.toThrow('Invalid executeConsoleCommand params');
    });

    it('should throw on empty command', async () => {
      await expect(executeConsole({ command: '' })).rejects.toThrow('Invalid executeConsoleCommand params');
    });

    it('should throw when adapter returns error', async () => {
      adapter = createMockAdapter({
        executeConsoleCommand: vi.fn().mockResolvedValue(
          err({ code: ErrorCode.SCRIPT_EXECUTION_FAILED, message: 'Syntax error' }),
        ),
      });
      executeConsole = createExecuteConsoleHandler(adapter);

      await expect(executeConsole({ command: 'bad(' })).rejects.toThrow('[SCRIPT_EXECUTION_FAILED]');
    });

    it('should pass custom timeout', async () => {
      await executeConsole({ command: 'test()', timeout: 5000 });

      expect(adapter.executeConsoleCommand).toHaveBeenCalledWith({
        command: 'test()',
        timeout: 5000,
      });
    });
  });
});
