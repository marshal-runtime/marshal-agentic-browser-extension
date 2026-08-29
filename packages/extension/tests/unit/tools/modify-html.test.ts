import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createModifyHTMLHandler } from '../../../src/tools/modify-html.js';
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
    executeScript: vi.fn().mockResolvedValue(ok(undefined)),
    evaluateExpression: vi.fn(),
    executeConsoleCommand: vi.fn(),
    injectScript: vi.fn(),
    removeScript: vi.fn(),
    sendCdpCommand: vi.fn(),
    attachDebugger: vi.fn(),
    detachDebugger: vi.fn(),
    setOuterHtml: vi.fn().mockResolvedValue(ok(undefined)),
    setInnerHtml: vi.fn().mockResolvedValue(ok(undefined)),
    insertAdjacentHtml: vi.fn().mockResolvedValue(ok(undefined)),
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

describe('createModifyHTMLHandler', () => {
  let adapter: IBrowserAdapter;
  let modifyHTML: ReturnType<typeof createModifyHTMLHandler>;

  beforeEach(() => {
    adapter = createMockAdapter();
    modifyHTML = createModifyHTMLHandler(adapter);
  });

  describe('modifyText', () => {
    it('should change text content of an element', async () => {
      const result = await modifyHTML({
        action: 'modifyText',
        selector: '#title',
        text: 'New Title',
      });

      expect(result).toEqual({
        action: 'modifyText',
        selector: '#title',
        success: true,
      });
      expect(adapter.setInnerHtml).toHaveBeenCalledWith({
        selector: '#title',
        html: 'New Title',
      });
    });

    it('should throw when text is missing for modifyText', async () => {
      await expect(
        modifyHTML({ action: 'modifyText', selector: '#title' }),
      ).rejects.toThrow('modifyText action requires "text" parameter');
    });

    it('should throw when adapter returns error', async () => {
      adapter = createMockAdapter({
        setInnerHtml: vi.fn().mockResolvedValue(
          err({ code: ErrorCode.ELEMENT_NOT_FOUND, message: 'Element not found' }),
        ),
      });
      modifyHTML = createModifyHTMLHandler(adapter);

      await expect(
        modifyHTML({ action: 'modifyText', selector: '#missing', text: 'x' }),
      ).rejects.toThrow('[ELEMENT_NOT_FOUND]');
    });
  });

  describe('addElement', () => {
    it('should add an element with default position (beforeend)', async () => {
      const result = await modifyHTML({
        action: 'addElement',
        selector: '#container',
        html: '<p>New paragraph</p>',
      });

      expect(result).toEqual({
        action: 'addElement',
        selector: '#container',
        success: true,
      });
      expect(adapter.insertAdjacentHtml).toHaveBeenCalledWith({
        selector: '#container',
        position: 'beforeend',
        html: '<p>New paragraph</p>',
      });
    });

    it('should add an element with custom position', async () => {
      await modifyHTML({
        action: 'addElement',
        selector: '#container',
        html: '<p>Before</p>',
        position: 'beforebegin',
      });

      expect(adapter.insertAdjacentHtml).toHaveBeenCalledWith({
        selector: '#container',
        position: 'beforebegin',
        html: '<p>Before</p>',
      });
    });

    it('should throw when html is missing for addElement', async () => {
      await expect(
        modifyHTML({ action: 'addElement', selector: '#container' }),
      ).rejects.toThrow('addElement action requires "html" parameter');
    });
  });

  describe('removeElement', () => {
    it('should remove an element by setting outerHTML to empty', async () => {
      const result = await modifyHTML({
        action: 'removeElement',
        selector: '#obsolete',
      });

      expect(result).toEqual({
        action: 'removeElement',
        selector: '#obsolete',
        success: true,
      });
      expect(adapter.setOuterHtml).toHaveBeenCalledWith({
        selector: '#obsolete',
        html: '',
      });
    });

    it('should throw when adapter returns error for remove', async () => {
      adapter = createMockAdapter({
        setOuterHtml: vi.fn().mockResolvedValue(
          err({ code: ErrorCode.ELEMENT_NOT_FOUND, message: 'Not found' }),
        ),
      });
      modifyHTML = createModifyHTMLHandler(adapter);

      await expect(
        modifyHTML({ action: 'removeElement', selector: '#gone' }),
      ).rejects.toThrow('[ELEMENT_NOT_FOUND]');
    });
  });

  describe('ELEMENT_NOT_FOUND error', () => {
    it('should propagate ELEMENT_NOT_FOUND from modifyText', async () => {
      adapter = createMockAdapter({
        setInnerHtml: vi.fn().mockResolvedValue(
          err({ code: ErrorCode.ELEMENT_NOT_FOUND, message: 'Selector matched nothing' }),
        ),
      });
      modifyHTML = createModifyHTMLHandler(adapter);

      await expect(
        modifyHTML({ action: 'modifyText', selector: '.nonexistent', text: 'x' }),
      ).rejects.toThrow('Selector matched nothing');
    });

    it('should propagate ELEMENT_NOT_FOUND from addElement', async () => {
      adapter = createMockAdapter({
        insertAdjacentHtml: vi.fn().mockResolvedValue(
          err({ code: ErrorCode.ELEMENT_NOT_FOUND, message: 'Parent not found' }),
        ),
      });
      modifyHTML = createModifyHTMLHandler(adapter);

      await expect(
        modifyHTML({ action: 'addElement', selector: '.missing', html: '<div/>' }),
      ).rejects.toThrow('Parent not found');
    });
  });

  describe('validation', () => {
    it('should throw on invalid params', async () => {
      await expect(modifyHTML(null)).rejects.toThrow('Invalid modifyHTML params');
    });

    it('should throw on missing action', async () => {
      await expect(modifyHTML({ selector: '#x' })).rejects.toThrow('Invalid modifyHTML params');
    });

    it('should throw on missing selector', async () => {
      await expect(modifyHTML({ action: 'modifyText' })).rejects.toThrow('Invalid modifyHTML params');
    });
  });
});
