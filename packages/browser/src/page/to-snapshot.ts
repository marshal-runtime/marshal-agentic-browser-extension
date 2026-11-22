/**
 * Turns the snapshot script's action rows (one per possible action, several per element) into one `SnapshotElement` per
 * element with a short `eN` ref. Pure, so every backend that runs SNAPSHOT_SCRIPT shares it and tests need no browser.
 */
import type { Snapshot, SnapshotElement } from '../target.js';

/** One row of SNAPSHOT_SCRIPT's `actions` (see snapshot-script.ts). */
export interface RawRow {
  readonly node: string | null;
  readonly kind: 'click' | 'fill' | 'select' | 'scroll' | 'wait' | 'submit';
  readonly role?: string;
  readonly label: string;
  readonly value?: string;
  readonly current_value?: string;
  readonly checked?: string;
  readonly id?: string;
  readonly where?: string;
  readonly box?: readonly [number, number, number, number];
  readonly near?: string;
  readonly offscreen?: boolean;
  readonly tag?: string;
  readonly type?: string;
  readonly href?: string;
  readonly formAction?: string;
  readonly secret?: boolean;
}

export interface RawSnapshot {
  readonly url: string;
  readonly title: string;
  readonly w: number;
  readonly h: number;
  readonly text: string;
  readonly actions: readonly RawRow[];
  readonly omittedActions: number;
}

export function isRawSnapshot(value: unknown): value is RawSnapshot {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Partial<RawSnapshot>;
  return typeof v.url === 'string' && Array.isArray(v.actions) && typeof v.text === 'string';
}

export function toSnapshot(raw: RawSnapshot): Snapshot {
  const byNode = new Map<string, SnapshotElement>();
  const order: string[] = [];
  let canScrollDown = false;
  let canScrollUp = false;
  for (const row of raw.actions) {
    if (row.kind === 'scroll') {
      if (row.id === 'scroll_down') canScrollDown = true;
      if (row.id === 'scroll_up') canScrollUp = true;
      continue;
    }
    if (row.kind === 'wait' || row.kind === 'submit' || row.node === null) continue;
    const existing = byNode.get(row.node);
    if (row.kind === 'select') {
      const label = row.label.split(' → ')[0] ?? row.label;
      const optionLabel = row.label.includes(' → ')
        ? row.label.slice(row.label.indexOf(' → ') + 3)
        : row.label;
      const option = { value: row.value ?? '', label: optionLabel };
      if (existing) {
        byNode.set(row.node, { ...existing, options: [...(existing.options ?? []), option] });
      } else {
        order.push(row.node);
        byNode.set(row.node, element(row, 'select', label, row.current_value, [option]));
      }
      continue;
    }
    if (existing) continue; // the editable field's extra "Open <label>" click row
    order.push(row.node);
    byNode.set(
      row.node,
      element(row, row.kind === 'fill' ? 'fill' : 'click', row.label, row.value),
    );
  }
  const elements = order.map((node, index) => ({
    ...(byNode.get(node) as SnapshotElement),
    ref: `e${String(index + 1)}`,
  }));
  return {
    url: raw.url,
    title: raw.title,
    text: raw.text,
    elements,
    canScrollDown,
    canScrollUp,
    viewport: { w: raw.w, h: raw.h },
    omitted: raw.omittedActions,
    // SNAPSHOT_SCRIPT stamps every control inside a form with its formAction.
    formActionsKnown: true,
  };
}

function element(
  row: RawRow,
  kind: SnapshotElement['kind'],
  label: string,
  value: string | undefined,
  options?: SnapshotElement['options'],
): SnapshotElement {
  return {
    ref: '',
    node: row.node ?? '',
    role: row.role ?? '',
    label,
    tag: row.tag ?? '',
    type: row.type ?? '',
    kind,
    ...(value === undefined || value === '' ? {} : { value }),
    ...(row.href ? { href: row.href } : {}),
    ...(row.formAction ? { formAction: row.formAction } : {}),
    ...(row.checked === undefined ? {} : { checked: row.checked }),
    ...(row.secret ? { secret: true } : {}),
    ...(row.offscreen ? { offscreen: true } : {}),
    ...(row.where ? { where: row.where } : {}),
    ...(row.near ? { near: row.near } : {}),
    ...(row.box ? { box: row.box } : {}),
    ...(options ? { options } : {}),
  };
}
