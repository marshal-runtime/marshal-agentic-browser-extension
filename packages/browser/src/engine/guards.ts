/**
 * Stop rules enforced in code, never left to the model. Ported from zygstinct apps/agent-server/src/browser-do.ts
 * (origin/main 59b5f6d51), which reads typed signals only (zygstinct lean.md LN01: no word list over page text):
 *   - a secret field (a password input, or one the snapshot marks `secret`) is never offered, a click included;
 *   - text is typed only from a key of the caller's `values`, never a string the model wrote;
 *   - a click on a link that leaves the page's site, or whose address has a grant / payment / install path segment, is
 *     not made: the task stops with `needs_owner` and names the element.
 * Whether a BUTTON's own label grants, connects, pays or sends is judged by the model (the `ask_owner` action and the
 * `needs_owner` question), and stopped in code on its answer.
 */
import type { SnapshotElement } from '../target.js';

export const OWNER_SEGMENTS: ReadonlySet<string> = new Set([
  'oauth',
  'oauth2',
  'authorize',
  'authorise',
  'consent',
  'checkout',
  'payment',
  'payments',
  'billing',
  'install',
]);

export function isSecret(element: SnapshotElement): boolean {
  return element.secret === true || element.type === 'password' || element.value === '(hidden)';
}

const siteOf = (url: string): string | null => {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
};

/**
 * Same site: equal host names, or one a dot-suffix of the other (`www.shop.com` and `shop.com`). browser-do compares
 * exact host names; this relaxes only the subdomain case, and `allowedSites` adds hosts the caller named.
 */
export function sameSite(
  a: string | null,
  b: string | null,
  allowedSites: readonly string[] = [],
): boolean {
  if (!a || !b) return false;
  if (a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`)) return true;
  return allowedSites.some((site) => {
    const host = site.toLowerCase();
    return b === host || b.endsWith(`.${host}`);
  });
}

/** True when clicking this element must be left to the owner (see the header). */
export function linkNeedsOwner(
  element: SnapshotElement,
  pageUrl: string,
  allowedSites: readonly string[] = [],
): boolean {
  if (element.tag !== 'a' || !element.href) return false;
  try {
    const target = new URL(element.href, pageUrl);
    if (target.protocol !== 'https:' && target.protocol !== 'http:') return false;
    if (!sameSite(siteOf(pageUrl), siteOf(target.href), allowedSites)) return true;
    return target.pathname
      .toLowerCase()
      .split('/')
      .some((segment) => OWNER_SEGMENTS.has(segment));
  } catch {
    return false;
  }
}
