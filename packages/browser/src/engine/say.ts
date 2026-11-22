/**
 * What a task step does, in plain words for the person watching ("Clicking "Travel"", "Typing into "Search This
 * Site"", "Reading the page"). Built from the offer's structured kind and element, never by parsing the action text.
 * The engine's own wording (refs, rungs, confidences, plan notes) stays in the trace for the details view.
 * The words go to the panel and the trace (the caller's own output), never to the model, so labels are shown as the
 * page shows them.
 */
import type { SnapshotElement } from '../target.js';
import type { TaskPhase } from './task.js';
import { clip, type Offer, type OfferKind } from './offers.js';

const NAME_MAX = 40;

/** The element as a person would name it: its label in quotes, else what it is ("a link", "a text box"). */
function nameOf(element: SnapshotElement | undefined): string {
  const label = element?.label.replace(/\s+/g, ' ').trim();
  if (label) return `"${clip(label, NAME_MAX)}"`;
  const role = element?.role || element?.tag || '';
  if (role === 'link' || role === 'a') return 'a link';
  if (role === 'button') return 'a button';
  if (element?.kind === 'fill') return 'a text box';
  if (element?.kind === 'select') return 'a list';
  return 'an item on the page';
}

const STILL: Readonly<Partial<Record<OfferKind, string>>> = {
  scroll_down: 'Scrolling down',
  scroll_up: 'Scrolling up',
  back: 'Going back',
  wait: 'Waiting for the page',
  done: 'Checking the goal is met',
  blocked: 'Stuck: nothing on the page moves the goal on',
  ask_owner: 'Asking you to decide',
  need_value: 'Needs a value from you',
};

/** One offer as an activity, e.g. `Clicking "Travel"`. */
export function sayOffer(offer: Offer): string {
  const still = STILL[offer.kind];
  if (still) return still;
  const name = nameOf(offer.element);
  switch (offer.kind) {
    case 'click':
      return `Clicking ${name}`;
    case 'type':
      return `Typing into ${name}`;
    case 'select':
      return `Choosing an option in ${name}`;
    case 'submit':
      return `Sending ${name}`;
    default:
      return 'Working on the page';
  }
}

/** The engine's bookkeeping steps (rung 0 and 2), in the same plain words. */
export const SAY = {
  guard: 'Stopped by a safety check',
  decide: 'Deciding what to do next',
  plan: 'Planning the next steps',
  readValues: 'Reading the answer from the page',
  extract: 'Reading the answer from the page',
  note: 'Noting what this page shows',
  open: (url: string): string => {
    try {
      return `Opening ${new URL(url).host}`;
    } catch {
      return 'Opening the page';
    }
  },
} as const;

/** What the task is doing in a phase that has no action of its own. */
export const PHASE_SAY: Readonly<Record<TaskPhase | 'starting' | 'routing' | 'closing', string>> = {
  starting: 'Starting',
  routing: 'Choosing a browser',
  navigating: 'Opening the page',
  reading: 'Reading the page',
  deciding: 'Deciding what to do next',
  acting: 'Working on the page',
  waiting: 'Waiting for the page',
  extracting: 'Reading the answer from the page',
  closing: 'Finishing',
};
