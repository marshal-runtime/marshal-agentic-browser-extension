import { getSafariBrowserApi } from './browser-api.js';
import { matchesAllowedUrl } from './url-policy.js';
import type { SafariContentSecretRequest, SafariContentSecretResponse } from './protocol.js';

const api = getSafariBrowserApi();

api.runtime.onMessage.addListener(
  (message: unknown, _sender: unknown, sendResponse: (response: unknown) => void): boolean => {
    if (!isSecretRequest(message)) return false;
    sendResponse(typeSecret(message));
    return false;
  },
);

function typeSecret(request: SafariContentSecretRequest): SafariContentSecretResponse {
  if (!matchesAllowedUrl(globalThis.location.href, request.allowedUrlPatterns)) {
    return { success: false, errorCode: 'KEYVAULT_URL_CHANGED' };
  }
  const element = document.querySelector(request.selector);
  if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) {
    return { success: false, errorCode: 'KEYVAULT_FIELD_NOT_INPUT' };
  }
  if (!isVisible(element)) return { success: false, errorCode: 'KEYVAULT_FIELD_NOT_VISIBLE' };
  if (
    request.fieldKind === 'password' &&
    (!(element instanceof HTMLInputElement) || element.type.toLowerCase() !== 'password')
  ) {
    return { success: false, errorCode: 'KEYVAULT_PASSWORD_FIELD_REQUIRED' };
  }
  if (
    request.fieldKind === 'username' &&
    element instanceof HTMLInputElement &&
    element.type.toLowerCase() === 'password'
  ) {
    return { success: false, errorCode: 'KEYVAULT_USERNAME_FIELD_REQUIRED' };
  }

  element.focus();
  if (request.clearFirst) setValue(element, '');
  setValue(element, request.text);
  return { success: true };
}

function setValue(element: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  element.value = value;
  element.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
  element.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
}

function isVisible(element: HTMLElement): boolean {
  const style = globalThis.getComputedStyle(element);
  const rect = element.getBoundingClientRect();
  return (
    style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0
  );
}

function isSecretRequest(value: unknown): value is SafariContentSecretRequest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    record['type'] === 'marshal.keyvault.content.typeSecret' &&
    typeof record['selector'] === 'string' &&
    (record['fieldKind'] === 'username' || record['fieldKind'] === 'password') &&
    typeof record['text'] === 'string' &&
    Array.isArray(record['allowedUrlPatterns']) &&
    record['allowedUrlPatterns'].every((pattern) => typeof pattern === 'string')
  );
}
