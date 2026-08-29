import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHandleDialogHandler, createGetDialogInfoHandler } from '../../../src/tools/dialog.js';
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
    handleDialog: vi.fn().mockResolvedValue(ok(undefined)),
    getDialogInfo: vi.fn().mockResolvedValue(ok({ type: 'alert', message: 'Hello' })),
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

describe('Dialog handlers', () => {
  let adapter: IBrowserAdapter;

  beforeEach(() => {
    adapter = createMockAdapter();
  });

  describe('createHandleDialogHandler', () => {
    describe('accept alert', () => {
      it('should accept an alert dialog', async () => {
        const handleDialog = createHandleDialogHandler(adapter);

        const result = await handleDialog({ action: 'accept' });

        expect(result).toEqual({
          dialogType: 'alert',
          message: 'Hello',
          defaultPrompt: undefined,
          handled: true,
        });
        expect(adapter.handleDialog).toHaveBeenCalledWith({ accept: true, promptText: undefined });
      });
    });

    describe('dismiss confirm', () => {
      it('should dismiss a confirm dialog', async () => {
        adapter = createMockAdapter({
          getDialogInfo: vi.fn().mockResolvedValue(ok({ type: 'confirm', message: 'Are you sure?' })),
          handleDialog: vi.fn().mockResolvedValue(ok(undefined)),
        });
        const handleDialog = createHandleDialogHandler(adapter);

        const result = await handleDialog({ action: 'dismiss' });

        expect(result).toEqual({
          dialogType: 'confirm',
          message: 'Are you sure?',
          defaultPrompt: undefined,
          handled: true,
        });
        expect(adapter.handleDialog).toHaveBeenCalledWith({ accept: false, promptText: undefined });
      });
    });

    describe('prompt with text', () => {
      it('should accept a prompt with text input', async () => {
        adapter = createMockAdapter({
          getDialogInfo: vi.fn().mockResolvedValue(ok({ type: 'prompt', message: 'Enter name', defaultPrompt: 'default' })),
          handleDialog: vi.fn().mockResolvedValue(ok(undefined)),
        });
        const handleDialog = createHandleDialogHandler(adapter);

        const result = await handleDialog({ action: 'accept', promptText: 'John' });

        expect(result).toEqual({
          dialogType: 'prompt',
          message: 'Enter name',
          defaultPrompt: 'default',
          handled: true,
        });
        expect(adapter.handleDialog).toHaveBeenCalledWith({ accept: true, promptText: 'John' });
      });
    });

    describe('error cases', () => {
      it('should throw when no dialog is open (getDialogInfo fails)', async () => {
        adapter = createMockAdapter({
          getDialogInfo: vi.fn().mockResolvedValue(err({ code: ErrorCode.DIALOG_NOT_FOUND, message: 'No dialog' })),
        });
        const handleDialog = createHandleDialogHandler(adapter);

        await expect(handleDialog({ action: 'accept' })).rejects.toThrow('[DIALOG_NOT_FOUND]');
      });

      it('should throw when handleDialog fails', async () => {
        adapter = createMockAdapter({
          handleDialog: vi.fn().mockResolvedValue(err({ code: ErrorCode.UNKNOWN, message: 'Handle failed' })),
        });
        const handleDialog = createHandleDialogHandler(adapter);

        await expect(handleDialog({ action: 'accept' })).rejects.toThrow('[UNKNOWN] Handle failed');
      });

      it('should throw on invalid params', async () => {
        const handleDialog = createHandleDialogHandler(adapter);

        await expect(handleDialog({ action: 'cancel' })).rejects.toThrow('Invalid handleDialog params');
      });

      it('should throw on missing action', async () => {
        const handleDialog = createHandleDialogHandler(adapter);

        await expect(handleDialog({})).rejects.toThrow('Invalid handleDialog params');
      });
    });

    describe('edge cases', () => {
      it('should default to alert type when dialog info has no type', async () => {
        adapter = createMockAdapter({
          getDialogInfo: vi.fn().mockResolvedValue(ok(null)),
          handleDialog: vi.fn().mockResolvedValue(ok(undefined)),
        });
        const handleDialog = createHandleDialogHandler(adapter);

        const result = await handleDialog({ action: 'accept' });

        expect(result.dialogType).toBe('alert');
        expect(result.message).toBe('');
      });
    });
  });

  describe('createGetDialogInfoHandler', () => {
    it('should return dialog info when dialog is open', async () => {
      adapter = createMockAdapter({
        getDialogInfo: vi.fn().mockResolvedValue(ok({ type: 'confirm', message: 'Confirm?', defaultPrompt: undefined })),
      });
      const getDialogInfo = createGetDialogInfoHandler(adapter);

      const result = await getDialogInfo({});

      expect(result).toEqual({
        dialogType: 'confirm',
        message: 'Confirm?',
        defaultPrompt: undefined,
        handled: false,
      });
    });

    it('should return empty info when no dialog is open', async () => {
      adapter = createMockAdapter({
        getDialogInfo: vi.fn().mockResolvedValue(ok(null)),
      });
      const getDialogInfo = createGetDialogInfoHandler(adapter);

      const result = await getDialogInfo({});

      expect(result).toEqual({
        dialogType: 'alert',
        message: '',
        handled: false,
      });
    });

    it('should throw on adapter error', async () => {
      adapter = createMockAdapter({
        getDialogInfo: vi.fn().mockResolvedValue(err({ code: ErrorCode.UNKNOWN, message: 'Error' })),
      });
      const getDialogInfo = createGetDialogInfoHandler(adapter);

      await expect(getDialogInfo({})).rejects.toThrow('[UNKNOWN] Error');
    });

    it('should include defaultPrompt for prompt dialogs', async () => {
      adapter = createMockAdapter({
        getDialogInfo: vi.fn().mockResolvedValue(ok({ type: 'prompt', message: 'Enter', defaultPrompt: 'default value' })),
      });
      const getDialogInfo = createGetDialogInfoHandler(adapter);

      const result = await getDialogInfo({});

      expect(result.defaultPrompt).toBe('default value');
    });
  });
});
