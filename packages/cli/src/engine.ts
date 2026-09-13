/**
 * Engine selection.
 *
 * The CLI supports two engines:
 *  - 'cdp'    — raw Chrome DevTools Protocol against Chrome/Edge (the original path)
 *  - 'webkit' — Playwright WebKit, driven through a local daemon (see webkit-daemon.ts)
 *
 * IMPORTANT: `--browser webkit` (alias: `safari`) launches Playwright's WebKit
 * build — the same engine Safari uses — NOT the user's installed Safari.app.
 * It runs with a fresh, ephemeral profile: no Safari cookies, logins, or
 * extensions. Driving the real Safari.app (via safaridriver) is a documented
 * non-goal; see docs/safari-webkit.md.
 */

export type Engine = 'cdp' | 'webkit';

export interface BrowserSelection {
  engine: Engine;
  browser: 'chrome' | 'edge' | 'webkit';
}

const BROWSER_MAP: Record<string, BrowserSelection> = {
  chrome: { engine: 'cdp', browser: 'chrome' },
  edge: { engine: 'cdp', browser: 'edge' },
  webkit: { engine: 'webkit', browser: 'webkit' },
  safari: { engine: 'webkit', browser: 'webkit' },
};

/** Normalize a --browser flag value. Returns undefined when no flag given. */
export function normalizeBrowserFlag(flag: string | undefined): BrowserSelection | undefined {
  if (flag === undefined) return undefined;
  const selection = BROWSER_MAP[flag.toLowerCase()];
  if (!selection) {
    throw new Error(
      `Unknown browser: ${flag}. Supported: chrome, edge, webkit, safari (webkit and safari both use the Playwright WebKit engine, not your installed Safari).`,
    );
  }
  return selection;
}

/** Resolve the engine for this invocation: --browser flag wins, then saved config, then cdp. */
export function resolveEngine(
  browserFlag: string | undefined,
  config: { engine?: string } | undefined,
): Engine {
  const fromFlag = normalizeBrowserFlag(browserFlag);
  if (fromFlag) return fromFlag.engine;
  if (config?.engine === 'webkit') return 'webkit';
  return 'cdp';
}

/**
 * Commands (and flags) that only make sense against a raw CDP browser.
 * On the webkit engine these fail fast with the message below instead of
 * silently misbehaving.
 */
export const WEBKIT_UNSUPPORTED: Record<string, string> = {
  connect:
    'connect attaches to a remote CDP endpoint and is not supported on the webkit engine. Use `setup --browser webkit` to start a local WebKit, or `setup --browser chrome` for remote CDP workflows.',
  'list-targets':
    'list-targets exposes raw CDP targets (iframes, workers) and is not supported on the webkit engine. Use list-tabs for pages; cross-origin iframe access is CDP-only.',
};

export const WEBKIT_TARGET_FLAG_ERROR =
  '--target uses CDP target IDs and is not supported on the webkit engine. Use list-tabs / switch-tab for pages; iframe and worker targeting is CDP-only (chrome/edge).';

export const WEBKIT_EXPOSE_ERROR =
  '--expose is not supported on the webkit engine: the WebKit daemon has no authentication and always binds to 127.0.0.1. For remote control use the chrome/edge engine with an SSH tunnel.';

export const WEBKIT_HOST_ERROR =
  '--host is not supported on the webkit engine: the WebKit daemon is local-only. Remote browsers require the CDP engine (chrome/edge).';
