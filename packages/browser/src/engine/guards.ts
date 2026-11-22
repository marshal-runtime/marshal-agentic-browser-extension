/**
 * Stop rules enforced in code, never left to the model. Ported from zygstinct apps/agent-server/src/browser-do.ts
 * (origin/main 59b5f6d51), which reads typed signals only (zygstinct lean.md LN01: no word list over page text):
 *   - a secret field (a password input, or one the snapshot marks `secret`) is never offered, a click included;
 *   - text is typed only from a key of the caller's `values`, never a string the model wrote;
 *   - a click on a link that leaves the page's site, or whose address has a grant / payment / install path segment, is
 *     not made: the task stops with `needs_owner` and names the element. Because "same site" here includes a parent or
 *     child host (browser-do compares exact hosts), a link to ANOTHER host of the same site is checked by its own host
 *     labels too: `checkout.shop.com` or `billing.shop.com` from `shop.com` stops like `/checkout` does.
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
  'pay',
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

/** How many trailing host labels two host names share (`www.shop.com`, `pay.shop.com` -> 2). */
function commonSuffix(a: string, b: string): number {
  const left = a.split('.').reverse();
  const right = b.split('.').reverse();
  let shared = 0;
  while (shared < left.length && shared < right.length && left[shared] === right[shared])
    shared += 1;
  return shared;
}

/**
 * The backend's typed owner signal for a click or submit (an app's window control, a sheet's default button). It is
 * a field the backend read from the platform (Accessibility role/subrole/default button), never a word list.
 */
export function signalNeedsOwner(element: SnapshotElement, kind: string): boolean {
  return (
    (kind === 'click' || kind === 'submit') &&
    typeof element.ownerSignal === 'string' &&
    element.ownerSignal !== ''
  );
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
    const from = siteOf(pageUrl);
    const to = siteOf(target.href);
    if (!sameSite(from, to, allowedSites)) return true;
    // Another host of the same site: its own labels count like path segments, unless the caller named that host.
    if (to && to !== from && !allowedSites.some((site) => site.toLowerCase() === to)) {
      const shared = from ? commonSuffix(from, to) : 0;
      const own = to.split('.').slice(0, to.split('.').length - shared);
      if (own.some((label) => OWNER_SEGMENTS.has(label))) return true;
    }
    return target.pathname
      .toLowerCase()
      .split('/')
      .some((segment) => OWNER_SEGMENTS.has(segment));
  } catch {
    return false;
  }
}
