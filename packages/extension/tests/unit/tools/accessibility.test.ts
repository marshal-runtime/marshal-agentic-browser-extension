import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createGetAccessibilityTreeHandler } from '../../../src/tools/accessibility.js';
import type { IBrowserAdapter, AccessibilityNode } from '@agentic-browser/shared';
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
    getAccessibilityTree: vi.fn().mockResolvedValue(
      ok({
        role: 'RootWebArea',
        name: 'Test Page',
        children: [
          {
            role: 'heading',
            name: 'Welcome',
            children: [],
          },
          {
            role: 'button',
            name: 'Submit',
            value: undefined,
            description: 'Submit the form',
          },
        ],
      } satisfies AccessibilityNode),
    ),
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

describe('createGetAccessibilityTreeHandler', () => {
  let adapter: IBrowserAdapter;
  let getA11yTree: ReturnType<typeof createGetAccessibilityTreeHandler>;

  beforeEach(() => {
    adapter = createMockAdapter();
    getA11yTree = createGetAccessibilityTreeHandler(adapter);
  });

  describe('full tree', () => {
    it('should return a YAML snapshot string', async () => {
      const result = await getA11yTree({});

      expect(result.snapshot).toBeDefined();
      expect(typeof result.snapshot).toBe('string');
      // Should contain the tree roles and names
      expect(result.snapshot).toContain('RootWebArea');
      expect(result.snapshot).toContain('Test Page');
    });

    it('should include child nodes in snapshot', async () => {
      const result = await getA11yTree({});

      expect(result.snapshot).toContain('heading');
      expect(result.snapshot).toContain('Welcome');
    });

    it('should handle deeply nested trees', async () => {
      adapter = createMockAdapter({
        getAccessibilityTree: vi.fn().mockResolvedValue(
          ok({
            role: 'RootWebArea',
            name: 'Page',
            children: [
              {
                role: 'navigation',
                name: 'Nav',
                children: [
                  { role: 'link', name: 'Home' },
                  { role: 'link', name: 'About' },
                ],
              },
              {
                role: 'main',
                name: 'Content',
                children: [
                  {
                    role: 'heading',
                    name: 'Title',
                    children: [],
                  },
                ],
              },
            ],
          } satisfies AccessibilityNode),
        ),
      });
      getA11yTree = createGetAccessibilityTreeHandler(adapter);

      const result = await getA11yTree({});

      expect(result.snapshot).toContain('navigation');
      expect(result.snapshot).toContain('link "Home"');
      expect(result.snapshot).toContain('link "About"');
      expect(result.snapshot).toContain('heading "Title"');
    });
  });

  describe('interactive elements', () => {
    it('should include button roles in the snapshot', async () => {
      const result = await getA11yTree({});

      expect(result.snapshot).toContain('button');
      expect(result.snapshot).toContain('Submit');
    });

    it('should assign ref markers to interactive elements', async () => {
      adapter = createMockAdapter({
        getAccessibilityTree: vi.fn().mockResolvedValue(
          ok({
            role: 'RootWebArea',
            name: 'Page',
            children: [
              { role: 'link', name: 'Home' },
              { role: 'button', name: 'Click Me' },
            ],
          } satisfies AccessibilityNode),
        ),
      });
      getA11yTree = createGetAccessibilityTreeHandler(adapter);

      const result = await getA11yTree({});

      expect(result.snapshot).toContain('[ref=e1]');
      expect(result.snapshot).toContain('[ref=e2]');
    });

    it('should include value when present', async () => {
      adapter = createMockAdapter({
        getAccessibilityTree: vi.fn().mockResolvedValue(
          ok({
            role: 'RootWebArea',
            name: 'Page',
            children: [
              { role: 'textbox', name: 'Username', value: 'john' },
            ],
          } satisfies AccessibilityNode),
        ),
      });
      getA11yTree = createGetAccessibilityTreeHandler(adapter);

      const result = await getA11yTree({});

      expect(result.snapshot).toContain('textbox');
      expect(result.snapshot).toContain('Username');
      expect(result.snapshot).toContain('john');
    });
  });

  describe('empty page', () => {
    it('should handle a page with no children', async () => {
      adapter = createMockAdapter({
        getAccessibilityTree: vi.fn().mockResolvedValue(
          ok({ role: 'RootWebArea', name: '' } satisfies AccessibilityNode),
        ),
      });
      getA11yTree = createGetAccessibilityTreeHandler(adapter);

      const result = await getA11yTree({});

      expect(result.snapshot).toBeDefined();
      expect(result.snapshot).toContain('RootWebArea');
    });
  });

  describe('error cases', () => {
    it('should throw when adapter returns an error', async () => {
      adapter = createMockAdapter({
        getAccessibilityTree: vi.fn().mockResolvedValue(
          err({ code: ErrorCode.CDP_ERROR, message: 'Debugger not attached' }),
        ),
      });
      getA11yTree = createGetAccessibilityTreeHandler(adapter);

      await expect(getA11yTree({})).rejects.toThrow('[CDP_ERROR]');
    });
  });
});


