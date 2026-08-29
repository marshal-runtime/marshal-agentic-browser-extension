/**
 * Extension service worker — background entry point (MV3).
 *
 * Initializes all Phase 1 subsystems in order and wires message
 * listeners for Native Messaging and content script communication.
 */

import { Logger } from '../infrastructure/logger.js';
import { StateManager } from '../infrastructure/state-manager.js';
import { TabTracker } from '../infrastructure/tab-tracker.js';
import { CDPManager } from '../infrastructure/cdp-manager.js';
import { getSessionManager } from '../infrastructure/session-manager.js';
import { Lifecycle } from './lifecycle.js';
import { NativeMessaging } from './native-messaging.js';
import { CommandRouter } from './command-router.js';
import {
  createConfiguredAdapter,
  readBrowserBackendConfiguration,
} from '../adapters/adapter-factory.js';
import { isRuntimePanelChannelMessage } from '@marshal/runtime-browser-panel';
import { registerTools } from '../tools/index.js';
import { RuntimePanelBackgroundBridge } from './runtime-panel-bridge.js';
import { BrowserSessionContextScope } from './browser-session-scope.js';

const logger = Logger.getInstance();

async function bootstrap(): Promise<void> {
  const lifecycle = new Lifecycle();
  await lifecycle.init();

  const stateManager = StateManager.getInstance();
  await stateManager.restore();

  const tabTracker = new TabTracker();
  await tabTracker.init();

  const cdpManager = new CDPManager();

  const backendConfiguration = await readBrowserBackendConfiguration(chrome.storage);
  const adapter = await createConfiguredAdapter(
    tabTracker,
    cdpManager,
    Logger.getInstance(),
    backendConfiguration,
  );
  const connection = await adapter.connect();
  if (!connection.ok) {
    logger.error('Browser adapter connection failed', {
      code: connection.error.code,
      message: connection.error.message,
    });
  }

  const browserSessions = new BrowserSessionContextScope(adapter);
  const commandRouter = new CommandRouter(browserSessions);
  registerTools(commandRouter, adapter);
  commandRouter.init();

  const sessionManager = getSessionManager();
  sessionManager.registerUpdateListener();

  const runtimePanel = new RuntimePanelBackgroundBridge(
    commandRouter,
    tabTracker,
    sessionManager,
    logger,
    async (message) => {
      try {
        await chrome.runtime.sendMessage(message);
      } catch (error: unknown) {
        const detail = error instanceof Error ? error.message : String(error);
        if (detail.includes('Receiving end does not exist')) {
          logger.debug('Runtime panel is not currently open');
          return;
        }
        throw error;
      }
    },
    (browserSessionId) => browserSessions.release(browserSessionId),
  );
  await runtimePanel.init();

  const nativeMessaging = new NativeMessaging();
  nativeMessaging.onMessage((message) => {
    if (isRuntimePanelChannelMessage(message)) {
      void runtimePanel.handleMessage(message).then((response) => {
        if (response) {
          nativeMessaging.sendMessage(response);
        }
      });
      return;
    }
    void commandRouter.route(message).then((response) => {
      nativeMessaging.sendMessage(response);
    });
  });
  nativeMessaging.onStateChange((connected) => {
    void chrome.storage.local.set({ connected });
  });
  nativeMessaging.connect();

  chrome.runtime.onMessage.addListener(
    (
      message: unknown,
      _sender: chrome.runtime.MessageSender,
      sendResponse: (response?: unknown) => void,
    ): boolean => {
      if (isRuntimePanelChannelMessage(message)) {
        void runtimePanel.handleMessage(message).then((response) => {
          sendResponse(response);
        });
        return true;
      }

      if (isMcpToggleMessage(message)) {
        if (message.enabled) {
          nativeMessaging.connect();
        } else {
          nativeMessaging.disconnect();
        }
        void chrome.storage.local.set({
          mcpEnabled: message.enabled,
          connected: nativeMessaging.isConnected(),
        });
        sendResponse({ success: true });
        return false;
      }

      void commandRouter.route(message).then((response) => {
        sendResponse(response);
      });
      return true;
    },
  );

  logger.info('Service worker bootstrap complete');
}

function isMcpToggleMessage(
  message: unknown,
): message is { readonly type: 'mcp-toggle'; readonly enabled: boolean } {
  return (
    typeof message === 'object' &&
    message !== null &&
    'type' in message &&
    message.type === 'mcp-toggle' &&
    'enabled' in message &&
    typeof message.enabled === 'boolean'
  );
}

void bootstrap().catch((error: unknown) => {
  logger.error('Service worker bootstrap failed', {
    error: error instanceof Error ? error.message : String(error),
  });
});
