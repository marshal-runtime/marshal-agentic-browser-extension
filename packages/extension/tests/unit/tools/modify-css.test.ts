import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createModifyCSSHandler } from '../../../src/tools/modify-css.js';
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
    setOuterHtml: vi.fn(),
    setInnerHtml: vi.fn(),
    insertAdjacentHtml: vi.fn(),
    addStyleSheet: vi.fn().mockResolvedValue(ok('style-123')),
    modifyStyle: vi.fn().mockResolvedValue(ok(undefined)),
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

describe('createModifyCSSHandler', () => {
  let adapter: IBrowserAdapter;
  let modifyCSS: ReturnType<typeof createModifyCSSHandler>;

  beforeEach(() => {
    adapter = createMockAdapter();
    modifyCSS = createModifyCSSHandler(adapter);
  });

  describe('setStyle', () => {
    it('should set inline styles on an element', async () => {
      const result = await modifyCSS({
        action: 'setStyle',
        selector: '#box',
        styles: { color: 'red', fontSize: '16px' },
      });

      expect(result).toEqual({
        action: 'setStyle',
        selector: '#box',
        success: true,
      });
      expect(adapter.modifyStyle).toHaveBeenCalledWith({
        selector: '#box',
        styles: { color: 'red', fontSize: '16px' },
      });
    });

    it('should throw when selector is missing for setStyle', async () => {
      await expect(
        modifyCSS({ action: 'setStyle', styles: { color: 'red' } }),
      ).rejects.toThrow('setStyle action requires "selector" parameter');
    });

    it('should throw when styles is missing for setStyle', async () => {
      await expect(
        modifyCSS({ action: 'setStyle', selector: '#box' }),
      ).rejects.toThrow('setStyle action requires "styles" parameter');
    });

    it('should throw when styles is empty for setStyle', async () => {
      await expect(
        modifyCSS({ action: 'setStyle', selector: '#box', styles: {} }),
      ).rejects.toThrow('setStyle action requires "styles" parameter');
    });

    it('should throw when adapter returns error', async () => {
      adapter = createMockAdapter({
        modifyStyle: vi.fn().mockResolvedValue(
          err({ code: ErrorCode.STYLE_ERROR, message: 'Style operation failed' }),
        ),
      });
      modifyCSS = createModifyCSSHandler(adapter);

      await expect(
        modifyCSS({ action: 'setStyle', selector: '#box', styles: { color: 'red' } }),
      ).rejects.toThrow('[STYLE_ERROR]');
    });
  });

  describe('addClass', () => {
    it('should add a class to an element via executeScript', async () => {
      const result = await modifyCSS({
        action: 'addClass',
        selector: '.item',
        className: 'highlight',
      });

      expect(result).toEqual({
        action: 'addClass',
        selector: '.item',
        success: true,
      });
      expect(adapter.executeScript).toHaveBeenCalledWith({
        script: expect.stringContaining('classList.add'),
      });
    });

    it('should throw when selector is missing for addClass', async () => {
      await expect(
        modifyCSS({ action: 'addClass', className: 'active' }),
      ).rejects.toThrow('addClass action requires "selector" parameter');
    });

    it('should throw when className is missing for addClass', async () => {
      await expect(
        modifyCSS({ action: 'addClass', selector: '.item' }),
      ).rejects.toThrow('addClass action requires "className" parameter');
    });
  });

  describe('removeClass', () => {
    it('should remove a class from an element via executeScript', async () => {
      const result = await modifyCSS({
        action: 'removeClass',
        selector: '.item',
        className: 'highlight',
      });

      expect(result).toEqual({
        action: 'removeClass',
        selector: '.item',
        success: true,
      });
      expect(adapter.executeScript).toHaveBeenCalledWith({
        script: expect.stringContaining('classList.remove'),
      });
    });

    it('should throw when adapter returns error for removeClass', async () => {
      adapter = createMockAdapter({
        executeScript: vi.fn().mockResolvedValue(
          err({ code: ErrorCode.ELEMENT_NOT_FOUND, message: 'Element not found' }),
        ),
      });
      modifyCSS = createModifyCSSHandler(adapter);

      await expect(
        modifyCSS({ action: 'removeClass', selector: '#gone', className: 'x' }),
      ).rejects.toThrow('[ELEMENT_NOT_FOUND]');
    });
  });

  describe('injectStylesheet', () => {
    it('should inject a stylesheet and return styleId', async () => {
      const result = await modifyCSS({
        action: 'injectStylesheet',
        css: 'body { background: blue; }',
      });

      expect(result).toEqual({
        action: 'injectStylesheet',
        success: true,
        data: { styleId: 'style-123' },
      });
      expect(adapter.addStyleSheet).toHaveBeenCalledWith({
        css: 'body { background: blue; }',
      });
    });

    it('should throw when css is missing for injectStylesheet', async () => {
      await expect(
        modifyCSS({ action: 'injectStylesheet' }),
      ).rejects.toThrow('injectStylesheet action requires "css" parameter');
    });

    it('should throw when adapter returns error for injectStylesheet', async () => {
      adapter = createMockAdapter({
        addStyleSheet: vi.fn().mockResolvedValue(
          err({ code: ErrorCode.STYLE_ERROR, message: 'Failed to inject' }),
        ),
      });
      modifyCSS = createModifyCSSHandler(adapter);

      await expect(
        modifyCSS({ action: 'injectStylesheet', css: 'invalid{' }),
      ).rejects.toThrow('[STYLE_ERROR]');
    });
  });

  describe('no persist on reload', () => {
    it('should call adapter methods without persistence flags', async () => {
      await modifyCSS({
        action: 'setStyle',
        selector: '#box',
        styles: { display: 'none' },
      });

      expect(adapter.modifyStyle).toHaveBeenCalledWith({
        selector: '#box',
        styles: { display: 'none' },
      });
    });

    it('should inject stylesheet without persistence', async () => {
      await modifyCSS({
        action: 'injectStylesheet',
        css: '.temp { opacity: 0; }',
      });

      expect(adapter.addStyleSheet).toHaveBeenCalledWith({
        css: '.temp { opacity: 0; }',
      });
    });
  });

  describe('validation', () => {
    it('should throw on invalid params', async () => {
      await expect(modifyCSS(null)).rejects.toThrow('Invalid modifyCSS params');
    });

    it('should throw on missing action', async () => {
      await expect(modifyCSS({ selector: '#x' })).rejects.toThrow('Invalid modifyCSS params');
    });
  });
});
