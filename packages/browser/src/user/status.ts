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
  /** When not paired: what to install or switch on, in order, for this reason (see `setupFor`). */
  readonly setup?: UserBrowserSetup;
}

/**
 * How to connect the person's own Chrome to this Marshal. Facts from zyg-edge/marley-browser-extension (README, commit
 * e1f64ab) and zygstinct apps/web (the /browser page):
 *   - Marshal's local socket (ws://127.0.0.1:17373/bridge) opens only in a developer install: the repository's
 *     chrome-extension folder loaded unpacked, with the bridge address typed into the popup;
 *   - the zip the Marley website serves at /browser is a store-style build (SITE_INSTALL): it pairs with Marley in the
 *     cloud for WhatsApp, and never opens Marshal's socket, so it cannot connect this Marshal;
 *   - there is no Chrome Web Store listing yet.
 */
export interface UserBrowserSetup {
  readonly reason: Exclude<UserBrowserReason, 'paired'>;
  /** One line an agent can say to the person. */
  readonly summary: string;
  /** The steps for this reason, in order. */
  readonly steps: readonly string[];
  readonly chromeExtension: {
    readonly name: 'Marley';
    readonly repository: 'https://github.com/zyg-edge/marley-browser-extension';
    readonly access: string;
    readonly folder: 'chrome-extension';
    readonly install: 'developer (Load unpacked)';
    readonly bridgeAddress: typeof BRIDGE_ADDRESS;
  };
  readonly marshalExtension: {
    readonly identity: '@zygstinct/browser-bridge';
    readonly folder: 'marshal-extension';
  };
  /** The Marley website's install page: what it is, and why it does not connect Marshal. */
  readonly websiteInstall: { readonly url: typeof WEBSITE_INSTALL; readonly note: string };
  readonly storeListing: null;
}

export const BRIDGE_ADDRESS = 'ws://127.0.0.1:17373/bridge';
export const WEBSITE_INSTALL = 'https://app.marleyagent.com/browser';

const CHROME_STEPS: readonly string[] = [
  "Get the Marley Chrome extension's source: the chrome-extension folder of https://github.com/zyg-edge/marley-browser-extension (a private ZyG repository; clone it with a ZyG GitHub account).",
  'In Chrome open chrome://extensions, turn on Developer mode (top right), click Load unpacked and pick that chrome-extension folder. A copy downloaded from the Marley website does not work here: it never opens the local connection Marshal uses.',
  `Click the Marley extension's icon, open "Developer: Marshal bridge" and enter ${BRIDGE_ADDRESS}.`,
  'In the same popup turn on "Let Marley use this browser". The badge shows "on" once it reaches Marshal.',
  'Run browser.status again: the user backend reads ready.',
];

const SETUP: Readonly<
  Record<Exclude<UserBrowserReason, 'paired'>, { summary: string; steps: readonly string[] }>
> = {
  extension_missing: {
    summary:
      "Marshal's browser bridge (@zygstinct/browser-bridge) is not installed or is off, so the person's Chrome cannot connect.",
    steps: [
      'Install or enable the @zygstinct/browser-bridge runtime extension in Marshal (the marshal-extension folder of https://github.com/zyg-edge/marley-browser-extension: build it with its build.mjs, then runtimeInstallLocalExtension with that folder).',
      ...CHROME_STEPS,
    ],
  },
  no_socket: {
    summary:
      "Marshal's browser bridge is installed but its local socket on port 17373 is not listening.",
    steps: [
      'Disable and enable the @zygstinct/browser-bridge extension in Marshal (or restart Marshal); check that nothing else holds port 17373.',
      'Run browser.status again; if it now says not_connected, follow those steps.',
    ],
  },
  control_off: {
    summary:
      'The Marley Chrome extension is connected but its switch "Let Marley use this browser" is off.',
    steps: [
      "Click the Marley extension's icon in Chrome and turn on 'Let Marley use this browser'.",
      'Run browser.status again.',
    ],
  },
  not_connected: {
    summary:
      "The person's Chrome is not connected: install the Marley Chrome extension as a developer install, point it at Marshal and switch it on.",
    steps: CHROME_STEPS,
  },
  denied: {
    summary: "Marshal's permission policy refuses the browser bridge to this caller.",
    steps: [
      "Ask the person to allow browserbridge.* (and browserbridge.control) for this agent in Marshal's permission settings.",
    ],
  },
  error: {
    summary: 'The browser bridge did not answer its status.',
    steps: [
      "Check the @zygstinct/browser-bridge extension's health in Marshal (runtimeListExtensions), then run browser.status again.",
    ],
  },
};

/** The typed setup for a reason the person's Chrome is not paired. */
export function setupFor(reason: Exclude<UserBrowserReason, 'paired'>): UserBrowserSetup {
  return {
    reason,
    ...SETUP[reason],
    chromeExtension: {
      name: 'Marley',
      repository: 'https://github.com/zyg-edge/marley-browser-extension',
      access: 'private repository of the ZyG GitHub organisation',
      folder: 'chrome-extension',
      install: 'developer (Load unpacked)',
      bridgeAddress: BRIDGE_ADDRESS,
    },
    marshalExtension: { identity: '@zygstinct/browser-bridge', folder: 'marshal-extension' },
    websiteInstall: {
      url: WEBSITE_INSTALL,
      note: "Marley's own page for pairing Chrome with Marley on WhatsApp (sign-in as a brand member needed). Its download is a store-style build that never opens Marshal's local connection, so it does not connect this Marshal.",
    },
    storeListing: null,
  };
}

/** A session or task on the person's own Chrome refused because it is not paired; carries the status and its setup. */
export class UserNotPaired extends Error {
  constructor(readonly status: UserBrowserStatus) {
    super(`BROWSER_USER_NOT_PAIRED: ${status.reason}: ${status.detail}`);
  }
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
    setup: setupFor(reason),
  };
}
