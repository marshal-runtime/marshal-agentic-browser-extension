/**
 * The actions the step engine offers the decision model, built in code from the snapshot. The model's only answer is
 * one of these strings, so it can choose an operation and a target but never invent either. Shape follows
 * browser-do.ts (`click e12`, `type e3 email`, `submit e3`), plus `select`, `back`, `wait` and `need_value`.
 */
import { isSecret } from './guards.js';
import type { Snapshot, SnapshotElement, TargetAction } from '../target.js';

export const MAX_OFFERS = 200;
const MAX_TYPE_OFFERS = 40;
const MAX_OPTIONS_PER_SELECT = 12;
const MAX_OFFSCREEN = 40;

export type OfferKind =
  | 'click'
  | 'type'
  | 'select'
  | 'submit'
  | 'scroll_down'
  | 'scroll_up'
  | 'back'
  | 'wait'
  | 'done'
  | 'blocked'
  | 'ask_owner'
  | 'need_value';

export interface Offer {
  readonly action: string;
  readonly kind: OfferKind;
  readonly description: string;
  readonly element?: SnapshotElement;
  /** For `type`: the caller's value name. The text itself is read from `values` only when acting. */
  readonly valueName?: string;
  /** For `select`: the option value. */
  readonly optionValue?: string;
}

export interface OfferContext {
  readonly values: Readonly<Record<string, string>>;
  readonly lastTyped: string | null;
  readonly canGoBack: boolean;
}

/**
 * A field that holds one of the caller's values is described by the value's NAME: the values are typed into the page
 * but never sent to the model (the capability promises names, not values), and a typed field echoes its text back.
 */
function fieldValue(element: SnapshotElement, values: Readonly<Record<string, string>>): string {
  if (!element.value) return 'empty';
  if (isSecret(element)) return 'value "(hidden)"';
  const held = Object.entries(values).find(
    ([, value]) => value !== '' && element.value?.includes(value),
  );
  return held ? `holds the value "${held[0]}"` : `value "${clip(element.value, 60)}"`;
}

export function describeElement(
  element: SnapshotElement,
  values: Readonly<Record<string, string>> = {},
): string {
  const role = element.role || element.tag || 'element';
  const bits = [`${role}${element.label ? ` "${clip(element.label, 80)}"` : ''}`];
  if (element.kind === 'fill') bits.push(fieldValue(element, values));
  if (element.kind === 'select' && element.value) bits.push(`now "${clip(element.value, 40)}"`);
  if (element.href) bits.push(`to ${shortUrl(element.href)}`);
  if (element.checked !== undefined)
    bits.push(element.checked === 'true' ? 'checked' : 'unchecked');
  if (element.near) bits.push(`near "${clip(element.near, 40)}"`);
  bits.push(element.offscreen ? 'offscreen' : (element.where ?? ''));
  return bits.filter(Boolean).join(', ');
}

export function buildOffers(snapshot: Snapshot, context: OfferContext): Offer[] {
  const list: Offer[] = [];
  let typeOffers = 0;
  let offscreen = 0;
  const elements = [...snapshot.elements].sort(
    (a, b) => Number(a.offscreen ?? false) - Number(b.offscreen ?? false),
  );
  for (const element of elements) {
    if (list.length >= MAX_OFFERS - 8) break;
    // A secret field is offered for nothing at all, a click included.
    if (isSecret(element)) continue;
    if (element.offscreen) {
      if (offscreen >= MAX_OFFSCREEN) continue;
      offscreen += 1;
    }
    const described = describeElement(element, context.values);
    if (element.kind === 'fill') {
      for (const [name, value] of Object.entries(context.values)) {
        if (typeOffers >= MAX_TYPE_OFFERS || element.value === value) continue;
        typeOffers += 1;
        list.push({
          action: `type ${element.ref} ${name}`,
          kind: 'type',
          element,
          valueName: name,
          description: `type the value "${name}" into ${described}`,
        });
      }
      if (context.lastTyped === element.ref) {
        list.push({
          action: `submit ${element.ref}`,
          kind: 'submit',
          element,
          description: `press Enter in ${described}`,
        });
      }
      continue;
    }
    if (element.kind === 'select') {
      (element.options ?? []).slice(0, MAX_OPTIONS_PER_SELECT).forEach((option, index) => {
        list.push({
          action: `select ${element.ref} o${String(index + 1)}`,
          kind: 'select',
          element,
          optionValue: option.value,
          description: `set ${described} to "${clip(option.label, 60)}"`,
        });
      });
      continue;
    }
    list.push({
      action: `click ${element.ref}`,
      kind: 'click',
      element,
      description: `click ${described}`,
    });
  }
  if (snapshot.canScrollDown)
    list.push({
      action: 'scroll_down',
      kind: 'scroll_down',
      description: 'scroll down to see more of the page',
    });
  if (snapshot.canScrollUp)
    list.push({ action: 'scroll_up', kind: 'scroll_up', description: 'scroll back up' });
  if (context.canGoBack)
    list.push({ action: 'back', kind: 'back', description: 'go back to the previous page' });
  list.push(
    {
      action: 'wait',
      kind: 'wait',
      description: 'wait for the page to finish loading or updating',
    },
    {
      action: 'done',
      kind: 'done',
      description: 'the page visibly shows the whole goal is satisfied',
    },
    { action: 'blocked', kind: 'blocked', description: 'no offered action can make progress' },
    {
      action: 'ask_owner',
      kind: 'ask_owner',
      description:
        'the next step picks an account, grants or connects something, accepts terms, pays or sends, or needs a choice only the person can make',
    },
    {
      action: 'need_value',
      kind: 'need_value',
      description: 'a field must be filled with text that was not offered as a value',
    },
  );
  return list;
}

/** The action a chosen offer performs, reading typed text from `values` only. */
export function actionOf(
  offer: Offer,
  values: Readonly<Record<string, string>>,
): TargetAction | null {
  switch (offer.kind) {
    case 'click':
      return offer.element ? { kind: 'click', ref: offer.element.ref } : null;
    case 'type': {
      if (!offer.element || offer.valueName === undefined) return null;
      const text = values[offer.valueName];
      return text === undefined ? null : { kind: 'type', ref: offer.element.ref, text };
    }
    case 'select':
      return offer.element && offer.optionValue !== undefined
        ? { kind: 'select', ref: offer.element.ref, value: offer.optionValue }
        : null;
    case 'submit':
      return offer.element ? { kind: 'submit', ref: offer.element.ref } : null;
    case 'scroll_down':
      return { kind: 'scroll', direction: 'down' };
    case 'scroll_up':
      return { kind: 'scroll', direction: 'up' };
    case 'back':
      return { kind: 'back' };
    case 'wait':
      return { kind: 'wait', ms: 1000 };
    default:
      return null;
  }
}

export function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function shortUrl(href: string): string {
  try {
    const url = new URL(href);
    return clip(`${url.hostname}${url.pathname === '/' ? '' : url.pathname}`, 80);
  } catch {
    return clip(href, 80);
  }
}
