export const SAFARI_NATIVE_APPLICATION_ID = 'com.marshal.agentic-browser.safari';
export const SAFARI_NATIVE_PORT_MESSAGE = 'marshal.keyvault.typeSecret';
export const SAFARI_HANDSHAKE_MESSAGE = 'marshal.safari.handshake';

export interface SafariHandshake {
  readonly kind: typeof SAFARI_HANDSHAKE_MESSAGE;
  readonly browserInstanceId: string;
  readonly extensionId: string;
  readonly browser: 'safari';
  readonly profileId?: string;
}

export interface SafariSecretTypeRequest {
  readonly kind: typeof SAFARI_NATIVE_PORT_MESSAGE;
  readonly requestId: string;
  /** Host-assigned value; the agent cannot select or override it. */
  readonly browserInstanceId: string;
  readonly selector: string;
  readonly fieldKind: 'username' | 'password';
  readonly text: string;
  readonly allowedUrlPatterns: readonly string[];
  readonly clearFirst?: boolean;
  readonly timeout?: number;
}

export interface SafariSecretTypeResponse {
  readonly kind: typeof SAFARI_NATIVE_PORT_MESSAGE;
  readonly requestId: string;
  readonly browserInstanceId: string;
  readonly success: boolean;
  readonly errorCode?: string;
}

export type SafariNativePortMessage = SafariSecretTypeRequest | SafariSecretTypeResponse;

export interface SafariContentSecretRequest {
  readonly type: 'marshal.keyvault.content.typeSecret';
  readonly selector: string;
  readonly fieldKind: 'username' | 'password';
  readonly text: string;
  readonly allowedUrlPatterns: readonly string[];
  readonly clearFirst?: boolean;
}

export interface SafariContentSecretResponse {
  readonly success: boolean;
  readonly errorCode?: string;
}

export function isSafariSecretTypeRequest(value: unknown): value is SafariSecretTypeRequest {
  if (!isRecord(value)) return false;
  return (
    value['kind'] === SAFARI_NATIVE_PORT_MESSAGE &&
    typeof value['requestId'] === 'string' &&
    typeof value['browserInstanceId'] === 'string' &&
    typeof value['selector'] === 'string' &&
    (value['fieldKind'] === 'username' || value['fieldKind'] === 'password') &&
    typeof value['text'] === 'string' &&
    Array.isArray(value['allowedUrlPatterns']) &&
    value['allowedUrlPatterns'].every((pattern) => typeof pattern === 'string')
  );
}

export function isSafariSecretTypeResponse(value: unknown): value is SafariSecretTypeResponse {
  if (!isRecord(value)) return false;
  return (
    value['kind'] === SAFARI_NATIVE_PORT_MESSAGE &&
    typeof value['requestId'] === 'string' &&
    typeof value['browserInstanceId'] === 'string' &&
    typeof value['success'] === 'boolean'
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
