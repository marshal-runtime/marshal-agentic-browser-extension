import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createUndoHTMLHandler } from '../../../src/tools/modify-html.js';
import { createUndoCSSHandler } from '../../../src/tools/modify-css.js';
import type { IBrowserAdapter } from '@agentic-browser/shared';
import { ok } from '@agentic-browser/shared';

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
    executeScript: vi.fn().mockResolvedValue(ok({ undone: true, action: 'modifyText', selector: '#title' })),
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

describe('createUndoHTMLHandler', () => {
  let adapter: IBrowserAdapter;
  let undoHTML: ReturnType<typeof createUndoHTMLHandler>;

  beforeEach(() => {
    adapter = createMockAdapter();
    undoHTML = createUndoHTMLHandler(adapter);
  });

  it('should undo last HTML modification', async () => {
    const result = await undoHTML({ action: 'undoLastHTML' });

    expect(result).toEqual({
      action: 'undoLastHTML',
      success: true,
      data: { undone: true, action: 'modifyText', selector: '#title' },
    });
    expect(adapter.executeScript).toHaveBeenCalledWith({
      script: expect.stringContaining('__agenticUndoLastModification'),
    });
  });

  it('should revert all HTML modifications', async () => {
    (adapter.executeScript as ReturnType<typeof vi.fn>).mockResolvedValue(
      ok({ reverted: 3 }),
    );

    const result = await undoHTML({ action: 'revertAllHTML' });

    expect(result).toEqual({
      action: 'revertAllHTML',
      success: true,
      data: { reverted: 3 },
    });
    expect(adapter.executeScript).toHaveBeenCalledWith({
      script: expect.stringContaining('__agenticRevertAllModifications'),
    });
  });

  it('should reject invalid params', async () => {
    await expect(undoHTML({ action: 'invalid' })).rejects.toThrow('Invalid undo/revert params');
  });

  it('should throw on unsupported action', async () => {
    await expect(undoHTML({ action: 'undoLastCSS' })).rejects.toThrow('Unsupported HTML undo/revert action');
  });
});

describe('createUndoCSSHandler', () => {
  let adapter: IBrowserAdapter;
  let undoCSS: ReturnType<typeof createUndoCSSHandler>;

  beforeEach(() => {
    adapter = createMockAdapter();
    undoCSS = createUndoCSSHandler(adapter);
  });

  it('should undo last CSS modification', async () => {
    const result = await undoCSS({ action: 'undoLastCSS' });

    expect(result).toEqual({
      action: 'undoLastCSS',
      success: true,
      data: { undone: true, action: 'modifyText', selector: '#title' },
    });
    expect(adapter.executeScript).toHaveBeenCalledWith({
      script: expect.stringContaining('__agenticUndoLastModification'),
    });
  });

  it('should revert all CSS modifications', async () => {
    (adapter.executeScript as ReturnType<typeof vi.fn>).mockResolvedValue(
      ok({ reverted: 5 }),
    );

    const result = await undoCSS({ action: 'revertAllCSS' });

    expect(result).toEqual({
      action: 'revertAllCSS',
      success: true,
      data: { reverted: 5 },
    });
    expect(adapter.executeScript).toHaveBeenCalledWith({
      script: expect.stringContaining('__agenticRevertAllModifications'),
    });
  });

  it('should reject invalid params', async () => {
    await expect(undoCSS({ action: 'invalid' })).rejects.toThrow('Invalid undo/revert params');
  });

  it('should throw on unsupported action', async () => {
    await expect(undoCSS({ action: 'undoLastHTML' })).rejects.toThrow('Unsupported CSS undo/revert action');
  });
});
