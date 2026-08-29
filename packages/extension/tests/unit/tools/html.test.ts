import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createGetHTMLHandler } from '../../../src/tools/html.js';
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
    getPageContent: vi.fn().mockResolvedValue(
      ok('<html><head><title>Test</title></head><body><h1>Hello</h1></body></html>'),
    ),
    getOuterHtml: vi.fn().mockResolvedValue(ok('<h1>Hello</h1>')),
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

describe('createGetHTMLHandler', () => {
  let adapter: IBrowserAdapter;
  let getHTML: ReturnType<typeof createGetHTMLHandler>;

  beforeEach(() => {
    adapter = createMockAdapter();
    getHTML = createGetHTMLHandler(adapter);
  });

  describe('full page', () => {
    it('should return full page HTML when no selector is provided', async () => {
      const result = await getHTML({});

      const expectedHtml = '<html><head><title>Test</title></head><body><h1>Hello</h1></body></html>';
      expect(result).toEqual({
        html: expectedHtml,
        length: expectedHtml.length,
      });
      expect(adapter.getPageContent).toHaveBeenCalled();
      expect(adapter.getOuterHtml).not.toHaveBeenCalled();
    });

    it('should include correct length for page content', async () => {
      const longHtml = '<html>' + 'x'.repeat(1000) + '</html>';
      adapter = createMockAdapter({
        getPageContent: vi.fn().mockResolvedValue(ok(longHtml)),
      });
      getHTML = createGetHTMLHandler(adapter);

      const result = await getHTML({});

      expect(result.length).toBe(longHtml.length);
    });

    it('should not include selector in response for full page', async () => {
      const result = await getHTML({});

      expect(result.selector).toBeUndefined();
    });
  });

  describe('partial by selector', () => {
    it('should return element HTML when selector is provided', async () => {
      const result = await getHTML({ selector: 'h1' });

      expect(result).toEqual({
        html: '<h1>Hello</h1>',
        selector: 'h1',
        length: 14,
      });
      expect(adapter.getOuterHtml).toHaveBeenCalledWith('h1');
      expect(adapter.getPageContent).not.toHaveBeenCalled();
    });

    it('should pass complex selectors to adapter', async () => {
      adapter = createMockAdapter({
        getOuterHtml: vi.fn().mockResolvedValue(ok('<div class="container"><p>Content</p></div>')),
      });
      getHTML = createGetHTMLHandler(adapter);

      const result = await getHTML({ selector: 'div.container' });

      expect(result.selector).toBe('div.container');
      expect(adapter.getOuterHtml).toHaveBeenCalledWith('div.container');
    });

    it('should include correct length for element content', async () => {
      const elementHtml = '<div id="test"><span>Nested</span></div>';
      adapter = createMockAdapter({
        getOuterHtml: vi.fn().mockResolvedValue(ok(elementHtml)),
      });
      getHTML = createGetHTMLHandler(adapter);

      const result = await getHTML({ selector: '#test' });

      expect(result.length).toBe(elementHtml.length);
    });
  });

  describe('dynamic content', () => {
    it('should return current DOM state including dynamically added content', async () => {
      const dynamicHtml = '<div id="dynamic"><p>Loaded dynamically</p></div>';
      adapter = createMockAdapter({
        getOuterHtml: vi.fn().mockResolvedValue(ok(dynamicHtml)),
      });
      getHTML = createGetHTMLHandler(adapter);

      const result = await getHTML({ selector: '#dynamic' });

      expect(result.html).toBe(dynamicHtml);
      expect(result.html).toContain('Loaded dynamically');
    });
  });

  describe('error cases', () => {
    it('should throw when getPageContent fails', async () => {
      adapter = createMockAdapter({
        getPageContent: vi.fn().mockResolvedValue(
          err({ code: ErrorCode.CDP_ERROR, message: 'Cannot get page content' }),
        ),
      });
      getHTML = createGetHTMLHandler(adapter);

      await expect(getHTML({})).rejects.toThrow('[CDP_ERROR]');
    });

    it('should throw when element not found by selector', async () => {
      adapter = createMockAdapter({
        getOuterHtml: vi.fn().mockResolvedValue(
          err({ code: ErrorCode.ELEMENT_NOT_FOUND, message: 'Element not found' }),
        ),
      });
      getHTML = createGetHTMLHandler(adapter);

      await expect(getHTML({ selector: '#nonexistent' })).rejects.toThrow('[ELEMENT_NOT_FOUND]');
    });
  });
});
