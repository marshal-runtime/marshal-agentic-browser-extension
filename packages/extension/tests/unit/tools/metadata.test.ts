import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMetadataHandler } from '../../../src/tools/metadata.js';
import type { IBrowserAdapter, PageMetadata } from '@agentic-browser/shared';
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
    executeScript: vi.fn().mockResolvedValue(
      ok({
        title: 'Test Page',
        description: 'A test page description',
        canonicalUrl: 'https://example.com/test',
        language: 'en',
        favicon: '/favicon.ico',
        openGraph: {
          title: 'OG Title',
          description: 'OG Description',
          image: 'https://example.com/image.png',
          url: 'https://example.com/test',
          type: 'website',
          siteName: 'Example',
        },
        metaTags: {
          description: 'A test page description',
          'og:title': 'OG Title',
          'og:description': 'OG Description',
          'og:image': 'https://example.com/image.png',
          'og:url': 'https://example.com/test',
          'og:type': 'website',
          'og:site_name': 'Example',
        },
      }),
    ),
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

describe('createMetadataHandler', () => {
  let adapter: IBrowserAdapter;
  let getMetadata: ReturnType<typeof createMetadataHandler>;

  beforeEach(() => {
    adapter = createMockAdapter();
    getMetadata = createMetadataHandler(adapter);
  });

  describe('successful extraction', () => {
    it('should extract page title, canonical URL, and meta description', async () => {
      const result = await getMetadata({});

      expect(result.title).toBe('Test Page');
      expect(result.description).toBe('A test page description');
      expect(result.canonicalUrl).toBe('https://example.com/test');
    });

    it('should extract Open Graph metadata', async () => {
      const result = await getMetadata({});

      expect(result.openGraph).toEqual({
        title: 'OG Title',
        description: 'OG Description',
        image: 'https://example.com/image.png',
        url: 'https://example.com/test',
        type: 'website',
        siteName: 'Example',
      });
    });

    it('should return structured JSON metadata', async () => {
      const result = await getMetadata({});

      expect(result).toEqual(
        expect.objectContaining({
          title: expect.any(String),
          openGraph: expect.any(Object),
          metaTags: expect.any(Object),
        }),
      );
    });

    it('should extract language and favicon', async () => {
      const result = await getMetadata({});

      expect(result.language).toBe('en');
      expect(result.favicon).toBe('/favicon.ico');
    });

    it('should call executeScript on the adapter', async () => {
      await getMetadata({});

      expect(adapter.executeScript).toHaveBeenCalledWith(
        expect.objectContaining({
          script: expect.any(String),
        }),
      );
    });
  });

  describe('minimal metadata', () => {
    it('should handle pages with no metadata', async () => {
      adapter = createMockAdapter({
        executeScript: vi.fn().mockResolvedValue(
          ok({
            title: '',
            description: undefined,
            canonicalUrl: undefined,
            language: undefined,
            favicon: undefined,
            openGraph: {
              title: undefined,
              description: undefined,
              image: undefined,
              url: undefined,
              type: undefined,
              siteName: undefined,
            },
            metaTags: {},
          }),
        ),
      });
      getMetadata = createMetadataHandler(adapter);

      const result = await getMetadata({});

      expect(result.title).toBe('');
      expect(result.description).toBeUndefined();
      expect(result.canonicalUrl).toBeUndefined();
      expect(result.metaTags).toEqual({});
    });
  });

  describe('error cases', () => {
    it('should throw when adapter returns an error', async () => {
      adapter = createMockAdapter({
        executeScript: vi.fn().mockResolvedValue(
          err({ code: ErrorCode.SCRIPT_EXECUTION_FAILED, message: 'Script execution failed' }),
        ),
      });
      getMetadata = createMetadataHandler(adapter);

      await expect(getMetadata({})).rejects.toThrow('[SCRIPT_EXECUTION_FAILED]');
    });
  });
});
