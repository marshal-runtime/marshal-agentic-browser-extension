/**
 * Device emulation tool handler (FR-041, FR-042).
 *
 * Provides mobile device emulation via CDP Emulation domain and
 * touch interactions via CDP Input.dispatchTouchEvent.
 */

import type {
  IBrowserAdapter,
  DevicePreset,
  DevicePresetName,
  EmulationResult,
  ScreenOrientation,
} from '@agentic-browser/shared';
import { ok, err, ErrorCode } from '@agentic-browser/shared';

/** Built-in device presets for common mobile devices. */
const DEVICE_PRESETS: Record<DevicePresetName, DevicePreset> = {
  'iPhone 14': {
    name: 'iPhone 14',
    width: 390,
    height: 844,
    deviceScaleFactor: 3,
    mobile: true,
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1',
  },
  'iPhone 14 Pro Max': {
    name: 'iPhone 14 Pro Max',
    width: 430,
    height: 932,
    deviceScaleFactor: 3,
    mobile: true,
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1',
  },
  'Pixel 7': {
    name: 'Pixel 7',
    width: 412,
    height: 915,
    deviceScaleFactor: 2.625,
    mobile: true,
    userAgent:
      'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Mobile Safari/537.36',
  },
  'iPad Pro': {
    name: 'iPad Pro',
    width: 1024,
    height: 1366,
    deviceScaleFactor: 2,
    mobile: true,
    userAgent:
      'Mozilla/5.0 (iPad; CPU OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1',
  },
  'Galaxy S23': {
    name: 'Galaxy S23',
    width: 360,
    height: 780,
    deviceScaleFactor: 3,
    mobile: true,
    userAgent:
      'Mozilla/5.0 (Linux; Android 13; SM-S911B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Mobile Safari/537.36',
  },
};

/** Parameters for the emulation handler. */
interface EmulationHandlerParams {
  readonly action: 'emulate' | 'reset';
  readonly preset?: DevicePresetName;
  readonly width?: number;
  readonly height?: number;
  readonly deviceScaleFactor?: number;
  readonly mobile?: boolean;
  readonly userAgent?: string;
  readonly orientation?: ScreenOrientation;
  readonly touchEnabled?: boolean;
}

/**
 * Creates the emulateDevice handler.
 *
 * @param adapter - The browser adapter to delegate CDP commands to.
 * @returns Handler function for emulation parameters.
 */
export function createEmulationHandler(
  adapter: IBrowserAdapter,
): (params: EmulationHandlerParams) => Promise<unknown> {
  return async (params: EmulationHandlerParams): Promise<unknown> => {
    if (params.action === 'reset') {
      return resetEmulation(adapter);
    }

    return applyEmulation(adapter, params);
  };
}

async function applyEmulation(
  adapter: IBrowserAdapter,
  params: EmulationHandlerParams,
): Promise<EmulationResult> {
  let width = params.width ?? 390;
  let height = params.height ?? 844;
  let deviceScaleFactor = params.deviceScaleFactor ?? 3;
  let mobile = params.mobile ?? true;
  let userAgent = params.userAgent;
  const orientation: ScreenOrientation = params.orientation ?? 'portrait';
  const touchEnabled = params.touchEnabled ?? true;

  if (params.preset) {
    const preset = DEVICE_PRESETS[params.preset];
    if (!preset) {
      throw new Error(`Unknown device preset: ${params.preset}`);
    }
    width = params.width ?? preset.width;
    height = params.height ?? preset.height;
    deviceScaleFactor = params.deviceScaleFactor ?? preset.deviceScaleFactor;
    mobile = params.mobile ?? preset.mobile;
    userAgent = params.userAgent ?? preset.userAgent;
  }

  const effectiveWidth = orientation === 'landscape' ? Math.max(width, height) : Math.min(width, height);
  const effectiveHeight = orientation === 'landscape' ? Math.min(width, height) : Math.max(width, height);

  const screenOrientation = {
    angle: orientation === 'landscape' ? 90 : 0,
    type: orientation === 'landscape' ? 'landscapePrimary' : 'portraitPrimary',
  };

  await adapter.sendCdpCommand({
    method: 'Emulation.setDeviceMetricsOverride',
    params: {
      width: effectiveWidth,
      height: effectiveHeight,
      deviceScaleFactor,
      mobile,
      screenOrientation,
    },
  });

  await adapter.sendCdpCommand({
    method: 'Emulation.setTouchEmulationEnabled',
    params: { enabled: touchEnabled },
  });

  if (userAgent) {
    await adapter.sendCdpCommand({
      method: 'Emulation.setUserAgentOverride',
      params: { userAgent },
    });
  }

  return {
    enabled: true,
    width: effectiveWidth,
    height: effectiveHeight,
    deviceScaleFactor,
    mobile,
    userAgent,
    orientation,
    touchEnabled,
  };
}

async function resetEmulation(adapter: IBrowserAdapter): Promise<EmulationResult> {
  await adapter.sendCdpCommand({
    method: 'Emulation.clearDeviceMetricsOverride',
  });

  await adapter.sendCdpCommand({
    method: 'Emulation.setTouchEmulationEnabled',
    params: { enabled: false },
  });

  return {
    enabled: false,
    width: 0,
    height: 0,
    deviceScaleFactor: 1,
    mobile: false,
    orientation: 'portrait',
    touchEnabled: false,
  };
}

export { DEVICE_PRESETS };
