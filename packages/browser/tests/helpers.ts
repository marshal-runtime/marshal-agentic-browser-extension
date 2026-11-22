import type { Decider } from '../src/engine/decider.js';
import type { DecideAnswer, DecideMultiInput, DecideSchemaInput } from '../src/contracts.js';
import type {
  ActOutcome,
  Shot,
  Snapshot,
  SnapshotElement,
  Target,
  TargetAction,
} from '../src/target.js';

export function el(ref: string, overrides: Partial<SnapshotElement> = {}): SnapshotElement {
  return {
    ref,
    node: ref.slice(1),
    role: 'button',
    label: `Button ${ref}`,
    tag: 'button',
    type: 'submit',
    kind: 'click',
    where: 'center',
    box: [10, 10, 50, 20],
    ...overrides,
  };
}

export function page(url: string, elements: SnapshotElement[], text = 'page text'): Snapshot {
  return {
    url,
    title: 'Fixture',
    text,
    elements,
    canScrollDown: false,
    canScrollUp: false,
    viewport: { w: 1280, h: 800 },
    omitted: 0,
  };
}

/** A scripted target: each snapshot() returns the next page (the last one repeats). */
export class FakeTarget implements Target {
  readonly backend: Target['backend'] = 'managed';
  readonly description = 'fake';
  readonly actions: TargetAction[] = [];
  readonly shots: { marks: readonly SnapshotElement[] | undefined; format: string | undefined }[] =
    [];
  snapshots = 0;
  constructor(
    private readonly pages: Snapshot[],
    private readonly outcome: (action: TargetAction) => ActOutcome = () => ({ ok: true }),
  ) {}
  snapshot(): Promise<Snapshot> {
    const next = this.pages[Math.min(this.snapshots, this.pages.length - 1)] as Snapshot;
    this.snapshots += 1;
    return Promise.resolve(next);
  }
  act(action: TargetAction): Promise<ActOutcome> {
    this.actions.push(action);
    return Promise.resolve(this.outcome(action));
  }
  screenshot(options?: { marks?: readonly SnapshotElement[]; format?: string }): Promise<Shot> {
    this.shots.push({ marks: options?.marks, format: options?.format });
    return Promise.resolve({
      data: 'AAAA',
      mimeType: options?.format === 'jpeg' ? 'image/jpeg' : 'image/png',
    });
  }
  fullText(): Promise<string> {
    return Promise.resolve('full page text with the price 42 EUR');
  }
  close(): Promise<void> {
    return Promise.resolve();
  }
}

export interface Turn {
  readonly choice: string;
  readonly confidence?: number;
  readonly goalMet?: number;
  readonly needsOwner?: number;
  readonly pageReady?: number;
  readonly probabilities?: Record<string, number>;
}

/** A scripted decide service: each judge() answers the next turn (the last one repeats) and records its input. */
export class FakeDecider implements Decider {
  readonly judged: DecideMultiInput[] = [];
  readonly extracted: DecideSchemaInput[] = [];
  private index = 0;
  constructor(
    private readonly turns: Turn[],
    private readonly failWith?: Error,
    private readonly extractAnswer: unknown = { price: 42 },
  ) {}
  judge(input: DecideMultiInput): ReturnType<Decider['judge']> {
    this.judged.push(input);
    if (this.failWith) return Promise.reject(this.failWith);
    const turn = this.turns[Math.min(this.index, this.turns.length - 1)] as Turn;
    this.index += 1;
    const answers: Record<string, DecideAnswer> = {
      next_action: {
        type: 'choice',
        choice: turn.choice,
        confidence: turn.confidence ?? 0.9,
        probabilities: turn.probabilities ?? { [turn.choice]: turn.confidence ?? 0.9 },
      },
      goal_met: { type: 'predicate', probability: turn.goalMet ?? 0.05 },
      needs_owner: { type: 'predicate', probability: turn.needsOwner ?? 0.02 },
      page_ready: { type: 'predicate', probability: turn.pageReady ?? 0.97 },
    };
    return Promise.resolve({ success: true as const, answers, usage: { input_tokens: 100 } });
  }
  extract(input: DecideSchemaInput): ReturnType<Decider['extract']> {
    this.extracted.push(input);
    return Promise.resolve({ success: true as const, choice: this.extractAnswer });
  }
  probe(): ReturnType<Decider['probe']> {
    return Promise.resolve({ available: true, detail: 'fake' });
  }
}

export const saveShot = (_shot: Shot, label: string): Promise<string> =>
  Promise.resolve(`/tmp/fake-${label}.png`);
