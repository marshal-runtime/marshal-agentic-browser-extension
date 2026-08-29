import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createEmulationHandler, DEVICE_PRESETS } from '../../../src/tools/emulation.js';
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
    executeScript: vi.fn(),
    evaluateExpression: vi.fn(),
    executeConsoleCommand: vi.fn(),
    executeScriptFile: vi.fn(),
    executeValidation: vi.fn(),
    injectScript: vi.fn(),
    removeScript: vi.fn(),
    sendCdpCommand: vi.fn().mockResolvedValue(ok({})),
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
    listBookmarks: vi.fn(),
    createBookmark: vi.fn(),
    searchBookmarks: vi.fn(),
    searchHistory: vi.fn(),
    getHistoryEntries: vi.fn(),
    getDownloadItems: vi.fn(),
    monitorDownloads: vi.fn(),
    ...overrides,
  } as IBrowserAdapter;
}

describe('Emulation handler', () => {
  let adapter: IBrowserAdapter;
  let handler: ReturnType<typeof createEmulationHandler>;

  beforeEach(() => {
    adapter = createMockAdapter();
    handler = createEmulationHandler(adapter);
  });

  describe('emulate with preset', () => {
    it('should apply iPhone 14 preset', async () => {
      const result = await handler({ action: 'emulate', preset: 'iPhone 14' });

      expect(result).toEqual({
        enabled: true,
        width: 390,
        height: 844,
        deviceScaleFactor: 3,
        mobile: true,
        userAgent: DEVICE_PRESETS['iPhone 14'].userAgent,
        orientation: 'portrait',
        touchEnabled: true,
      });

      expect(adapter.sendCdpCommand).toHaveBeenCalledWith({
        method: 'Emulation.setDeviceMetricsOverride',
        params: {
          width: 390,
          height: 844,
          deviceScaleFactor: 3,
          mobile: true,
          screenOrientation: { angle: 0, type: 'portraitPrimary' },
        },
      });

      expect(adapter.sendCdpCommand).toHaveBeenCalledWith({
        method: 'Emulation.setTouchEmulationEnabled',
        params: { enabled: true },
      });

      expect(adapter.sendCdpCommand).toHaveBeenCalledWith({
        method: 'Emulation.setUserAgentOverride',
        params: { userAgent: DEVICE_PRESETS['iPhone 14'].userAgent },
      });
    });

    it('should apply Pixel 7 preset', async () => {
      const result = await handler({ action: 'emulate', preset: 'Pixel 7' });

      expect(result).toEqual({
        enabled: true,
        width: 412,
        height: 915,
        deviceScaleFactor: 2.625,
        mobile: true,
        userAgent: DEVICE_PRESETS['Pixel 7'].userAgent,
        orientation: 'portrait',
        touchEnabled: true,
      });
    });

    it('should apply iPad Pro preset', async () => {
      const result = await handler({ action: 'emulate', preset: 'iPad Pro' });

      expect(result).toEqual({
        enabled: true,
        width: 1024,
        height: 1366,
        deviceScaleFactor: 2,
        mobile: true,
        userAgent: DEVICE_PRESETS['iPad Pro'].userAgent,
        orientation: 'portrait',
        touchEnabled: true,
      });
    });
  });

  describe('emulate with custom config', () => {
    it('should apply custom dimensions', async () => {
      const result = await handler({
        action: 'emulate',
        width: 320,
        height: 568,
        deviceScaleFactor: 2,
        mobile: true,
      });

      expect(result).toEqual({
        enabled: true,
        width: 320,
        height: 568,
        deviceScaleFactor: 2,
        mobile: true,
        userAgent: undefined,
        orientation: 'portrait',
        touchEnabled: true,
      });

      expect(adapter.sendCdpCommand).toHaveBeenCalledWith({
        method: 'Emulation.setDeviceMetricsOverride',
        params: {
          width: 320,
          height: 568,
          deviceScaleFactor: 2,
          mobile: true,
          screenOrientation: { angle: 0, type: 'portraitPrimary' },
        },
      });
    });

    it('should handle landscape orientation', async () => {
      const result = await handler({
        action: 'emulate',
        preset: 'iPhone 14',
        orientation: 'landscape',
      });

      expect(result).toEqual(expect.objectContaining({
        enabled: true,
        width: 844,
        height: 390,
        orientation: 'landscape',
      }));

      expect(adapter.sendCdpCommand).toHaveBeenCalledWith({
        method: 'Emulation.setDeviceMetricsOverride',
        params: expect.objectContaining({
          width: 844,
          height: 390,
          screenOrientation: { angle: 90, type: 'landscapePrimary' },
        }),
      });
    });

    it('should allow overriding preset values', async () => {
      const result = await handler({
        action: 'emulate',
        preset: 'iPhone 14',
        width: 400,
        userAgent: 'Custom/1.0',
      });

      expect(result).toEqual(expect.objectContaining({
        width: 400,
        height: 844,
        userAgent: 'Custom/1.0',
      }));
    });

    it('should disable touch when specified', async () => {
      const result = await handler({
        action: 'emulate',
        preset: 'iPhone 14',
        touchEnabled: false,
      });

      expect(result).toEqual(expect.objectContaining({
        touchEnabled: false,
      }));

      expect(adapter.sendCdpCommand).toHaveBeenCalledWith({
        method: 'Emulation.setTouchEmulationEnabled',
        params: { enabled: false },
      });
    });
  });

  describe('reset emulation', () => {
    it('should clear device metrics and disable touch', async () => {
      const result = await handler({ action: 'reset' });

      expect(result).toEqual({
        enabled: false,
        width: 0,
        height: 0,
        deviceScaleFactor: 1,
        mobile: false,
        orientation: 'portrait',
        touchEnabled: false,
      });

      expect(adapter.sendCdpCommand).toHaveBeenCalledWith({
        method: 'Emulation.clearDeviceMetricsOverride',
      });

      expect(adapter.sendCdpCommand).toHaveBeenCalledWith({
        method: 'Emulation.setTouchEmulationEnabled',
        params: { enabled: false },
      });
    });
  });

  describe('toggle between desktop and mobile', () => {
    it('should toggle from emulation to desktop and back', async () => {
      const emulateResult = await handler({ action: 'emulate', preset: 'iPhone 14' });
      expect(emulateResult).toEqual(expect.objectContaining({ enabled: true, mobile: true }));

      const resetResult = await handler({ action: 'reset' });
      expect(resetResult).toEqual(expect.objectContaining({ enabled: false, mobile: false }));

      const reEmulateResult = await handler({ action: 'emulate', preset: 'Pixel 7' });
      expect(reEmulateResult).toEqual(expect.objectContaining({ enabled: true, mobile: true, width: 412 }));
    });
  });

  describe('device presets', () => {
    it('should have all required presets', () => {
      expect(DEVICE_PRESETS['iPhone 14']).toBeDefined();
      expect(DEVICE_PRESETS['iPhone 14 Pro Max']).toBeDefined();
      expect(DEVICE_PRESETS['Pixel 7']).toBeDefined();
      expect(DEVICE_PRESETS['iPad Pro']).toBeDefined();
      expect(DEVICE_PRESETS['Galaxy S23']).toBeDefined();
    });

    it('should have valid dimensions for all presets', () => {
      for (const [name, preset] of Object.entries(DEVICE_PRESETS)) {
        expect(preset.width).toBeGreaterThan(0);
        expect(preset.height).toBeGreaterThan(0);
        expect(preset.deviceScaleFactor).toBeGreaterThan(0);
        expect(preset.mobile).toBe(true);
        expect(preset.userAgent).toBeTruthy();
        expect(preset.name).toBe(name);
      }
    });
  });
});
