/**
 * The `user` backend's transport: the bridge to the Marley Chrome extension that this package carries
 * (src/user/local-bridge.ts, the local socket the developer install of dist/chrome-extension connects to). It speaks
 * the `browserbridge.*` names and shapes of the old `@zygstinct/browser-bridge` extension, so the user backend is the
 * same code; that extension's capabilities are not called any more (one path to the person's Chrome). Only the
 * non-evaluate verbs exist.
 */
import type { CarriedExtension } from './status.js';

/**
 * Why a bridge call failed, as a typed code (never parsed from message text):
 *   - `not_connected`: no Chrome is attached (or it left mid-call);
 *   - `stale_ref`, `no_tab`: the element or the tab is gone;
 *   - `unsupported`: the carried bridge does not offer this verb (live frames before marley-browser-extension#4);
 *   - `failed`: anything else the bridge or Chrome reported.
 */
export type BridgeErrorCode = 'not_connected' | 'stale_ref' | 'no_tab' | 'unsupported' | 'failed';

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

/** Error codes the carried bridge (local-bridge.ts) and the Chrome extension (background.js) send. */
const NOT_CONNECTED_CODES: ReadonlySet<string> = new Set([
  'browser-not-connected',
  'browser-disconnected',
  'browser-off',
]);
const STALE_CODES: ReadonlySet<string> = new Set(['stale-ref']);
const NO_TAB_CODES: ReadonlySet<string> = new Set(['tab-not-found', 'tab-not-in-group']);

export interface BridgeClient {
  call<T = Record<string, unknown>>(name: string, input: Record<string, unknown>): Promise<T>;
  /** The Chrome extension folder setup names (the carried bridge sets it at activation; see carried-folder.ts). */
  readonly carried?: CarriedExtension;
}

export function codeOf(bridgeCode: string): BridgeErrorCode {
  if (NOT_CONNECTED_CODES.has(bridgeCode)) return 'not_connected';
  if (STALE_CODES.has(bridgeCode)) return 'stale_ref';
  if (NO_TAB_CODES.has(bridgeCode)) return 'no_tab';
  return 'failed';
}

/** The bridge's own types, as the carried bridge and chrome-extension/page.js produce them. */
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
  /** The carried bridge: the port it serves (or tried), and why it could not bind it. */
  readonly port?: number;
  readonly bindError?: {
    readonly code: 'port_in_use' | 'listen_failed';
    readonly message: string;
    /** What holds the port: the old bridge extension, another @marshal/browser, or unknown. */
    readonly holder?: 'browser-bridge-extension' | 'marshal-browser' | 'other';
  };
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
