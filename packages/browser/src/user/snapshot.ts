/**
 * The bridge's page snapshot (chrome-extension/page.js `snapshotPage`) in the shape every backend reports: one
 * `SnapshotElement` per element with a fresh `eN` ref per snapshot (the bridge's own ref, stable across snapshots, becomes
 * the backend-private `node`), a 3x3 `where`, a `box`, and the secret flag the code guards read. Pure, so tests need no
 * browser.
 */
import type { Snapshot, SnapshotElement } from '../target.js';
import type { BridgeElement, BridgeSnapshot } from './bridge.js';

const FILL_ROLES: ReadonlySet<string> = new Set(['textbox', 'searchbox']);
/** Input types that take typed text (the rest are buttons, checkboxes, files, colours...). */
const TEXT_INPUT_TYPES: ReadonlySet<string> = new Set([
  '',
  'text',
  'search',
  'email',
  'url',
  'tel',
  'number',
  'password',
  'date',
  'datetime-local',
  'month',
  'week',
  'time',
]);

/** The bridge's own default viewport when it reports none. */
const FALLBACK_VIEWPORT = { w: 1280, h: 800 } as const;

export function bridgeToSnapshot(raw: BridgeSnapshot): Snapshot {
  const w = positive(raw.viewport?.width) ?? FALLBACK_VIEWPORT.w;
  const h = positive(raw.viewport?.height) ?? FALLBACK_VIEWPORT.h;
  const scrollY = Number(raw.scroll?.y) || 0;
  const scrollHeight = Number(raw.scroll?.height) || 0;
  const elements: SnapshotElement[] = [];
  let omitted = 0;
  for (const item of raw.elements) {
    // A disabled control can do nothing; the managed snapshot leaves it out too.
    if (item.disabled === true || typeof item.ref !== 'string' || !item.ref) {
      omitted += 1;
      continue;
    }
    elements.push(toElement(item, `e${String(elements.length + 1)}`, w, h));
  }
  // Offscreen elements after the visible ones, as the managed snapshot orders them (the bridge already sorts so).
  return {
    url: raw.url,
    title: raw.title,
    text: raw.text,
    elements,
    canScrollDown: scrollHeight > 0 && scrollY + h < scrollHeight - 2,
    canScrollUp: scrollY > 0,
    viewport: { w, h },
    omitted: omitted + (raw.elementsTruncated === true ? 1 : 0),
  };
}

export function kindOf(item: BridgeElement): SnapshotElement['kind'] {
  const tag = (item.tag ?? '').toLowerCase();
  const type = (item.type ?? '').toLowerCase();
  if (tag === 'textarea') return 'fill';
  if (tag === 'input') return TEXT_INPUT_TYPES.has(type) ? 'fill' : 'click';
  // A native <select> is offered as a click: the bridge reports no options, so there is nothing to choose from yet.
  if (tag === 'select') return 'click';
  if (FILL_ROLES.has((item.role ?? '').toLowerCase())) return 'fill';
  return 'click';
}

/**
 * Secret when the page says so (`secret`, from the bridge's own password / one-time-code rule), the field is a
 * password, or the bridge masked its value. Every one of these is a typed signal the bridge set, never page wording.
 */
export function bridgeSecret(item: BridgeElement): boolean {
  return (
    item.secret === true ||
    (item.type ?? '').toLowerCase() === 'password' ||
    item.value === '(hidden)'
  );
}

function toElement(item: BridgeElement, ref: string, w: number, h: number): SnapshotElement {
  const x = Number(item.x) || 0;
  const y = Number(item.y) || 0;
  const bw = Math.max(0, Number(item.w) || 0);
  const bh = Math.max(0, Number(item.h) || 0);
  const offscreen = item.inViewport === false;
  const kind = kindOf(item);
  const secret = bridgeSecret(item);
  const value =
    item.value === undefined || item.value === '' ? undefined : secret ? '(hidden)' : item.value;
  const label = (item.name ?? '').trim() || (item.placeholder ?? '').trim();
  const cx = x + bw / 2;
  const cy = y + bh / 2;
  return {
    ref,
    node: item.ref,
    role: item.role ?? '',
    label,
    tag: (item.tag ?? '').toLowerCase(),
    type: (item.type ?? '').toLowerCase(),
    kind,
    ...(value === undefined ? {} : { value }),
    ...(item.href ? { href: item.href } : {}),
    ...(typeof item.checked === 'boolean' ? { checked: item.checked ? 'true' : 'false' } : {}),
    ...(secret ? { secret: true } : {}),
    ...(offscreen ? { offscreen: true } : {}),
    where: cy < 0 ? 'above' : cy >= h ? 'below' : regionOf(cx, cy, w, h),
    box: [x, y, bw, bh],
  };
}

/** The managed snapshot's 3x3 region names (page/snapshot-script.ts `regionOf`). */
function regionOf(x: number, y: number, w: number, h: number): string {
  const col = x < w / 3 ? 0 : x < (2 * w) / 3 ? 1 : 2;
  const row = y < h / 3 ? 0 : y < (2 * h) / 3 ? 1 : 2;
  const parts = [['top', '', 'bottom'][row], ['left', '', 'right'][col]].filter(Boolean);
  return parts.length ? parts.join('-') : 'center';
}

function positive(value: unknown): number | undefined {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : undefined;
}
