import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createInteractHandler } from '../../../src/tools/interact.js';
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
    click: vi.fn().mockResolvedValue(ok(undefined)),
    type: vi.fn().mockResolvedValue(ok(undefined)),
    hover: vi.fn().mockResolvedValue(ok(undefined)),
    scroll: vi.fn().mockResolvedValue(ok(undefined)),
    select: vi.fn().mockResolvedValue(ok(['option1'])),
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

describe('createInteractHandler', () => {
  let adapter: IBrowserAdapter;
  let interact: ReturnType<typeof createInteractHandler>;

  beforeEach(() => {
    adapter = createMockAdapter();
    interact = createInteractHandler(adapter);
  });

  describe('click', () => {
    it('should click an element and return success', async () => {
      const result = await interact({ action: 'click', selector: '#btn' });

      expect(result).toEqual({ action: 'click', selector: '#btn', success: true });
      expect(adapter.click).toHaveBeenCalledWith({
        selector: '#btn',
        button: undefined,
        clickCount: undefined,
        timeout: undefined,
      });
    });

    it('should pass button and clickCount options', async () => {
      await interact({ action: 'click', selector: '#btn', button: 'right', clickCount: 2 });

      expect(adapter.click).toHaveBeenCalledWith(
        expect.objectContaining({ button: 'right', clickCount: 2 }),
      );
    });

    it('should throw when element not found', async () => {
      adapter = createMockAdapter({
        click: vi.fn().mockResolvedValue(err({ code: ErrorCode.ELEMENT_NOT_FOUND, message: 'Element not found' })),
      });
      interact = createInteractHandler(adapter);

      await expect(interact({ action: 'click', selector: '#missing' })).rejects.toThrow('[ELEMENT_NOT_FOUND]');
    });
  });

  describe('type', () => {
    it('should type text into an element', async () => {
      const result = await interact({ action: 'type', selector: '#input', text: 'hello' });

      expect(result).toEqual({ action: 'type', selector: '#input', success: true });
      expect(adapter.type).toHaveBeenCalledWith({
        selector: '#input',
        text: 'hello',
        delay: undefined,
        clearFirst: undefined,
        timeout: undefined,
      });
    });

    it('should use value field when text is not provided', async () => {
      await interact({ action: 'type', selector: '#input', value: 'from-value' });

      expect(adapter.type).toHaveBeenCalledWith(
        expect.objectContaining({ text: 'from-value' }),
      );
    });

    it('should pass delay and clearFirst options', async () => {
      await interact({ action: 'type', selector: '#input', text: 'hi', delay: 100, clearFirst: true });

      expect(adapter.type).toHaveBeenCalledWith(
        expect.objectContaining({ delay: 100, clearFirst: true }),
      );
    });

    it('should throw when element not found', async () => {
      adapter = createMockAdapter({
        type: vi.fn().mockResolvedValue(err({ code: ErrorCode.ELEMENT_NOT_FOUND, message: 'Not found' })),
      });
      interact = createInteractHandler(adapter);

      await expect(interact({ action: 'type', selector: '#gone', text: 'x' })).rejects.toThrow('[ELEMENT_NOT_FOUND]');
    });
  });

  describe('select', () => {
    it('should select a value and return success with data', async () => {
      const result = await interact({ action: 'select', selector: '#dropdown', value: 'option1' });

      expect(result).toEqual({
        action: 'select',
        selector: '#dropdown',
        success: true,
        data: ['option1'],
      });
    });

    it('should pass label and index options', async () => {
      await interact({ action: 'select', selector: '#dropdown', label: 'Option A', index: 0 });

      expect(adapter.select).toHaveBeenCalledWith(
        expect.objectContaining({ label: 'Option A', index: 0 }),
      );
    });

    it('should throw when element not found', async () => {
      adapter = createMockAdapter({
        select: vi.fn().mockResolvedValue(err({ code: ErrorCode.ELEMENT_NOT_FOUND, message: 'Not found' })),
      });
      interact = createInteractHandler(adapter);

      await expect(interact({ action: 'select', selector: '#gone' })).rejects.toThrow('[ELEMENT_NOT_FOUND]');
    });
  });

  describe('hover', () => {
    it('should hover over an element and return success', async () => {
      const result = await interact({ action: 'hover', selector: '#tooltip' });

      expect(result).toEqual({ action: 'hover', selector: '#tooltip', success: true });
      expect(adapter.hover).toHaveBeenCalledWith({
        selector: '#tooltip',
        timeout: undefined,
      });
    });

    it('should throw when element is hidden', async () => {
      adapter = createMockAdapter({
        hover: vi.fn().mockResolvedValue(err({ code: ErrorCode.ELEMENT_NOT_FOUND, message: 'Element is hidden' })),
      });
      interact = createInteractHandler(adapter);

      await expect(interact({ action: 'hover', selector: '.hidden' })).rejects.toThrow('[ELEMENT_NOT_FOUND]');
    });
  });

  describe('scroll', () => {
    it('should scroll with coordinates', async () => {
      const result = await interact({ action: 'scroll', x: 0, y: 500 });

      expect(result).toEqual({ action: 'scroll', selector: undefined, success: true });
      expect(adapter.scroll).toHaveBeenCalledWith({
        selector: undefined,
        x: 0,
        y: 500,
        behavior: undefined,
        timeout: undefined,
      });
    });

    it('should scroll a specific element', async () => {
      await interact({ action: 'scroll', selector: '#container', y: 200, behavior: 'smooth' });

      expect(adapter.scroll).toHaveBeenCalledWith(
        expect.objectContaining({ selector: '#container', y: 200, behavior: 'smooth' }),
      );
    });

    it('should throw on scroll failure', async () => {
      adapter = createMockAdapter({
        scroll: vi.fn().mockResolvedValue(err({ code: ErrorCode.ELEMENT_NOT_FOUND, message: 'Scroll target not found' })),
      });
      interact = createInteractHandler(adapter);

      await expect(interact({ action: 'scroll', selector: '#missing' })).rejects.toThrow('[ELEMENT_NOT_FOUND]');
    });
  });

  describe('invalid params', () => {
    it('should throw on missing action', async () => {
      await expect(interact({})).rejects.toThrow('Invalid interact params');
    });

    it('should throw on invalid action name', async () => {
      await expect(interact({ action: 'drag' })).rejects.toThrow('Invalid interact params');
    });

    it('should throw on null params', async () => {
      await expect(interact(null)).rejects.toThrow('Invalid interact params');
    });
  });
});
