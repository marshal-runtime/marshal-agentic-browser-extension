/**
 * Whether the person's own Chrome is paired with this Marshal, and if not, why, from typed signals only: the host's
 * answer status for `browserbridge.status` and the bridge's own fields (`listening`, `connected`, `lastDisconnect.reason`).
 */
import { BridgeError, type BridgeClient, type BridgeStatus } from './bridge.js';

export type UserBrowserReason =
  | 'paired'
  | 'extension_missing'
  | 'no_socket'
  | 'control_off'
  | 'not_connected'
  | 'denied'
  | 'error';

export interface UserBrowserStatus {
  readonly name: 'user';
  readonly ready: boolean;
  readonly reason: UserBrowserReason;
  readonly detail: string;
  readonly extensionVersion?: string;
  /** Whether the bridge forwards live frames (events) or the side panel falls back to polled screenshots. */
  readonly screencast?: 'events' | 'polling';
}

/** `lastDisconnect.reason` the Chrome extension sends when the person turns control off (event-forwarding PR). */
const SWITCHED_OFF = 'switched-off';

export const DETAIL: Readonly<Record<Exclude<UserBrowserReason, 'paired'>, string>> = {
  extension_missing:
    'The browser bridge extension (@zygstinct/browser-bridge) is not installed or is disabled in Marshal.',
  no_socket:
    "The browser bridge is installed but its local socket is not listening, so the person's Chrome cannot reach it.",
  control_off:
    "The person's Chrome extension is installed but its control switch ('Let Marley use this browser') is off.",
  not_connected:
    'No Chrome is attached to the browser bridge: the Marley Chrome extension is not installed, its control switch is off, or its bridge address is not set (an older Chrome extension does not say which).',
  denied: "Marshal's permission policy does not allow this caller to use the browser bridge.",
  error: 'The browser bridge did not answer its status.',
};

export async function userBrowserStatus(
  bridge: BridgeClient | undefined,
): Promise<UserBrowserStatus> {
  if (!bridge) return notReady('extension_missing');
  let status: BridgeStatus;
  try {
    status = await bridge.call<BridgeStatus>('browserbridge.status', {});
  } catch (error) {
    if (error instanceof BridgeError && error.code === 'extension_missing')
      return notReady('extension_missing');
    if (error instanceof BridgeError && error.code === 'denied') return notReady('denied');
    return notReady('error', error instanceof Error ? error.message : String(error));
  }
  if (status.listening !== true)
    return notReady('no_socket', status.error ? `bridge said: ${status.error}` : undefined);
  const hello = status.browser?.hello ?? null;
  if (status.connected === true && hello) {
    const version = typeof hello.extensionVersion === 'string' ? hello.extensionVersion : undefined;
    const events = Array.isArray(hello.capabilities) && hello.capabilities.includes('screencast');
    return {
      name: 'user',
      ready: true,
      reason: 'paired',
      detail: `The person's Chrome is connected${version ? ` (Marley extension ${version})` : ''}; sessions open background tabs in its Marley tab group.`,
      ...(version ? { extensionVersion: version } : {}),
      screencast: events ? 'events' : 'polling',
    };
  }
  if (status.lastDisconnect?.reason === SWITCHED_OFF) return notReady('control_off');
  return notReady('not_connected');
}

function notReady(reason: Exclude<UserBrowserReason, 'paired'>, extra?: string): UserBrowserStatus {
  return {
    name: 'user',
    ready: false,
    reason,
    detail: extra ? `${DETAIL[reason]} (${extra})` : DETAIL[reason],
  };
}
