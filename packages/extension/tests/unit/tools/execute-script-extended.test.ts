import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createExecuteScriptFileHandler, createExecuteValidationHandler } from '../../../src/tools/execute-script.js';
import type { IBrowserAdapter, ValidationResult } from '@agentic-browser/shared';
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
    executeScript: vi.fn(),
    evaluateExpression: vi.fn(),
    executeConsoleCommand: vi.fn(),
    executeScriptFile: vi.fn().mockResolvedValue(ok('file-result')),
    executeValidation: vi.fn().mockResolvedValue(ok({
      passed: 2,
      failed: 0,
      skipped: 0,
      assertions: [
        { name: 'test1', status: 'passed', message: 'Passed' },
        { name: 'test2', status: 'passed', message: 'Passed' },
      ],
    } satisfies ValidationResult)),
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
    listBookmarks: vi.fn(),
    createBookmark: vi.fn(),
    searchBookmarks: vi.fn(),
    searchHistory: vi.fn(),
    getHistoryEntries: vi.fn(),
    getDownloadItems: vi.fn(),
    monitorDownloads: vi.fn(),
    ...overrides,
  } as IBrowserAdapter;
}

describe('createExecuteScriptFileHandler', () => {
  let adapter: IBrowserAdapter;
  let executeScriptFile: ReturnType<typeof createExecuteScriptFileHandler>;

  beforeEach(() => {
    adapter = createMockAdapter();
    executeScriptFile = createExecuteScriptFileHandler(adapter);
  });

  describe('file loading and execution', () => {
    it('should load a JS file from a specified URL and execute it', async () => {
      const result = await executeScriptFile({ file: 'https://example.com/script.js' });

      expect(result).toBe('file-result');
      expect(adapter.executeScriptFile).toHaveBeenCalledWith({
        file: 'https://example.com/script.js',
        timeout: 30_000,
      });
    });

    it('should load a JS file from a local path', async () => {
      adapter = createMockAdapter({
        executeScriptFile: vi.fn().mockResolvedValue(ok('local-result')),
      });
      executeScriptFile = createExecuteScriptFileHandler(adapter);

      const result = await executeScriptFile({ file: '/scripts/test.js' });

      expect(result).toBe('local-result');
      expect(adapter.executeScriptFile).toHaveBeenCalledWith({
        file: '/scripts/test.js',
        timeout: 30_000,
      });
    });

    it('should return null for undefined results', async () => {
      adapter = createMockAdapter({
        executeScriptFile: vi.fn().mockResolvedValue(ok(undefined)),
      });
      executeScriptFile = createExecuteScriptFileHandler(adapter);

      const result = await executeScriptFile({ file: 'https://example.com/void.js' });

      expect(result).toBeNull();
    });
  });

  describe('error handling', () => {
    it('should handle load failures with descriptive error', async () => {
      adapter = createMockAdapter({
        executeScriptFile: vi.fn().mockResolvedValue(
          err({
            code: ErrorCode.SCRIPT_EXECUTION_FAILED,
            message: 'Failed to load script file: 404 Not Found for https://example.com/missing.js',
          }),
        ),
      });
      executeScriptFile = createExecuteScriptFileHandler(adapter);

      await expect(executeScriptFile({ file: 'https://example.com/missing.js' })).rejects.toThrow(
        'Failed to load script file: 404 Not Found',
      );
    });

    it('should throw on invalid params (missing file)', async () => {
      await expect(executeScriptFile({})).rejects.toThrow('Invalid executeScriptFile params');
    });

    it('should throw on empty file string', async () => {
      await expect(executeScriptFile({ file: '' })).rejects.toThrow('Invalid executeScriptFile params');
    });

    it('should throw when adapter returns timeout error', async () => {
      adapter = createMockAdapter({
        executeScriptFile: vi.fn().mockResolvedValue(
          err({ code: ErrorCode.TIMEOUT, message: 'Script file execution timed out' }),
        ),
      });
      executeScriptFile = createExecuteScriptFileHandler(adapter);

      await expect(executeScriptFile({ file: 'https://example.com/slow.js' })).rejects.toThrow(
        'Script file execution timed out',
      );
    });

    it('should pass custom timeout', async () => {
      await executeScriptFile({ file: 'https://example.com/script.js', timeout: 5000 });

      expect(adapter.executeScriptFile).toHaveBeenCalledWith({
        file: 'https://example.com/script.js',
        timeout: 5000,
      });
    });
  });
});

describe('createExecuteValidationHandler', () => {
  let adapter: IBrowserAdapter;
  let executeValidation: ReturnType<typeof createExecuteValidationHandler>;

  beforeEach(() => {
    adapter = createMockAdapter();
    executeValidation = createExecuteValidationHandler(adapter);
  });

  describe('validation scripts return pass/fail results', () => {
    it('should return structured validation report with all passed', async () => {
      const result = await executeValidation({
        script: 'assert("check1", true, "ok"); assert("check2", true, "ok");',
      });

      expect(result).toEqual({
        passed: 2,
        failed: 0,
        skipped: 0,
        assertions: [
          { name: 'test1', status: 'passed', message: 'Passed' },
          { name: 'test2', status: 'passed', message: 'Passed' },
        ],
      });
    });

    it('should return mixed pass/fail/skip results', async () => {
      const mixedResult: ValidationResult = {
        passed: 1,
        failed: 1,
        skipped: 1,
        assertions: [
          { name: 'passes', status: 'passed', message: 'OK' },
          { name: 'fails', status: 'failed', message: 'Expected true' },
          { name: 'skipped-test', status: 'skipped', message: 'Not applicable' },
        ],
      };
      adapter = createMockAdapter({
        executeValidation: vi.fn().mockResolvedValue(ok(mixedResult)),
      });
      executeValidation = createExecuteValidationHandler(adapter);

      const result = await executeValidation({
        script: 'assert("passes", true); assert("fails", false, "Expected true"); skip("skipped-test", "Not applicable");',
      });

      expect(result.passed).toBe(1);
      expect(result.failed).toBe(1);
      expect(result.skipped).toBe(1);
      expect(result.assertions).toHaveLength(3);
    });
  });

  describe('individual assertion outcomes', () => {
    it('should include individual assertion outcomes in results', async () => {
      const detailedResult: ValidationResult = {
        passed: 2,
        failed: 1,
        skipped: 0,
        assertions: [
          { name: 'title check', status: 'passed', message: 'Title matches' },
          { name: 'body check', status: 'passed', message: 'Body exists' },
          { name: 'footer check', status: 'failed', message: 'Footer not found' },
        ],
      };
      adapter = createMockAdapter({
        executeValidation: vi.fn().mockResolvedValue(ok(detailedResult)),
      });
      executeValidation = createExecuteValidationHandler(adapter);

      const result = await executeValidation({ script: 'validate()' });

      expect(result.assertions[0]).toEqual({ name: 'title check', status: 'passed', message: 'Title matches' });
      expect(result.assertions[1]).toEqual({ name: 'body check', status: 'passed', message: 'Body exists' });
      expect(result.assertions[2]).toEqual({ name: 'footer check', status: 'failed', message: 'Footer not found' });
    });

    it('should report each assertion with name, status, and message', async () => {
      const result = await executeValidation({ script: 'assert("a", true)' });

      for (const assertion of result.assertions) {
        expect(assertion).toHaveProperty('name');
        expect(assertion).toHaveProperty('status');
        expect(['passed', 'failed', 'skipped']).toContain(assertion.status);
      }
    });
  });

  describe('structured validation report', () => {
    it('should return counts for passed, failed, and skipped', async () => {
      const result = await executeValidation({ script: 'validate()' });

      expect(result).toHaveProperty('passed');
      expect(result).toHaveProperty('failed');
      expect(result).toHaveProperty('skipped');
      expect(typeof result.passed).toBe('number');
      expect(typeof result.failed).toBe('number');
      expect(typeof result.skipped).toBe('number');
    });

    it('should include assertions array in the report', async () => {
      const result = await executeValidation({ script: 'validate()' });

      expect(result).toHaveProperty('assertions');
      expect(Array.isArray(result.assertions)).toBe(true);
    });
  });

  describe('error handling', () => {
    it('should throw on invalid params (missing script)', async () => {
      await expect(executeValidation({})).rejects.toThrow('Invalid executeValidation params');
    });

    it('should throw on empty script', async () => {
      await expect(executeValidation({ script: '' })).rejects.toThrow('Invalid executeValidation params');
    });

    it('should throw when adapter returns error', async () => {
      adapter = createMockAdapter({
        executeValidation: vi.fn().mockResolvedValue(
          err({ code: ErrorCode.SCRIPT_EXECUTION_FAILED, message: 'Validation script error' }),
        ),
      });
      executeValidation = createExecuteValidationHandler(adapter);

      await expect(executeValidation({ script: 'bad()' })).rejects.toThrow('[SCRIPT_EXECUTION_FAILED]');
    });

    it('should pass custom timeout', async () => {
      await executeValidation({ script: 'validate()', timeout: 10000 });

      expect(adapter.executeValidation).toHaveBeenCalledWith({
        script: 'validate()',
        timeout: 10000,
      });
    });

    it('should use default timeout of 30s when not specified', async () => {
      await executeValidation({ script: 'validate()' });

      expect(adapter.executeValidation).toHaveBeenCalledWith({
        script: 'validate()',
        timeout: 30_000,
      });
    });
  });
});
