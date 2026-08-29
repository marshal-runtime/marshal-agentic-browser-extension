import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createFileOpsHandler } from '../../../src/tools/file-ops.js';
import type { IBrowserAdapter } from '@agentic-browser/shared';
import { ok, err, ErrorCode } from '@agentic-browser/shared';

function createMockAdapter(overrides: Partial<IBrowserAdapter> = {}): IBrowserAdapter & {
  setFileInput: ReturnType<typeof vi.fn>;
  getDownloadStatus: ReturnType<typeof vi.fn>;
  startDownload: ReturnType<typeof vi.fn>;
} {
  const base = {
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
    getActiveTab: vi.fn().mockResolvedValue(ok({ tabId: 1, url: 'https://example.com', title: 'Example', active: true, windowId: 1 })),
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
    setFileInput: vi.fn().mockResolvedValue(ok(undefined)),
    getDownloadStatus: vi.fn().mockResolvedValue(ok({ state: 'complete', bytesReceived: 1024, totalBytes: 1024, filename: 'test.pdf' })),
    startDownload: vi.fn().mockResolvedValue(ok({ downloadId: 42 })),
    ...overrides,
  } as IBrowserAdapter & {
    setFileInput: ReturnType<typeof vi.fn>;
    getDownloadStatus: ReturnType<typeof vi.fn>;
    startDownload: ReturnType<typeof vi.fn>;
  };

  return base;
}

describe('createFileOpsHandler', () => {
  let adapter: ReturnType<typeof createMockAdapter>;
  let fileOps: ReturnType<typeof createFileOpsHandler>;

  beforeEach(() => {
    adapter = createMockAdapter();
    fileOps = createFileOpsHandler(adapter);
  });

  describe('uploadFile', () => {
    it('should set file paths on a file input element', async () => {
      const result = await fileOps({
        action: 'uploadFile',
        selector: 'input[type=file]',
        filePaths: ['/path/to/file.pdf'],
      });

      expect(result).toEqual({
        success: true,
        action: 'uploadFile',
        message: 'Set 1 file(s) on input[type=file]',
      });
      expect(adapter.setFileInput).toHaveBeenCalledWith(1, 'input[type=file]', ['/path/to/file.pdf']);
    });

    it('should throw when selector is missing', async () => {
      await expect(
        fileOps({ action: 'uploadFile', filePaths: ['/path/to/file.pdf'] }),
      ).rejects.toThrow('selector is required');
    });

    it('should throw when filePaths is missing', async () => {
      await expect(
        fileOps({ action: 'uploadFile', selector: 'input[type=file]' }),
      ).rejects.toThrow('filePaths is required');
    });

    it('should throw when no active tab', async () => {
      adapter = createMockAdapter({
        getActiveTab: vi.fn().mockResolvedValue(err({ code: ErrorCode.TAB_NOT_FOUND, message: 'No tab' })),
      } as Partial<IBrowserAdapter>);
      fileOps = createFileOpsHandler(adapter);

      await expect(
        fileOps({ action: 'uploadFile', selector: 'input[type=file]', filePaths: ['/file.pdf'] }),
      ).rejects.toThrow('TAB_NOT_FOUND');
    });

    it('should throw when adapter setFileInput fails', async () => {
      adapter.setFileInput.mockResolvedValue(err({ code: ErrorCode.UNKNOWN, message: 'Element not found' }));

      await expect(
        fileOps({ action: 'uploadFile', selector: '#missing', filePaths: ['/file.pdf'] }),
      ).rejects.toThrow('Element not found');
    });
  });

  describe('downloadStatus', () => {
    it('should return download progress', async () => {
      const result = await fileOps({ action: 'downloadStatus', downloadId: 42 });

      expect(result).toEqual({
        success: true,
        action: 'downloadStatus',
        data: { state: 'complete', bytesReceived: 1024, totalBytes: 1024, filename: 'test.pdf' },
      });
      expect(adapter.getDownloadStatus).toHaveBeenCalledWith(42);
    });

    it('should throw when downloadId is missing', async () => {
      await expect(fileOps({ action: 'downloadStatus' })).rejects.toThrow('downloadId is required');
    });

    it('should throw when download not found', async () => {
      adapter.getDownloadStatus.mockResolvedValue(err({ code: ErrorCode.UNKNOWN, message: 'Download not found: 999' }));

      await expect(fileOps({ action: 'downloadStatus', downloadId: 999 })).rejects.toThrow('Download not found');
    });
  });

  describe('startDownload', () => {
    it('should initiate a download and return downloadId', async () => {
      const result = await fileOps({ action: 'startDownload', url: 'https://example.com/file.pdf' });

      expect(result).toEqual({
        success: true,
        action: 'startDownload',
        data: { downloadId: 42 },
      });
      expect(adapter.startDownload).toHaveBeenCalledWith('https://example.com/file.pdf');
    });

    it('should throw when url is missing', async () => {
      await expect(fileOps({ action: 'startDownload' })).rejects.toThrow('url is required');
    });
  });

  describe('validation', () => {
    it('should throw on invalid params', async () => {
      await expect(fileOps(null)).rejects.toThrow('Invalid file-ops params');
    });

    it('should throw on unknown action', async () => {
      await expect(fileOps({ action: 'unknown' })).rejects.toThrow('Invalid file-ops params');
    });
  });
});
