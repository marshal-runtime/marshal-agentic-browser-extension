/**
 * The `user` backend's transport: the installed `@zygstinct/browser-bridge` extension (provider `zygstinct.browser-bridge`,
 * source zyg-edge/marley-browser-extension), reached through the host's `execute` like any other capability. No second
 * socket: the bridge owns the one WebSocket to the person's Chrome, its "Marley" tab group and its permission
 * (`browserbridge.control`). Only the non-evaluate verbs are used, so this also works over the bridge's cloud relay, which
 * never runs page JavaScript.
 */
import {
  RUNTIME_PROTOCOL_VERSION,
  type InvocationContext,
  type RuntimeExecuteFn,
} from '../contracts.js';

/**
 * Why a bridge call failed, as a typed code (never parsed from message text):
 *   - `extension_missing`: no `browserbridge.*` capability on this host (the bridge extension is absent or disabled);
 *   - `denied`: the host's policy refused the call, or it needs an approval nobody gave;
 *   - `not_connected`: the bridge answered but no Chrome is attached (or it left mid-call);
 *   - `stale_ref`, `no_tab`: the element or the tab is gone;
 *   - `failed`: anything else the bridge or Chrome reported.
 */
export type BridgeErrorCode =
  | 'extension_missing'
  | 'denied'
  | 'not_connected'
  | 'stale_ref'
  | 'no_tab'
  | 'failed';

export class BridgeError extends Error {
  constructor(
    readonly code: BridgeErrorCode,
    message: string,
    /** The bridge's own error code, when it gave one. */
    readonly bridgeCode?: string,
  ) {
    super(`${code}: ${message}`);
    this.name = 'BridgeError';
  }
}

/** Error codes the bridge (marshal-extension/src/bridge.js) and the Chrome extension (background.js) send. */
const NOT_CONNECTED_CODES: ReadonlySet<string> = new Set([
  'browser-not-connected',
  'browser-disconnected',
  'browser-off',
]);
const STALE_CODES: ReadonlySet<string> = new Set(['stale-ref']);
const NO_TAB_CODES: ReadonlySet<string> = new Set(['tab-not-found', 'tab-not-in-group']);

export interface BridgeClient {
  call<T = Record<string, unknown>>(name: string, input: Record<string, unknown>): Promise<T>;
}

export function createHostBridge(
  execute: RuntimeExecuteFn,
  context?: InvocationContext,
): BridgeClient {
  return {
    async call<T>(name: string, input: Record<string, unknown>): Promise<T> {
      let response;
      try {
        response = await execute(
          {
            protocolVersion: RUNTIME_PROTOCOL_VERSION,
            targetType: 'operation',
            target: name,
            input,
          },
          context,
        );
      } catch (error) {
        throw new BridgeError('failed', error instanceof Error ? error.message : String(error));
      }
      if (response.status === 'not_found')
        throw new BridgeError('extension_missing', `${name} is not offered by this host`);
      if (response.status === 'denied' || response.status === 'approval_required')
        throw new BridgeError(
          'denied',
          response.error?.message ?? `${name} was not allowed (${response.status})`,
          response.status,
        );
      if (response.status !== 'success') {
        const bridgeCode = response.error?.code ?? '';
        const message = response.error?.message ?? `${name} ${response.status}`;
        throw new BridgeError(codeOf(bridgeCode), message, bridgeCode || undefined);
      }
      return (response.result?.output ?? {}) as T;
    },
  };
}

function codeOf(bridgeCode: string): BridgeErrorCode {
  if (NOT_CONNECTED_CODES.has(bridgeCode)) return 'not_connected';
  if (STALE_CODES.has(bridgeCode)) return 'stale_ref';
  if (NO_TAB_CODES.has(bridgeCode)) return 'no_tab';
  return 'failed';
}

/** The bridge's own types, as marshal-extension/src/capabilities.js and chrome-extension/page.js produce them. */
export interface BridgeStatus {
  readonly listening?: boolean;
  readonly url?: string;
  readonly connected?: boolean;
  readonly browser?: {
    readonly origin?: string;
    readonly connectedAt?: string;
    readonly hello?: {
      readonly extensionVersion?: string;
      readonly capabilities?: readonly string[];
    } | null;
  } | null;
  /** Added by marley-browser-extension's event-forwarding PR: why the last browser left. */
  readonly lastDisconnect?: { readonly reason?: string; readonly at?: string } | null;
  readonly error?: string;
}

export interface BridgeElement {
  readonly ref: string;
  readonly role?: string;
  readonly name?: string;
  readonly tag?: string;
  readonly type?: string;
  readonly inViewport?: boolean;
  readonly x?: number;
  readonly y?: number;
  readonly w?: number;
  readonly h?: number;
  readonly checked?: boolean;
  readonly value?: string;
  readonly placeholder?: string;
  readonly disabled?: boolean;
  readonly href?: string;
  readonly expanded?: boolean;
  /** Added by the event-forwarding PR: the page judged this a password / one-time-code field even when empty. */
  readonly secret?: boolean;
  /** Not sent by today's bridge: the absolute address a control's form sends to. Read only with `formActions`. */
  readonly formAction?: string;
}

export interface BridgeSnapshot {
  readonly tabId?: number;
  readonly url: string;
  readonly title: string;
  readonly viewport?: { readonly width?: number; readonly height?: number };
  readonly scroll?: { readonly x?: number; readonly y?: number; readonly height?: number };
  readonly text: string;
  readonly textTruncated?: boolean;
  readonly elements: readonly BridgeElement[];
  readonly elementsTruncated?: boolean;
  /** Not sent by today's bridge: true when every control inside a form carries its `formAction`. */
  readonly formActions?: boolean;
}

export interface BridgeTab {
  readonly tabId: number;
  readonly url?: string;
  readonly title?: string;
  readonly loadTimedOut?: boolean;
}
