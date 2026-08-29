/**
 * Storage management tool handler.
 *
 * Validates incoming parameters via {@link StorageParamsSchema},
 * delegates cookie operations to the chrome.cookies API via the
 * adapter, and localStorage/sessionStorage operations via
 * chrome.scripting.executeScript.
 */

import type { IBrowserAdapter } from '@agentic-browser/shared';
import { StorageParamsSchema, ErrorCode } from '@agentic-browser/shared';

/** Response shape returned by the storage handler. */
interface StorageResult {
  readonly success: boolean;
  readonly action: string;
  readonly data?: unknown;
  readonly message?: string;
}

/**
 * Creates a storage management handler bound to the given browser adapter.
 *
 * The returned function validates raw params with Zod and dispatches
 * to the appropriate storage operation based on the action.
 */
export function createStorageHandler(adapter: IBrowserAdapter) {
  return async (params: unknown): Promise<StorageResult> => {
    const parsed = StorageParamsSchema.safeParse(params);

    if (!parsed.success) {
      throw new Error(
        `Invalid storage params: ${parsed.error.issues.map((i: { message: string }) => i.message).join(', ')}`,
      );
    }

    const { action } = parsed.data;

    switch (action) {
      case 'getCookies':
        return getCookies(adapter, parsed.data);
      case 'setCookie':
        return setCookie(adapter, parsed.data);
      case 'deleteCookie':
        return deleteCookie(adapter, parsed.data);
      case 'getLocalStorage':
        return getWebStorage(adapter, 'local', parsed.data);
      case 'setLocalStorage':
        return setWebStorage(adapter, 'local', parsed.data);
      case 'getSessionStorage':
        return getWebStorage(adapter, 'session', parsed.data);
      case 'setSessionStorage':
        return setWebStorage(adapter, 'session', parsed.data);
      case 'clearStorage':
        return clearStorage(adapter);
      default:
        throw new Error(`Unknown storage action: ${action as string}`);
    }
  };
}

async function getCookies(
  adapter: IBrowserAdapter,
  data: { domain?: string; url?: string },
): Promise<StorageResult> {
  const result = await adapter.getCookies({
    domain: data.domain,
    url: data.url,
  });

  if (!result.ok) {
    throw new Error(`[${result.error.code}] ${result.error.message}`);
  }

  return {
    success: true,
    action: 'getCookies',
    data: result.value,
  };
}

async function setCookie(
  adapter: IBrowserAdapter,
  data: {
    cookie?: {
      name: string;
      value: string;
      domain?: string;
      path?: string;
      secure?: boolean;
      httpOnly?: boolean;
      sameSite?: 'strict' | 'lax' | 'none';
      expirationDate?: number;
      url?: string;
    };
  },
): Promise<StorageResult> {
  if (!data.cookie) {
    throw new Error('cookie details are required for setCookie action');
  }

  const result = await adapter.setCookie({
    name: data.cookie.name,
    value: data.cookie.value,
    domain: data.cookie.domain,
    path: data.cookie.path,
    secure: data.cookie.secure,
    httpOnly: data.cookie.httpOnly,
    sameSite: data.cookie.sameSite,
    expirationDate: data.cookie.expirationDate,
  });

  if (!result.ok) {
    throw new Error(`[${result.error.code}] ${result.error.message}`);
  }

  return {
    success: true,
    action: 'setCookie',
    message: `Cookie "${data.cookie.name}" set`,
  };
}

async function deleteCookie(
  adapter: IBrowserAdapter,
  data: { url?: string; cookieName?: string; domain?: string },
): Promise<StorageResult> {
  if (!data.cookieName) {
    throw new Error('cookieName is required for deleteCookie action');
  }

  const url = data.url ?? `https://${data.domain ?? 'localhost'}/`;

  const adapterAny = adapter as IBrowserAdapter & {
    deleteCookie(url: string, name: string): Promise<{ ok: boolean; error?: { code: string; message: string } }>;
  };

  if (typeof adapterAny.deleteCookie !== 'function') {
    throw new Error('Adapter does not support deleteCookie');
  }

  const result = await adapterAny.deleteCookie(url, data.cookieName);

  if (!result.ok) {
    throw new Error(`[${result.error?.code}] ${result.error?.message}`);
  }

  return {
    success: true,
    action: 'deleteCookie',
    message: `Cookie "${data.cookieName}" deleted`,
  };
}

async function getWebStorage(
  adapter: IBrowserAdapter,
  storageType: 'local' | 'session',
  data: { key?: string },
): Promise<StorageResult> {
  if (!data.key) {
    throw new Error('key is required for get storage action');
  }

  const tabId = await resolveTabId(adapter);

  const adapterAny = adapter as IBrowserAdapter & {
    getStorage(
      tabId: number,
      type: 'local' | 'session',
      key: string,
    ): Promise<{ ok: boolean; value?: { key: string; value: string | null }; error?: { code: string; message: string } }>;
  };

  if (typeof adapterAny.getStorage !== 'function') {
    throw new Error('Adapter does not support getStorage');
  }

  const result = await adapterAny.getStorage(tabId, storageType, data.key);

  if (!result.ok) {
    throw new Error(`[${result.error?.code}] ${result.error?.message}`);
  }

  return {
    success: true,
    action: storageType === 'session' ? 'getSessionStorage' : 'getLocalStorage',
    data: result.value,
  };
}

async function setWebStorage(
  adapter: IBrowserAdapter,
  storageType: 'local' | 'session',
  data: { key?: string; value?: string },
): Promise<StorageResult> {
  if (!data.key) {
    throw new Error('key is required for set storage action');
  }
  if (data.value === undefined) {
    throw new Error('value is required for set storage action');
  }

  const tabId = await resolveTabId(adapter);

  const adapterAny = adapter as IBrowserAdapter & {
    setStorage(
      tabId: number,
      type: 'local' | 'session',
      key: string,
      value: string,
    ): Promise<{ ok: boolean; error?: { code: string; message: string } }>;
  };

  if (typeof adapterAny.setStorage !== 'function') {
    throw new Error('Adapter does not support setStorage');
  }

  const result = await adapterAny.setStorage(tabId, storageType, data.key, data.value);

  if (!result.ok) {
    throw new Error(`[${result.error?.code}] ${result.error?.message}`);
  }

  return {
    success: true,
    action: storageType === 'session' ? 'setSessionStorage' : 'setLocalStorage',
    message: `${storageType}Storage key "${data.key}" set`,
  };
}

async function clearStorage(adapter: IBrowserAdapter): Promise<StorageResult> {
  const tabId = await resolveTabId(adapter);

  const adapterAny = adapter as IBrowserAdapter & {
    clearStorage(tabId: number): Promise<{ ok: boolean; error?: { code: string; message: string } }>;
  };

  if (typeof adapterAny.clearStorage !== 'function') {
    throw new Error('Adapter does not support clearStorage');
  }

  const result = await adapterAny.clearStorage(tabId);

  if (!result.ok) {
    throw new Error(`[${result.error?.code}] ${result.error?.message}`);
  }

  return {
    success: true,
    action: 'clearStorage',
    message: 'All storage cleared',
  };
}

async function resolveTabId(adapter: IBrowserAdapter): Promise<number> {
  const tabResult = await adapter.getActiveTab();
  if (!tabResult.ok) {
    throw new Error(`[${ErrorCode.TAB_NOT_FOUND}] No active tab found`);
  }
  return tabResult.value.tabId;
}

export type { StorageResult };
