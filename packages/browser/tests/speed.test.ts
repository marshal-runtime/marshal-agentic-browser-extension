import { describe, expect, it } from 'vitest';
import { runTask } from '../src/engine/task.js';
import { planQuestions, readPlan } from '../src/engine/plan.js';
import { NONE, numberText, pointerFields, readValues } from '../src/engine/values.js';
import { buildOffers } from '../src/engine/offers.js';
import type { DecideAnswer } from '../src/contracts.js';
import type { ActOutcome, Snapshot, TargetAction } from '../src/target.js';
import { el, FakeDecider, FakeTarget, page, saveShot, type Turn } from './helpers.js';

const URL = 'https://shop.example.com/calc';
const noSleep = (): Promise<void> => Promise.resolve();

function run(
  target: FakeTarget,
  decider: FakeDecider,
  input: Parameters<typeof runTask>[1],
  settings = {},
): ReturnType<typeof runTask> {
  return runTask({ target, decider, saveShot, sleep: noSleep, settings }, input);
}

const keypad = (
  text = '0',
  overrides: Record<string, Partial<ReturnType<typeof el>>> = {},
): Snapshot =>
  page(
    URL,
    ['e1', 'e2', 'e3', 'e4'].map((ref) => el(ref, { label: `key ${ref}`, ...overrides[ref] })),
    text,
  );

/** A target whose snapshot is computed from what was pressed so far (the display changes, the keys do not). */
class Keypad extends FakeTarget {
  constructor(
    private readonly next: (pressed: readonly TargetAction[]) => Snapshot,
    outcome?: (action: TargetAction) => ActOutcome,
  ) {
    super([], outcome);
  }
  override snapshot(): Promise<Snapshot> {
    this.snapshots += 1;
    return Promise.resolve(this.next(this.actions));
  }
}

const plan = (...choices: string[]): Turn['plan'] =>
  choices.map((choice) => [choice, 0.9] as const);

describe('plan: several actions from one decision', () => {
  it('takes the planned actions without a decision each, re-reading the page before every one', async () => {
    const target = new Keypad((pressed) => keypad(String(pressed.length)));
    const decider = new FakeDecider([
      { choice: 'click e1', plan: plan('click e2', 'click e3', 'click e4', 'look') },
      { choice: 'done', goalMet: 0.95 },
    ]);
    const result = await run(target, decider, { goal: 'press 1, 2, 3, 4' });
    expect(result.status).toBe('done');
    expect(target.actions).toEqual(['e1', 'e2', 'e3', 'e4'].map((ref) => ({ kind: 'click', ref })));
    expect(decider.judged).toHaveLength(2);
    expect(result.stats).toMatchObject({
      decisions: 2,
      plannedActions: 3,
      steps: 4,
      modelCalls: 2,
    });
    // One snapshot per decision and one before each planned action.
    expect(target.snapshots).toBe(5);
    const planned = result.trace.filter((step) => step.planned);
    expect(planned.map((step) => [step.action, step.planned?.by, step.planned?.index])).toEqual([
      ['click e2', 1, 2],
      ['click e3', 1, 3],
      ['click e4', 1, 4],
    ]);
    // The next decision sees every planned action in its history.
    expect(decider.judged[1]?.state).toContain('4. click e4');
  });

  it('a cancel stops a plan between its actions: no planned action runs after it', async () => {
    const controller = new AbortController();
    const target = new Keypad((pressed) => {
      // The cancel lands while the page is read before the second planned action.
      if (pressed.length === 2) controller.abort();
      return keypad(String(pressed.length));
    });
    const decider = new FakeDecider([
      { choice: 'click e1', plan: plan('click e2', 'click e3', 'click e4') },
    ]);
    const result = await runTask(
      { target, decider, saveShot, sleep: noSleep, signal: controller.signal },
      { goal: 'press 1, 2, 3, 4' },
    );
    expect(result.status).toBe('cancelled');
    expect(target.actions).toEqual(['e1', 'e2'].map((ref) => ({ kind: 'click', ref })));
  });

  it('planLength 1 asks no plan questions and acts once per decision', async () => {
    const target = new Keypad((pressed) => keypad(String(pressed.length)));
    const decider = new FakeDecider([
      { choice: 'click e1', plan: plan('click e2') },
      { choice: 'done', goalMet: 0.95 },
    ]);
    await run(target, decider, { goal: 'press 1' }, { planLength: 1 });
    expect(
      Object.keys(decider.judged[0]?.questions ?? {}).filter((key) => key.startsWith('after_')),
    ).toEqual([]);
    expect(target.actions).toHaveLength(1);
  });

  const early: [string, (pressed: readonly TargetAction[]) => Snapshot, string][] = [
    [
      'the address changed',
      (pressed) => (pressed.length ? page(`${URL}?next`, [...keypad().elements]) : keypad()),
      'address',
    ],
    [
      'an element appeared (a pop-up)',
      (pressed) =>
        pressed.length
          ? page(URL, [
              ...(keypad().elements as ReturnType<typeof el>[]),
              el('e5', { label: 'Close' }),
            ])
          : keypad(),
      'elements appeared',
    ],
    [
      'the planned element changed its label',
      (pressed) =>
        keypad(String(pressed.length), pressed.length ? { e2: { label: 'Delete all' } } : {}),
      'changed',
    ],
    [
      'the planned element moved',
      (pressed) =>
        keypad(String(pressed.length), pressed.length ? { e2: { box: [300, 10, 50, 20] } } : {}),
      'changed',
    ],
  ];
  for (const [name, next, why] of early) {
    it(`re-decides instead of acting on the plan when ${name}`, async () => {
      const target = new Keypad(next);
      const decider = new FakeDecider([
        { choice: 'click e1', plan: plan('click e2', 'click e3') },
        { choice: 'done', goalMet: 0.95 },
      ]);
      const result = await run(target, decider, { goal: 'press keys' });
      expect(target.actions).toEqual([{ kind: 'click', ref: 'e1' }]);
      expect(decider.judged).toHaveLength(2);
      expect(result.trace.find((step) => step.action === 'plan')?.note).toContain(why);
    });
  }

  it('ends the plan at an unsure follow-up, at look, and when an action fails or navigates', async () => {
    const unsure = new Keypad((pressed) => keypad(String(pressed.length)));
    await run(
      unsure,
      new FakeDecider([
        {
          choice: 'click e1',
          plan: [
            ['click e2', 0.9],
            ['click e3', 0.4],
            ['click e4', 0.9],
          ],
        },
        { choice: 'done', goalMet: 0.95 },
      ]),
      { goal: 'press' },
    );
    expect(unsure.actions.map((action) => (action as { ref: string }).ref)).toEqual(['e1', 'e2']);

    const failing = new Keypad(
      (pressed) => keypad(String(pressed.length)),
      (action) =>
        (action as { ref?: string }).ref === 'e2' ? { ok: false, error: 'stuck' } : { ok: true },
    );
    const failed = await run(
      failing,
      new FakeDecider([
        { choice: 'click e1', plan: plan('click e2', 'click e3') },
        { choice: 'done', goalMet: 0.95 },
      ]),
      { goal: 'press' },
    );
    expect(failing.actions.map((action) => (action as { ref: string }).ref)).toEqual(['e1', 'e2']);
    expect(failed.trace.find((step) => step.action === 'plan')?.note).toContain('failed');

    const navigating = new Keypad(
      (pressed) => keypad(String(pressed.length)),
      (action) =>
        (action as { ref?: string }).ref === 'e2' ? { ok: true, navigated: true } : { ok: true },
    );
    await run(
      navigating,
      new FakeDecider([
        { choice: 'click e1', plan: plan('click e2', 'click e3') },
        { choice: 'done', goalMet: 0.95 },
      ]),
      { goal: 'press' },
    );
    expect(navigating.actions.map((action) => (action as { ref: string }).ref)).toEqual([
      'e1',
      'e2',
    ]);
  });

  it('drops every follow-up when the model says the plan may need the person', async () => {
    const target = new Keypad((pressed) => keypad(String(pressed.length)));
    await run(
      target,
      new FakeDecider([
        { choice: 'click e1', plan: plan('click e2', 'click e3'), planNeedsOwner: 0.4 },
        { choice: 'done', goalMet: 0.95 },
      ]),
      { goal: 'press' },
    );
    expect(target.actions).toHaveLength(1);
  });

  it('a decided action confirmed only by a low-confidence retry carries no plan', async () => {
    const target = new Keypad((pressed) => keypad(String(pressed.length)));
    await run(
      target,
      new FakeDecider([
        { choice: 'click e1', confidence: 0.1, plan: plan('click e2') },
        { choice: 'click e1', confidence: 0.1, plan: plan('click e2') },
        { choice: 'done', goalMet: 0.95 },
      ]),
      { goal: 'press' },
    );
    expect(target.actions).toEqual([{ kind: 'click', ref: 'e1' }]);
  });

  it('types and then submits from one plan, the submit offered only once the fresh page shows the typing', async () => {
    const field = (value?: string): ReturnType<typeof el> =>
      el('e1', {
        kind: 'fill',
        tag: 'input',
        type: 'search',
        label: 'Search',
        ...(value ? { value } : {}),
      });
    const target = new Keypad((pressed) =>
      page(URL, [field(pressed.length ? 'shoes' : undefined), el('e2')]),
    );
    const decider = new FakeDecider([
      { choice: 'type e1 query', plan: plan('submit e1') },
      { choice: 'done', goalMet: 0.95 },
    ]);
    await run(target, decider, { goal: 'search', values: { query: 'shoes' } });
    expect(target.actions).toEqual([
      { kind: 'type', ref: 'e1', text: 'shoes' },
      { kind: 'submit', ref: 'e1' },
    ]);
  });
});

describe('plan: every code guard applies to a planned action exactly as to a decided one', () => {
  const twoStep = (
    second: ReturnType<typeof el>,
    outcome?: (action: TargetAction) => ActOutcome,
  ): Keypad => {
    const target = new Keypad(
      (pressed) => page(URL, [el('e1'), second], String(pressed.length)),
      outcome,
    );
    return target;
  };
  const decide = (second: string): FakeDecider =>
    new FakeDecider([
      { choice: 'click e1', plan: plan(second) },
      { choice: 'done', goalMet: 0.95 },
    ]);

  it('a link off the site stops for the owner, never clicked', async () => {
    const target = twoStep(
      el('e2', { tag: 'a', href: 'https://other.example.net/x', label: 'Partner' }),
    );
    const result = await run(target, decide('click e2'), { goal: 'go' });
    expect(result.status).toBe('needs_owner');
    expect(result.reason).toBe('owner_must_decide');
    expect(target.actions).toEqual([{ kind: 'click', ref: 'e1' }]);
  });

  it('a same-site checkout link stops for the owner, never clicked', async () => {
    const target = twoStep(
      el('e2', { tag: 'a', href: 'https://shop.example.com/checkout', label: 'Pay' }),
    );
    const result = await run(target, decide('click e2'), { goal: 'go' });
    expect(result.status).toBe('needs_owner');
    expect(target.actions).toHaveLength(1);
  });

  it("an app's typed owner signal stops for the owner, never pressed", async () => {
    const target = twoStep(el('e2', { ownerSignal: 'default button of a sheet' }));
    const result = await run(target, decide('click e2'), { goal: 'go' });
    expect(result.status).toBe('needs_owner');
    expect(target.actions).toHaveLength(1);
  });

  it('a planned Enter into a form that sends to another site stops for the owner; the value is never sent', async () => {
    const field = el('e1', {
      kind: 'fill',
      tag: 'input',
      type: 'search',
      label: 'Search',
      formAction: 'https://collector.example.net/q',
    });
    const target = new Keypad((pressed) =>
      page(URL, [
        pressed.some((action) => action.kind === 'type') ? { ...field, value: 'shoes' } : field,
      ]),
    );
    const decider = new FakeDecider([
      { choice: 'type e1 query', plan: plan('submit e1') },
      { choice: 'done', goalMet: 0.95 },
    ]);
    const result = await run(target, decider, {
      goal: 'search',
      startUrl: URL,
      values: { query: 'shoes' },
    });
    expect(result.status).toBe('needs_owner');
    expect(result.reason).toBe('form_leaves_site');
    expect(target.actions.filter((action) => action.kind !== 'navigate')).toEqual([
      { kind: 'type', ref: 'e1', text: 'shoes' },
    ]);
  });

  it('needs real input stops the task, whatever the plan says next', async () => {
    const target = twoStep(el('e2'), (action) =>
      (action as { ref?: string }).ref === 'e2'
        ? { ok: false, error: 'only a real click', needsRealInput: true }
        : { ok: true },
    );
    const decider = new FakeDecider([
      { choice: 'click e1', plan: plan('click e2', 'click e1') },
      { choice: 'done', goalMet: 0.95 },
    ]);
    const result = await run(target, decider, { goal: 'go' });
    expect(result.status).toBe('needs_input');
    expect(result.reason).toBe('real_input_required');
    expect(target.actions).toHaveLength(2);
  });

  it('a field that became secret is never touched by a plan', async () => {
    const target = new Keypad((pressed) =>
      page(URL, [
        el('e1'),
        el('e2', {
          kind: 'fill',
          tag: 'input',
          type: 'text',
          ...(pressed.length ? { secret: true } : {}),
        }),
      ]),
    );
    const decider = new FakeDecider([
      { choice: 'click e1', plan: plan('type e2 name') },
      { choice: 'done', goalMet: 0.95 },
    ]);
    await run(target, decider, { goal: 'fill', values: { name: 'Ada' } });
    expect(target.actions).toEqual([{ kind: 'click', ref: 'e1' }]);
  });

  it('types only a supplied value, read from values when acting; an unknown name is never typed', async () => {
    const field = el('e2', { kind: 'fill', tag: 'input', type: 'text', label: 'Name' });
    const target = new Keypad(() => page(URL, [el('e1'), field]));
    const decider = new FakeDecider([
      { choice: 'click e1', plan: plan('type e2 nickname') },
      { choice: 'done', goalMet: 0.95 },
    ]);
    await run(target, decider, { goal: 'fill', values: { name: 'Ada' } });
    expect(target.actions).toEqual([{ kind: 'click', ref: 'e1' }]);

    const typed = new Keypad(() => page(URL, [el('e1'), field]));
    await run(
      typed,
      new FakeDecider([
        { choice: 'click e1', plan: plan('type e2 name') },
        { choice: 'done', goalMet: 0.95 },
      ]),
      { goal: 'fill', values: { name: 'Ada' } },
    );
    expect(typed.actions).toEqual([
      { kind: 'click', ref: 'e1' },
      { kind: 'type', ref: 'e2', text: 'Ada' },
    ]);
  });

  it('a planned action runs only when the fresh page offers it: a field that already holds the value is not typed again', async () => {
    // e1 fills the field itself (an autofill button); the planned typing is then no longer offered (offers.ts).
    const target = new Keypad((pressed) =>
      page(URL, [
        el('e1'),
        el('e2', {
          kind: 'fill',
          tag: 'input',
          type: 'text',
          label: 'Name',
          ...(pressed.length ? { value: 'Ada' } : {}),
        }),
      ]),
    );
    const decider = new FakeDecider([
      { choice: 'click e1', plan: plan('type e2 name') },
      { choice: 'done', goalMet: 0.95 },
    ]);
    const result = await run(target, decider, { goal: 'fill', values: { name: 'Ada' } });
    expect(target.actions).toEqual([{ kind: 'click', ref: 'e1' }]);
    expect(
      result.trace.some((step) => step.note?.includes('is not offered on the fresh page')),
    ).toBe(true);
  });

  it('a plan never takes an action it already has: going back to one ends it', async () => {
    const target = new Keypad(() => page(URL, [el('e1'), el('e2')], 'same'));
    const decider = new FakeDecider([
      { choice: 'click e1', plan: plan('click e2', 'click e1', 'click e2') },
      { choice: 'done', goalMet: 0.95 },
    ]);
    const result = await run(target, decider, { goal: 'press 1 then 2' });
    expect(target.actions).toEqual([
      { kind: 'click', ref: 'e1' },
      { kind: 'click', ref: 'e2' },
    ]);
    expect(result.trace[0]?.note).toContain('went back to click e1');
  });

  it('the repeat guard counts planned actions: a planned action that is the third same one on an unchanged page stops', async () => {
    // A plan cannot repeat inside itself, but the history before it can: e1 decided twice, then decided e2 plans e1.
    const target = new Keypad(() => page(URL, [el('e1'), el('e2')], 'same'));
    await run(
      target,
      new FakeDecider([
        { choice: 'click e1' },
        { choice: 'click e1' },
        { choice: 'click e2', plan: plan('click e1') },
      ]),
      { goal: 'press' },
    );
    // e1, e1, e2 and then the planned e1: not three in a row, so it runs; the next decided e1 is the guard's.
    expect(target.actions.slice(0, 4).map((action) => ('ref' in action ? action.ref : ''))).toEqual(
      ['e1', 'e1', 'e2', 'e1'],
    );
  });

  it('a plan cannot name a stop, a scroll or anything outside the offers', () => {
    const offers = buildOffers(page(URL, [el('e1'), el('e2')]), {
      values: {},
      lastTyped: null,
      canGoBack: false,
    });
    const ask = planQuestions(offers, 3);
    expect([...ask.conditions.entries()]).toEqual([
      ['click e1', 'after_1'],
      ['click e2', 'after_2'],
    ]);
    const options = Object.keys(
      (ask.questions['after_1'] as { criteria: Record<string, string> }).criteria,
    );
    expect(options.sort()).toEqual(['click e1', 'click e2', 'look']);
    for (const choice of ['done', 'ask_owner', 'scroll_down', 'click e9', 'back']) {
      const read = readPlan(
        { after_1: { type: 'choice', choice, confidence: 0.99, probabilities: {} } },
        offers,
        ask,
        'click e1',
        3,
      );
      expect(read.steps, choice).toEqual([]);
    }
  });

  it('a big page asks the follow-up only after its fields, with no option descriptions', () => {
    const elements = Array.from({ length: 40 }, (_, index) => el(`e${String(index + 1)}`));
    const offers = buildOffers(
      page(URL, [
        ...elements,
        {
          ...el('e41'),
          role: 'textbox',
          kind: 'fill',
          tag: 'input',
          type: 'text',
          label: 'Search',
        },
      ]),
      { values: { query: 'x' }, lastTyped: null, canGoBack: false },
    );
    const ask = planQuestions(offers, 6);
    expect([...ask.conditions.keys()]).toEqual(['type e41 query']);
    const criteria = (ask.questions['after_1'] as { criteria: Record<string, string> }).criteria;
    expect(criteria['click e1']).toBe('');
    expect(criteria).toHaveProperty('submit e41');
  });
});

describe('values read in code from the line the confirming decision points at', () => {
  const schema = {
    type: 'object',
    properties: { display: { type: 'string' }, total: { type: 'number' } },
    required: ['display', 'total'],
  };

  it('reads every field from its line and makes no extract call', async () => {
    const target = new FakeTarget([page(URL, [el('e1')], 'Calculator\n54\nTotal\n1,234.5')]);
    const decider = new FakeDecider([
      {
        choice: 'done',
        goalMet: 0.95,
        values: [
          ['54', 0.9],
          ['1,234.5', 0.8],
        ],
      },
    ]);
    const result = await run(target, decider, { goal: 'read it', want: { data: schema } });
    expect(result.status).toBe('done');
    expect(result.data).toEqual({ display: '54', total: 1234.5 });
    expect(decider.extracted).toHaveLength(0);
    expect(result.stats.modelCalls).toBe(1);
    // Each field is a choice whose options are the page's lines; the page text in the state is left as it was.
    expect(decider.judged[0]?.state).toContain('Page text (data):\nCalculator 54 Total 1,234.5\n');
    expect(decider.judged[0]?.state).not.toContain('[t');
    const value = decider.judged[0]?.questions['value_1'] as { criteria: Record<string, string> };
    expect(Object.keys(value.criteria).sort()).toEqual(
      ['1,234.5', '54', 'Calculator', NONE, 'Total'].sort(),
    );
  });

  for (const [name, values] of [
    [
      'a field has no single line',
      [
        ['54', 0.9],
        [NONE, 0.9],
      ],
    ],
    [
      'a pointer is unsure',
      [
        ['54', 0.9],
        ['1,234.5', 0.3],
      ],
    ],
    [
      'a number field points at a line that is not only a number',
      [
        ['54', 0.9],
        ['Total 12', 0.9],
      ],
    ],
  ] as const) {
    it(`falls back to the extract when ${name}`, async () => {
      const target = new FakeTarget([page(URL, [el('e1')], 'Calculator\n54\nTotal 12\n1,234.5')]);
      const decider = new FakeDecider([{ choice: 'done', goalMet: 0.95, values }], undefined, {
        display: '54',
        total: 1234.5,
      });
      const result = await run(target, decider, { goal: 'read it', want: { data: schema } });
      expect(decider.extracted).toHaveLength(1);
      expect(result.data).toEqual({ display: '54', total: 1234.5 });
    });
  }

  it('a nested schema is never read from lines', () => {
    expect(pointerFields({ type: 'object', properties: { a: { type: 'object' } } })).toBeNull();
    expect(pointerFields({ type: 'object', properties: { a: { type: 'boolean' } } })).toBeNull();
    expect(pointerFields({ type: 'array' })).toBeNull();
  });

  it('numbers only lines short enough to be one value, and parses numbers by their grammar only', () => {
    const numbered = numberText(`short\n${'x'.repeat(300)}\n42\nshort\n${NONE}`, 2500);
    expect(numbered.lines).toEqual({ short: 'short', '42': '42' });
    const fields = [{ name: 'n', type: 'integer' as const }];
    const answer = (choice: string): Record<string, DecideAnswer> => ({
      value_1: { type: 'choice' as const, choice, confidence: 0.9, probabilities: {} },
    });
    expect(readValues(answer('42'), fields, numbered)).toEqual({ n: 42 });
    expect(readValues(answer('short'), fields, numbered)).toBeNull();
    expect(readValues(answer('4.5'), fields, numberText('4.5', 100))).toBeNull();
    // An answer that is not one of the lines is never read.
    expect(readValues(answer('43'), fields, numbered)).toBeNull();
  });

  it('drops invisible direction marks from a line (an app display reads U+200E then 54)', () => {
    const numbered = numberText('\u200e54', 2500);
    expect(numbered.lines).toEqual({ '54': '54' });
  });

  it('a line holding a caller value is offered masked and read back as the page shows it', () => {
    const numbered = numberText('Results for Ada Lovelace\n1815', 2500, { query: 'Ada Lovelace' });
    expect(Object.keys(numbered.lines).sort()).toEqual(['1815', 'Results for ⟨value query⟩']);
    const answer = {
      value_1: {
        type: 'choice' as const,
        choice: 'Results for ⟨value query⟩',
        confidence: 0.9,
        probabilities: {},
      },
    };
    expect(readValues(answer, [{ name: 'heading', type: 'string' }], numbered)).toEqual({
      heading: 'Results for Ada Lovelace',
    });
  });
});

describe('the extract started beside the decision that is likely the last', () => {
  const data = { type: 'object', properties: { price: { type: 'number' } } };

  it('starts the extract before the first decision when the triage says the start page answers the goal', async () => {
    const target = new FakeTarget([page(URL, [el('e1')], 'A product\nPrice 42 EUR')]);
    const decider = new FakeDecider([{ choice: 'done', goalMet: 0.95, values: [[NONE, 0.9]] }]);
    decider.startPage = true;
    let release: () => void = () => undefined;
    decider.extractGate = new Promise((resolve) => {
      release = resolve;
    });
    const running = run(target, decider, { goal: 'get the price', startUrl: URL, want: { data } });
    // The decision is asked while the extract is still running.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(decider.extracted).toHaveLength(1);
    expect(decider.judged).toHaveLength(1);
    release();
    const result = await running;
    expect(result.status).toBe('done');
    expect(result.data).toEqual({ price: 42 });
    expect(decider.extracted).toHaveLength(1);
    expect(decider.triaged).toHaveLength(1);
    expect(result.stats).toMatchObject({ modelCalls: 3, unusedCalls: 0 });
    expect(result.trace.find((step) => step.action === 'extract')?.note).toContain('beside');
    // The extract read the page before the marks were drawn: its screenshot comes first and carries no marks.
    expect(target.shots[0]?.marks).toBeUndefined();
    expect(target.shots[1]?.marks?.length).toBe(1);
  });

  it('drops the early extract when the decision acts instead, and counts it unused', async () => {
    const target = new FakeTarget([
      page(URL, [el('e1')], 'Home'),
      page(`${URL}/p`, [el('e1')], 'Product\n42'),
    ]);
    const decider = new FakeDecider([
      { choice: 'click e1' },
      { choice: 'done', goalMet: 0.95, values: [[NONE, 0.9]] },
    ]);
    decider.startPage = true;
    const result = await run(target, decider, {
      goal: 'get the price',
      startUrl: URL,
      want: { data },
    });
    expect(result.status).toBe('done');
    // One early (unused) and one after the confirming decision.
    expect(decider.extracted).toHaveLength(2);
    expect(result.stats.unusedCalls).toBe(1);
  });

  it('starts it beside the decision after a plan that expected the goal met', async () => {
    const target = new Keypad((pressed) => keypad(String(pressed.length)));
    const decider = new FakeDecider([
      { choice: 'click e1', plan: plan('click e2', 'look'), doneAfter: 0.9 },
      { choice: 'done', goalMet: 0.95, values: [[NONE, 0.9]] },
    ]);
    const result = await run(target, decider, { goal: 'press', want: { data } });
    expect(result.status).toBe('done');
    expect(decider.extracted).toHaveLength(1);
    expect(result.trace.find((step) => step.action === 'extract')?.note).toContain('beside');
  });

  it('without a likely end the extract waits for the decision, as before', async () => {
    const target = new FakeTarget([page(URL, [el('e1')], 'x')]);
    const decider = new FakeDecider([{ choice: 'done', goalMet: 0.95, values: [[NONE, 0.9]] }]);
    const result = await run(target, decider, {
      goal: 'get the price',
      startUrl: URL,
      want: { data },
    });
    expect(result.trace.find((step) => step.action === 'extract')?.note).toBeUndefined();
    expect(result.stats.unusedCalls).toBe(0);
  });
});
