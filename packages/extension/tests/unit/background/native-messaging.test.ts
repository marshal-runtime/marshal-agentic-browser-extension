import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NativeMessaging } from '../../../src/background/native-messaging.js';

const connectNative = vi.fn();

vi.stubGlobal('chrome', {
  runtime: {
    connectNative,
    lastError: undefined,
  },
});

function createPort() {
  return {
    disconnect: vi.fn(),
    postMessage: vi.fn(),
    onMessage: { addListener: vi.fn() },
    onDisconnect: { addListener: vi.fn() },
  };
}

describe('NativeMessaging host selection', () => {
  beforeEach(() => {
    connectNative.mockReset();
    connectNative.mockReturnValue(createPort());
  });

  it('uses the setup-registered host ID by default', () => {
    const messaging = new NativeMessaging();

    messaging.connect();

    expect(connectNative).toHaveBeenCalledWith('com.agentic_browser.mcp_host');
    messaging.disconnect();
  });

  it('retains an explicit constructor override', () => {
    const messaging = new NativeMessaging('com.example.custom_host');

    messaging.connect();

    expect(connectNative).toHaveBeenCalledWith('com.example.custom_host');
    messaging.disconnect();
  });
});
