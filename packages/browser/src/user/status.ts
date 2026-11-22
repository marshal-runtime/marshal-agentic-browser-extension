/**
 * Whether the person's own Chrome is paired with this Marshal, and if not, why, from typed signals only: the carried
 * bridge's fields (`listening`, `bindError`, `connected`, `lastDisconnect.reason`).
 */
import { existsSync, readFileSync } from 'fs';
import path from 'node:path';
import type { BridgeClient, BridgeStatus } from './bridge.js';

export type UserBrowserReason =
  | 'paired'
  | 'port_in_use'
  | 'no_socket'
  | 'control_off'
  | 'not_connected'
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
 * How to connect the person's own Chrome to this Marshal. This package carries both halves:
 *   - the Marley Chrome extension (zyg-edge/marley-browser-extension, folder chrome-extension, pinned commit of main,
 *     developer channel) in `dist/chrome-extension`, which the person loads unpacked; it runs no model, it only exposes
 *     browser controls;
 *   - the local socket it connects to (src/user/local-bridge.ts, ws://127.0.0.1:17373/bridge).
 * The Marley website's download (/browser) and a Chrome Web Store copy are store-style builds: they pair with Marley's
 * cloud relay for WhatsApp and never open Marshal's socket.
 */
export interface UserBrowserSetup {
  readonly reason: Exclude<UserBrowserReason, 'paired'>;
  /** One line an agent can say to the person. */
  readonly summary: string;
  /** The steps for this reason, in order. */
  readonly steps: readonly string[];
  readonly chromeExtension: {
    readonly name: 'Marley';
    /**
     * Absolute path of the folder to load: a stable copy of the carried files (see carried-folder.ts), else the install's
     * own dist/chrome-extension, or null when this build carries none.
     */
    readonly folder: string | null;
    readonly folderNote?: string;
    readonly install: 'developer (Load unpacked)';
    readonly version?: string;
    readonly repository: typeof REPOSITORY;
    readonly commit?: string;
    /** The address to enter in the extension's popup ("Developer: Marshal bridge"). */
    readonly bridgeAddress: string;
  };
  /** A Marley extension already in that Chrome from the website or the store, and what to do about it. */
  readonly otherInstalls: string;
  /** The Marley website's install page: what it is, and why it does not connect Marshal. */
  readonly websiteInstall: { readonly url: typeof WEBSITE_INSTALL; readonly note: string };
  readonly storeListing: null;
}

export const BRIDGE_ADDRESS = 'ws://127.0.0.1:17373/bridge';
export const WEBSITE_INSTALL = 'https://app.marleyagent.com/browser';
const REPOSITORY = 'https://github.com/zyg-edge/marley-browser-extension';

const OTHER_INSTALLS =
  "A Marley extension installed from the Marley website (app.marleyagent.com/browser) or the Chrome Web Store talks only to Marley's cloud relay (Marley on WhatsApp), never to Marshal. The website copy has the same extension id as the carried folder: remove it in chrome://extensions before Load unpacked. A store copy can stay, but it does not connect Marshal.";

export interface CarriedExtension {
  readonly folder: string | null;
  readonly version?: string;
  readonly commit?: string;
  /** Set when the folder is the install's own (it moves on update): why the stable copy could not be made. */
  readonly folderNote?: string;
}

/**
 * The carried Chrome extension of this install: `dist/chrome-extension` beside the bundle, else (running from source)
 * the package's dist or vendor folder. Its lock file names the version and commit.
 */
export function carriedExtension(
  candidates: readonly string[] = [
    path.join(__dirname, 'chrome-extension'),
    path.join(__dirname, '..', '..', 'dist', 'chrome-extension'),
    path.join(__dirname, '..', '..', 'vendor', 'chrome-extension'),
  ],
): CarriedExtension {
  const folder = candidates.find((candidate) => existsSync(path.join(candidate, 'manifest.json')));
  if (!folder) return { folder: null };
  try {
    const lock = JSON.parse(
      readFileSync(path.join(folder, '..', 'chrome-extension.lock.json'), 'utf8'),
    ) as { version?: unknown; commit?: unknown };
    return {
      folder,
      ...(typeof lock.version === 'string' ? { version: lock.version } : {}),
      ...(typeof lock.commit === 'string' ? { commit: lock.commit } : {}),
    };
  } catch {
    return { folder };
  }
}

function chromeSteps(carried: CarriedExtension, address: string): string[] {
  return [
    ...(carried.folder
      ? []
      : [
          'This install of @marshal/browser carries no Chrome extension folder (dist/chrome-extension is missing): reinstall the package, then follow the steps below.',
        ]),
    'In Chrome open chrome://extensions and turn on Developer mode (top right).',
    `Click Load unpacked and pick this folder: ${carried.folder ?? '<the dist/chrome-extension folder of @marshal/browser>'}. It is the Marley extension${carried.version ? ` ${carried.version}` : ''}, carried in this install. If Marley from the Marley website is already there, remove it first (same extension id).${carried.folderNote ? ` ${carried.folderNote}` : ''}`,
    `Click the Marley extension's icon, open "Developer: Marshal bridge" and enter ${address}.`,
    'In the same popup make sure "Let Marley use this browser" is on. The badge shows "on" once it reaches Marshal.',
    'Run browser.status again: the user backend reads ready.',
  ];
}

const HOLDER_TEXT: Readonly<Record<string, string>> = {
  'browser-bridge-extension':
    'the old @zygstinct/browser-bridge extension, which this package replaces',
  'marshal-browser': 'another Marshal on this machine that runs @marshal/browser',
  other: 'another program',
};

function setupBody(
  reason: Exclude<UserBrowserReason, 'paired'>,
  status: BridgeStatus | undefined,
  carried: CarriedExtension,
  address: string,
): { summary: string; steps: readonly string[] } {
  const port = String(status?.port ?? 17373);
  switch (reason) {
    case 'port_in_use': {
      const holder = status?.bindError?.holder ?? 'other';
      const steps =
        holder === 'browser-bridge-extension'
          ? [
              'Disable or remove the @zygstinct/browser-bridge extension in Marshal (Plugins, or runtimeDisableExtension / runtimeRemoveExtension with that identity); @marshal/browser carries the bridge now.',
              'Run browser.status again: @marshal/browser takes the port by itself. A Chrome extension already set to this address reconnects on its own.',
            ]
          : holder === 'marshal-browser'
            ? [
                "Close the other Marshal, or give this one another port (configuration bridgePort) and enter ws://127.0.0.1:<that port>/bridge in the Chrome extension's popup.",
                'Run browser.status again.',
              ]
            : [
                `Find what holds port ${port} (lsof -nP -iTCP:${port} -sTCP:LISTEN) and stop it, or set this extension's bridgePort to a free port and enter that address in the Chrome extension's popup.`,
                'Run browser.status again.',
              ];
      return {
        summary: `Port ${port} for the person's Chrome is held by ${HOLDER_TEXT[holder] ?? 'another program'}, so this Marshal cannot open its bridge. Nothing is routed through the other holder.`,
        steps,
      };
    }
    case 'no_socket':
      return {
        summary: `This Marshal could not open the local socket for the person's Chrome on port ${port}.`,
        steps: [
          `Check that port ${port} on 127.0.0.1 can be opened, or set bridgePort to a free port and enter that address in the Chrome extension's popup; then run browser.status again.`,
        ],
      };
    case 'control_off':
      return {
        summary:
          'The Marley Chrome extension is connected but its switch "Let Marley use this browser" is off.',
        steps: [
          "Click the Marley extension's icon in Chrome and turn on 'Let Marley use this browser'.",
          'Run browser.status again.',
        ],
      };
    case 'not_connected':
      return {
        summary:
          "The person's Chrome is not connected: load the Marley Chrome extension carried in this install (developer mode, Load unpacked), point it at Marshal and switch it on.",
        steps: chromeSteps(carried, address),
      };
    case 'error':
      return {
        summary: "The bridge to the person's Chrome did not answer its status.",
        steps: ['Run browser.status again; if it keeps failing, restart Marshal.'],
      };
  }
}

/** The typed setup for a reason the person's Chrome is not paired. */
export function setupFor(
  reason: Exclude<UserBrowserReason, 'paired'>,
  status?: BridgeStatus,
  carried: CarriedExtension = carriedExtension(),
): UserBrowserSetup {
  const address = status?.url ?? BRIDGE_ADDRESS;
  return {
    reason,
    ...setupBody(reason, status, carried, address),
    chromeExtension: {
      name: 'Marley',
      folder: carried.folder,
      install: 'developer (Load unpacked)',
      ...(carried.version ? { version: carried.version } : {}),
      repository: REPOSITORY,
      ...(carried.commit ? { commit: carried.commit } : {}),
      ...(carried.folderNote ? { folderNote: carried.folderNote } : {}),
      bridgeAddress: address,
    },
    otherInstalls: OTHER_INSTALLS,
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
  port_in_use:
    "The port of the bridge to the person's Chrome is held by another program, so this Marshal's bridge is not listening.",
  no_socket: "The bridge to the person's Chrome is not listening on its local socket.",
  control_off:
    "The person's Chrome extension is connected but its control switch ('Let Marley use this browser') is off.",
  not_connected:
    'No Chrome is attached: the Marley Chrome extension carried in this install is not loaded, its bridge address is not set, or its control switch is off (it does not say which).',
  error: "The bridge to the person's Chrome did not answer its status.",
};

export async function userBrowserStatus(
  bridge: BridgeClient | undefined,
  carriedGiven?: CarriedExtension,
): Promise<UserBrowserStatus> {
  const carried = carriedGiven ?? bridge?.carried;
  if (!bridge)
    return notReady('no_socket', undefined, 'no bridge was started in this host', carried);
  let status: BridgeStatus;
  try {
    status = await bridge.call<BridgeStatus>('browserbridge.status', {});
  } catch (error) {
    return notReady(
      'error',
      undefined,
      error instanceof Error ? error.message : String(error),
      carried,
    );
  }
  if (status.listening !== true) {
    if (status.bindError?.code === 'port_in_use')
      return notReady(
        'port_in_use',
        status,
        `held by ${HOLDER_TEXT[status.bindError.holder ?? 'other'] ?? 'another program'}`,
        carried,
      );
    return notReady('no_socket', status, status.error, carried);
  }
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
  if (status.lastDisconnect?.reason === SWITCHED_OFF)
    return notReady('control_off', status, undefined, carried);
  return notReady('not_connected', status, undefined, carried);
}

function notReady(
  reason: Exclude<UserBrowserReason, 'paired'>,
  status: BridgeStatus | undefined,
  extra: string | undefined,
  carried: CarriedExtension | undefined,
): UserBrowserStatus {
  return {
    name: 'user',
    ready: false,
    reason,
    detail: extra ? `${DETAIL[reason]} (${extra})` : DETAIL[reason],
    setup: setupFor(reason, status, carried),
  };
}
