import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createExtractDataHandler } from '../../../src/tools/extract-data.js';
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
    querySelectorAll: vi.fn().mockResolvedValue(ok([])),
    getAttributes: vi.fn().mockResolvedValue(
      ok({ id: 'test', class: 'container', 'data-value': '42' }),
    ),
    executeScript: vi.fn(),
    evaluateExpression: vi.fn(),
    executeConsoleCommand: vi.fn(),
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

describe('createExtractDataHandler', () => {
  let adapter: IBrowserAdapter;
  let extractData: ReturnType<typeof createExtractDataHandler>;

  beforeEach(() => {
    adapter = createMockAdapter();
    extractData = createExtractDataHandler(adapter);
  });

  describe('table extraction', () => {
    it('should extract table data using default selector', async () => {
      const result = await extractData({ type: 'table' });

      expect(result.type).toBe('table');
      expect(adapter.querySelectorAll).toHaveBeenCalledWith({ selector: 'table' });
    });

    it('should use custom selector for table extraction', async () => {
      await extractData({ type: 'table', selector: '#products' });

      expect(adapter.querySelectorAll).toHaveBeenCalledWith({ selector: '#products' });
    });

    it('should return empty data array when no tables found', async () => {
      const result = await extractData({ type: 'table' });

      expect(result).toEqual({ type: 'table', data: [] });
    });

    it('should throw when querySelectorAll fails for table', async () => {
      adapter = createMockAdapter({
        querySelectorAll: vi.fn().mockResolvedValue(
          err({ code: ErrorCode.CDP_ERROR, message: 'Query failed' }),
        ),
      });
      extractData = createExtractDataHandler(adapter);

      await expect(extractData({ type: 'table' })).rejects.toThrow('[CDP_ERROR]');
    });
  });

  describe('CSS selectors (attributes)', () => {
    it('should extract all attributes for a selector', async () => {
      const result = await extractData({ type: 'attributes', selector: '#test' });

      expect(result.type).toBe('attributes');
      expect(result.data).toEqual([{ id: 'test', class: 'container', 'data-value': '42' }]);
      expect(adapter.getAttributes).toHaveBeenCalledWith('#test');
    });

    it('should filter to requested attributes only', async () => {
      const result = await extractData({
        type: 'attributes',
        selector: '#test',
        attributes: ['id', 'data-value'],
      });

      expect(result.data).toEqual([{ id: 'test', 'data-value': '42' }]);
    });

    it('should return empty object for non-existent requested attributes', async () => {
      const result = await extractData({
        type: 'attributes',
        selector: '#test',
        attributes: ['data-nonexistent'],
      });

      expect(result.data).toEqual([{}]);
    });

    it('should throw when getAttributes fails', async () => {
      adapter = createMockAdapter({
        getAttributes: vi.fn().mockResolvedValue(
          err({ code: ErrorCode.ELEMENT_NOT_FOUND, message: 'Element not found' }),
        ),
      });
      extractData = createExtractDataHandler(adapter);

      await expect(
        extractData({ type: 'attributes', selector: '#missing' }),
      ).rejects.toThrow('[ELEMENT_NOT_FOUND]');
    });
  });

  describe('attributes without selector', () => {
    it('should return empty data when no selector is provided', async () => {
      const result = await extractData({ type: 'attributes' });

      expect(result).toEqual({ type: 'attributes', data: [] });
      expect(adapter.getAttributes).not.toHaveBeenCalled();
    });
  });

  describe('structured extraction', () => {
    it('should return empty structured data', async () => {
      const result = await extractData({ type: 'structured' });

      expect(result).toEqual({ type: 'structured', data: [] });
    });
  });

  describe('empty result', () => {
    it('should handle table with no matching elements', async () => {
      adapter = createMockAdapter({
        querySelectorAll: vi.fn().mockResolvedValue(ok([])),
      });
      extractData = createExtractDataHandler(adapter);

      const result = await extractData({ type: 'table', selector: '.nonexistent' });

      expect(result).toEqual({ type: 'table', data: [] });
    });

    it('should handle attributes with empty attribute map', async () => {
      adapter = createMockAdapter({
        getAttributes: vi.fn().mockResolvedValue(ok({})),
      });
      extractData = createExtractDataHandler(adapter);

      const result = await extractData({ type: 'attributes', selector: 'div' });

      expect(result).toEqual({ type: 'attributes', data: [{}] });
    });
  });

  describe('invalid params', () => {
    it('should throw on missing type', async () => {
      await expect(extractData({})).rejects.toThrow('Invalid extractData params');
    });

    it('should throw on invalid type value', async () => {
      await expect(extractData({ type: 'unknown' })).rejects.toThrow('Invalid extractData params');
    });

    it('should throw on null params', async () => {
      await expect(extractData(null)).rejects.toThrow('Invalid extractData params');
    });
  });
});
