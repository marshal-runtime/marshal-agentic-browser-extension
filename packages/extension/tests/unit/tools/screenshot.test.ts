import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createScreenshotHandler } from '../../../src/tools/screenshot.js';
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
    captureScreenshot: vi.fn().mockResolvedValue(
      ok({ data: 'iVBORw0KGgo=', mimeType: 'image/png', width: 1280, height: 720 }),
    ),
    captureFullPageScreenshot: vi.fn().mockResolvedValue(
      ok({ data: 'iVBORw0KGgo=', mimeType: 'image/png', width: 1280, height: 3000 }),
    ),
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

describe('createScreenshotHandler', () => {
  let adapter: IBrowserAdapter;
  let screenshot: ReturnType<typeof createScreenshotHandler>;

  beforeEach(() => {
    adapter = createMockAdapter();
    screenshot = createScreenshotHandler(adapter);
  });

  describe('viewport screenshot', () => {
    it('should capture viewport screenshot with defaults', async () => {
      const result = await screenshot({});

      expect(result).toEqual({
        data: 'iVBORw0KGgo=',
        mimeType: 'image/png',
        width: 1280,
        height: 720,
      });
      expect(adapter.captureScreenshot).toHaveBeenCalledWith({
        format: undefined,
        quality: undefined,
        fullPage: false,
      });
    });

    it('should pass format and quality to adapter', async () => {
      await screenshot({ format: 'jpeg', quality: 80 });

      expect(adapter.captureScreenshot).toHaveBeenCalledWith({
        format: 'jpeg',
        quality: 80,
        fullPage: false,
      });
    });
  });

  describe('full-page screenshot', () => {
    it('should capture full-page screenshot when fullPage is true', async () => {
      const result = await screenshot({ fullPage: true });

      expect(result).toEqual({
        data: 'iVBORw0KGgo=',
        mimeType: 'image/png',
        width: 1280,
        height: 3000,
      });
      expect(adapter.captureFullPageScreenshot).toHaveBeenCalledWith({
        format: undefined,
        quality: undefined,
      });
    });

    it('should pass format to full-page screenshot', async () => {
      await screenshot({ fullPage: true, format: 'webp' });

      expect(adapter.captureFullPageScreenshot).toHaveBeenCalledWith({
        format: 'webp',
        quality: undefined,
      });
    });
  });

  describe('format options', () => {
    it('should accept png format', async () => {
      await screenshot({ format: 'png' });

      expect(adapter.captureScreenshot).toHaveBeenCalledWith(
        expect.objectContaining({ format: 'png' }),
      );
    });

    it('should accept jpeg format', async () => {
      await screenshot({ format: 'jpeg' });

      expect(adapter.captureScreenshot).toHaveBeenCalledWith(
        expect.objectContaining({ format: 'jpeg' }),
      );
    });

    it('should accept webp format', async () => {
      await screenshot({ format: 'webp' });

      expect(adapter.captureScreenshot).toHaveBeenCalledWith(
        expect.objectContaining({ format: 'webp' }),
      );
    });

    it('should accept quality parameter', async () => {
      await screenshot({ format: 'jpeg', quality: 50 });

      expect(adapter.captureScreenshot).toHaveBeenCalledWith(
        expect.objectContaining({ quality: 50 }),
      );
    });
  });

  describe('error cases', () => {
    it('should throw when adapter returns screenshot error', async () => {
      adapter = createMockAdapter({
        captureScreenshot: vi.fn().mockResolvedValue(
          err({ code: ErrorCode.SCREENSHOT_FAILED, message: 'Capture failed' }),
        ),
      });
      screenshot = createScreenshotHandler(adapter);

      await expect(screenshot({})).rejects.toThrow('[SCREENSHOT_FAILED]');
    });

    it('should throw when full-page screenshot fails', async () => {
      adapter = createMockAdapter({
        captureFullPageScreenshot: vi.fn().mockResolvedValue(
          err({ code: ErrorCode.SCREENSHOT_FAILED, message: 'Full page capture failed' }),
        ),
      });
      screenshot = createScreenshotHandler(adapter);

      await expect(screenshot({ fullPage: true })).rejects.toThrow('[SCREENSHOT_FAILED]');
    });

    it('should throw on invalid format value', async () => {
      await expect(screenshot({ format: 'bmp' })).rejects.toThrow('Invalid screenshot params');
    });

    it('should throw on invalid quality value', async () => {
      await expect(screenshot({ quality: 200 })).rejects.toThrow('Invalid screenshot params');
    });
  });

  describe('element screenshot', () => {
    it('should capture element screenshot when selector is provided', async () => {
      const result = await screenshot({ selector: '#myElement' });

      expect(result).toEqual({
        data: 'iVBORw0KGgo=',
        mimeType: 'image/png',
        width: 1280,
        height: 720,
      });
      expect(adapter.captureScreenshot).toHaveBeenCalledWith({
        selector: '#myElement',
        format: undefined,
        quality: undefined,
      });
    });

    it('should pass format and quality with selector', async () => {
      await screenshot({ selector: '.card', format: 'jpeg', quality: 90 });

      expect(adapter.captureScreenshot).toHaveBeenCalledWith({
        selector: '.card',
        format: 'jpeg',
        quality: 90,
      });
    });

    it('should not call captureFullPageScreenshot when selector is set', async () => {
      await screenshot({ selector: '#header', fullPage: true });

      expect(adapter.captureScreenshot).toHaveBeenCalledWith(
        expect.objectContaining({ selector: '#header' }),
      );
      expect(adapter.captureFullPageScreenshot).not.toHaveBeenCalled();
    });

    it('should throw when element screenshot fails', async () => {
      adapter = createMockAdapter({
        captureScreenshot: vi.fn().mockResolvedValue(
          err({ code: ErrorCode.ELEMENT_NOT_FOUND, message: 'Element not found' }),
        ),
      });
      screenshot = createScreenshotHandler(adapter);

      await expect(screenshot({ selector: '#missing' })).rejects.toThrow('[ELEMENT_NOT_FOUND]');
    });

    it('should handle partially off-screen elements via adapter', async () => {
      adapter = createMockAdapter({
        captureScreenshot: vi.fn().mockResolvedValue(
          ok({ data: 'clipped==', mimeType: 'image/png', width: 200, height: 150 }),
        ),
      });
      screenshot = createScreenshotHandler(adapter);

      const result = await screenshot({ selector: '.offscreen-element' });

      expect(result).toEqual({
        data: 'clipped==',
        mimeType: 'image/png',
        width: 200,
        height: 150,
      });
      expect(adapter.captureScreenshot).toHaveBeenCalledWith(
        expect.objectContaining({ selector: '.offscreen-element' }),
      );
    });
  });

});
