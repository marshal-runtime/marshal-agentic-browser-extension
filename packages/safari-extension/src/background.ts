import { getSafariBrowserApi, type SafariNativePort } from './browser-api.js';
import {
  SAFARI_HANDSHAKE_MESSAGE,
  SAFARI_NATIVE_APPLICATION_ID,
  SAFARI_NATIVE_PORT_MESSAGE,
  type SafariHandshake,
  type SafariSecretTypeRequest,
  type SafariSecretTypeResponse,
  isSafariSecretTypeRequest,
} from './protocol.js';
import { matchesAllowedUrl } from './url-policy.js';

const api = getSafariBrowserApi();
const INSTANCE_STORAGE_KEY = 'marshal.safari.browserInstanceId';

async function getBrowserInstanceId(): Promise<string> {
  const stored = await api.storage.local.get([INSTANCE_STORAGE_KEY]);
  const existing = stored[INSTANCE_STORAGE_KEY];
  if (typeof existing === 'string' && existing.length > 0) return existing;
  const generated = crypto.randomUUID();
  await api.storage.local.set({ [INSTANCE_STORAGE_KEY]: generated });
  return generated;
}

async function connect(): Promise<void> {
  const browserInstanceId = await getBrowserInstanceId();
  let port: SafariNativePort;
  try {
    port = api.runtime.connectNative(SAFARI_NATIVE_APPLICATION_ID);
  } catch (error: unknown) {
    console.error('Marshal Safari native bridge unavailable', error);
    return;
  }

  const handshake: SafariHandshake = {
    kind: SAFARI_HANDSHAKE_MESSAGE,
    browserInstanceId,
    extensionId: api.runtime.id,
    browser: 'safari',
  };
  port.postMessage(handshake);

  port.onMessage.addListener((message: unknown) => {
    if (!isSafariSecretTypeRequest(message)) return;
    void handleSecretRequest(port, browserInstanceId, message);
  });
  port.onDisconnect.addListener(() => {
    // Safari may suspend the background page. Reconnect on the next wake-up.
    setTimeout(() => void connect(), 500);
  });
}

async function handleSecretRequest(
  port: SafariNativePort,
  browserInstanceId: string,
  request: SafariSecretTypeRequest,
): Promise<void> {
  const responseBase = {
    kind: SAFARI_NATIVE_PORT_MESSAGE,
    requestId: request.requestId,
    browserInstanceId,
  } as const;
  if (request.browserInstanceId !== browserInstanceId) {
    sendResponse(port, { ...responseBase, success: false, errorCode: 'SAFARI_INSTANCE_MISMATCH' });
    return;
  }

  const tabs = await api.tabs.query({ active: true, lastFocusedWindow: true });
  const activeTab = tabs[0];
  if (activeTab?.id === undefined || activeTab.url === undefined) {
    sendResponse(port, {
      ...responseBase,
      success: false,
      errorCode: 'SAFARI_ACTIVE_TAB_UNAVAILABLE',
    });
    return;
  }
  if (!matchesAllowedUrl(activeTab.url, request.allowedUrlPatterns)) {
    sendResponse(port, { ...responseBase, success: false, errorCode: 'KEYVAULT_URL_DENIED' });
    return;
  }

  try {
    const result = await api.tabs.sendMessage(activeTab.id, {
      type: 'marshal.keyvault.content.typeSecret',
      selector: request.selector,
      fieldKind: request.fieldKind,
      text: request.text,
      allowedUrlPatterns: request.allowedUrlPatterns,
      clearFirst: request.clearFirst,
    });
    const contentResult = result as { success?: unknown; errorCode?: unknown };
    sendResponse(port, {
      ...responseBase,
      success: contentResult.success === true,
      ...(typeof contentResult.errorCode === 'string'
        ? { errorCode: contentResult.errorCode }
        : {}),
    });
  } catch {
    sendResponse(port, {
      ...responseBase,
      success: false,
      errorCode: 'SAFARI_CONTENT_SCRIPT_UNAVAILABLE',
    });
  }
}

function sendResponse(port: SafariNativePort, response: SafariSecretTypeResponse): void {
  // Deliberately never include request.text or any DOM value in this response.
  port.postMessage(response);
}

void connect();
