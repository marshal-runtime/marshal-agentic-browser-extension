/**
 * Stop rules enforced in code, never left to the model. Ported from zygstinct apps/agent-server/src/browser-do.ts
 * (origin/main 59b5f6d51), which reads typed signals only (zygstinct lean.md LN01: no word list over page text):
 *   - a secret field (a password input, or one the snapshot marks `secret`) is never offered, a click included;
 *   - text is typed only from a key of the caller's `values`, never a string the model wrote;
 *   - a click on a link that leaves the page's site, or whose address has a grant / payment / install path segment, is
 *     not made: the task stops with `needs_owner` and names the element. Because "same site" here includes a parent or
 *     child host (browser-do compares exact hosts), a link to ANOTHER host of the same site is checked by its own host
 *     labels too: `checkout.shop.com` or `billing.shop.com` from `shop.com` stops like `/checkout` does. A link to any
 *     scheme but http(s) (mailto:, tel:, a custom app scheme, file:) stops too; `javascript:` and `about:` run in the
 *     page and are clicks like any button;
 *   - a form is checked by the same rule on the address it sends to (`formNeedsOwner`), before Enter in one of its
 *     fields or a click on its submit button; when the backend cannot see form targets, a form that holds a caller value
 *     is not sent at all;
 *   - the task's home site is where it started: typing, choosing, sending a form or returning data happens only there
 *     (`leftHome`), whatever moved the tab (a script, a redirect, a meta refresh);
 *   - a page that moved the tab to a private or local address (loopback, LAN, link-local, cloud metadata) from a public
 *     start stops (`privateHost`), so a page cannot walk the agent into the machine's own network.
 * Whether a BUTTON's own label grants, connects, pays or sends is judged by the model (the `ask_owner` action and the
 * `needs_owner` question), and stopped in code on its answer.
 */
import type { BackendKind, Snapshot, SnapshotElement } from '../target.js';

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

/** Schemes a click or form may use without the owner: they run inside the page and go nowhere. */
const IN_PAGE_SCHEMES: ReadonlySet<string> = new Set(['javascript:', 'about:']);

export function isSecret(element: SnapshotElement): boolean {
  return element.secret === true || element.type === 'password' || element.value === '(hidden)';
}

export const siteOf = (url: string): string | null => {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
    return parsed.hostname.toLowerCase();
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

/**
 * True when going to `address` from `pageUrl` must be left to the owner: another site, a non-page scheme, another host
 * of the same site whose own labels are a grant / payment / install step, or such a path segment.
 */
export function addressNeedsOwner(
  address: string,
  pageUrl: string,
  allowedSites: readonly string[] = [],
): boolean {
  let target: URL;
  try {
    target = new URL(address, pageUrl);
  } catch {
    return true;
  }
  if (IN_PAGE_SCHEMES.has(target.protocol)) return false;
  if (target.protocol !== 'https:' && target.protocol !== 'http:') return true;
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
}

/** True when clicking this element must be left to the owner (see the header). */
export function linkNeedsOwner(
  element: SnapshotElement,
  pageUrl: string,
  allowedSites: readonly string[] = [],
): boolean {
  if (element.tag !== 'a' || !element.href) return false;
  return addressNeedsOwner(element.href, pageUrl, allowedSites);
}

/** A control that sends its form when clicked: a submit or image button (a `<button>` is a submit by default). */
export function isSubmitControl(element: SnapshotElement): boolean {
  if (element.tag === 'button') return element.type === '' || element.type === 'submit';
  return element.tag === 'input' && (element.type === 'submit' || element.type === 'image');
}

/**
 * Why sending this element's form must be left to the owner, or null when it may be sent. `holdsValue`: a caller value
 * is in a field on this page, so a form whose target is unknown could carry it anywhere.
 */
export function formNeedsOwner(
  element: SnapshotElement,
  snapshot: Pick<Snapshot, 'url' | 'formActionsKnown'>,
  allowedSites: readonly string[],
  holdsValue: boolean,
): 'form_leaves_site' | 'form_target_unknown' | null {
  if (element.formAction)
    return addressNeedsOwner(element.formAction, snapshot.url, allowedSites)
      ? 'form_leaves_site'
      : null;
  // The managed snapshot stamps every control inside a form; no formAction there means no form to send.
  if (snapshot.formActionsKnown === true) return null;
  return holdsValue ? 'form_target_unknown' : null;
}

/** True when the page at `url` is no longer on the task's home site (see the header). */
export function leftHome(
  home: string | null,
  url: string,
  allowedSites: readonly string[],
): boolean {
  if (!home) return false;
  return !sameSite(home, siteOf(url), allowedSites);
}

/** Loopback, private, link-local and cloud-metadata hosts, and names that only resolve on this machine or its LAN. */
export function privateHost(host: string | null): boolean {
  if (!host) return false;
  const name = host.toLowerCase().replace(/^\[|\]$/g, '');
  if (name === 'localhost' || name.endsWith('.localhost') || name.endsWith('.local')) return true;
  if (name === 'metadata.google.internal' || name.endsWith('.internal')) return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(name);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }
  if (name.includes(':')) {
    if (name === '::1' || name === '::') return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(name);
    if (mapped) return privateHost(mapped[1] ?? null);
    // The URL parser writes an IPv4-mapped address in hex: [::ffff:127.0.0.1] becomes [::ffff:7f00:1].
    const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(name);
    if (hex) {
      const high = parseInt(hex[1] ?? '0', 16);
      const low = parseInt(hex[2] ?? '0', 16);
      return privateHost(
        `${String(high >> 8)}.${String(high & 255)}.${String(low >> 8)}.${String(low & 255)}`,
      );
    }
    return /^f[cd][0-9a-f]{2}:/.test(name) || /^fe[89ab][0-9a-f]:/.test(name);
  }
  return false;
}

/** What `actionGuard` needs besides the action and the page. */
export interface GuardContext {
  /** The task's home site (`leftHome`); null until the task has seen an http(s) page, and always on an app window. */
  readonly home: string | null;
  readonly allowedSites: readonly string[];
  readonly backend: BackendKind;
  /** A caller value was typed in this task, or a field on this page holds one (`formNeedsOwner`'s `holdsValue`). */
  readonly holdsValue: boolean;
}

/** Why an action must be left to the owner: a `needs_owner` reason, a trace note and the element it concerns. */
export interface GuardStop {
  readonly reason:
    | 'secret_field'
    | 'left_site'
    | 'form_leaves_site'
    | 'form_target_unknown'
    | 'owner_must_decide';
  readonly note: string;
  readonly element?: { readonly ref: string; readonly label: string; readonly href?: string };
}

/**
 * Every per-action code guard, in one place: the step loop calls it for the action it is about to take, and a caller
 * that plans several actions per decision must call it before EACH of them, against the page as it is then. Returns
 * null when the action may be taken. An app window has no address and no web forms, so the site and form checks never
 * fire there (its owner signals are typed by the backend).
 */
export function actionGuard(
  action: { readonly kind: string; readonly element?: SnapshotElement },
  snapshot: Pick<Snapshot, 'url' | 'formActionsKnown'>,
  context: GuardContext,
): GuardStop | null {
  const element = action.element;
  const named = element ? { ref: element.ref, label: element.label } : undefined;
  if (element && isSecret(element))
    return {
      reason: 'secret_field',
      note: 'a password, code or card field; the person types it themselves',
      element: { ref: element.ref, label: element.label },
    };
  // Typing, choosing or sending happens only on the home site, whatever moved the tab off it (a script, a redirect).
  if (
    (action.kind === 'type' || action.kind === 'submit' || action.kind === 'select') &&
    leftHome(context.home, snapshot.url, context.allowedSites)
  )
    return {
      reason: 'left_site',
      note: `the page is no longer on the task's site (${context.home ?? ''})`,
      ...(named ? { element: named } : {}),
    };
  if (!element) return null;
  const own = { ref: element.ref, label: element.label };
  // A form is checked by where it sends, before Enter in one of its fields or a click on its submit button.
  if (
    context.backend !== 'app' &&
    (action.kind === 'submit' || (action.kind === 'click' && isSubmitControl(element)))
  ) {
    const why = formNeedsOwner(element, snapshot, context.allowedSites, context.holdsValue);
    if (why)
      return {
        reason: why,
        note:
          why === 'form_leaves_site'
            ? 'the form sends to another site or a payment / grant address'
            : 'the form holds a supplied value and this browser cannot tell where it sends',
        element: { ...own, ...(element.formAction ? { href: element.formAction } : {}) },
      };
  }
  if (action.kind === 'click' && linkNeedsOwner(element, snapshot.url, context.allowedSites))
    return {
      reason: 'owner_must_decide',
      note: 'link leaves the site or leads to a grant, payment or install page',
      element: { ...own, ...(element.href ? { href: element.href } : {}) },
    };
  if (signalNeedsOwner(element, action.kind))
    return {
      reason: 'owner_must_decide',
      note: `typed owner signal: ${element.ownerSignal ?? ''}`,
      element: own,
    };
  return null;
}
