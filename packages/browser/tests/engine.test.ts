import { describe, expect, it } from 'vitest';
import { DecideError } from '../src/engine/decider.js';
import { runTask } from '../src/engine/task.js';
import { el, FakeDecider, FakeTarget, page, saveShot } from './helpers.js';

const URL = 'https://shop.example.com/products';
const noSleep = (): Promise<void> => Promise.resolve();

function run(
  target: FakeTarget,
  decider: FakeDecider,
  input: Parameters<typeof runTask>[1],
  settings = {},
): ReturnType<typeof runTask> {
  return runTask({ target, decider, saveShot, sleep: noSleep, settings }, input);
}

describe('step engine: one decide call per step', () => {
  it('asks next_action, goal_met, needs_owner and page_ready together, with the marked screenshot attached', async () => {
    const target = new FakeTarget([page(URL, [el('e1'), el('e2', { offscreen: true })])]);
    const decider = new FakeDecider([{ choice: 'click e1' }, { choice: 'done', goalMet: 0.95 }]);
    const result = await run(target, decider, { goal: 'open the first product' });
    expect(result.status).toBe('done');
    expect(decider.judged).toHaveLength(2);
    const first = decider.judged[0];
    expect(Object.keys(first?.questions ?? {}).sort()).toEqual([
      'goal_met',
      'needs_owner',
      'next_action',
      'page_ready',
    ]);
    expect(first?.questions['goal_met']?.type).toBe('predicate');
    expect(first?.images?.[0]).toEqual({ url: 'data:image/jpeg;base64,AAAA', detail: 'auto' });
    // Only onscreen offered elements are drawn on the screenshot.
    expect(target.shots[0]?.marks?.map((element) => element.ref)).toEqual(['e1']);
    expect(target.actions).toEqual([{ kind: 'click', ref: 'e1' }]);
  });

  it('sends no image when vision is off', async () => {
    const target = new FakeTarget([page(URL, [el('e1')])]);
    const decider = new FakeDecider([{ choice: 'done', goalMet: 0.9 }]);
    await run(target, decider, { goal: 'look', vision: false });
    expect(decider.judged[0]?.images).toBeUndefined();
  });

  it('records every step in the trace with its rung and milliseconds, and extracts want.data at rung 2', async () => {
    const target = new FakeTarget([page(URL, [el('e1')])]);
    const decider = new FakeDecider([{ choice: 'click e1' }, { choice: 'done', goalMet: 0.9 }]);
    const result = await run(target, decider, {
      goal: 'get the price',
      startUrl: URL,
      want: { data: { type: 'object', properties: { price: { type: 'number' } } }, text: true },
    });
    expect(result.status).toBe('done');
    expect(result.data).toEqual({ price: 42 });
    expect(result.text).toContain('42 EUR');
    expect(result.trace.map((step) => [step.action, step.rung])).toEqual([
      [`navigate ${URL}`, 0],
      ['click e1', 1],
      ['done', 1],
      ['extract', 2],
    ]);
    for (const step of result.trace) {
      expect(typeof step.ms).toBe('number');
      expect(step.url).toBeTruthy();
    }
    expect(decider.extracted[0]?.schema).toEqual({
      type: 'object',
      properties: { price: { type: 'number' } },
    });
  });
});

describe('stop reasons', () => {
  it('needs_input when the model says a value was not supplied', async () => {
    const result = await run(
      new FakeTarget([page(URL, [el('e1', { kind: 'fill', tag: 'input', type: 'text' })])]),
      new FakeDecider([{ choice: 'need_value' }]),
      { goal: 'fill the form' },
    );
    expect(result.status).toBe('needs_input');
  });

  it("a low-confidence stop of the model's own (need_value, blocked) is re-decided, not taken (live python.org run, 2026-11-22)", async () => {
    for (const stop of ['need_value', 'blocked']) {
      const target = new FakeTarget([page(URL, [el('e1')])]);
      const decider = new FakeDecider([
        { choice: stop, confidence: 0.35 },
        { choice: 'click e1', confidence: 0.9 },
        { choice: 'done', goalMet: 0.9 },
      ]);
      const result = await run(target, decider, { goal: 'x y z' });
      expect(result.status, stop).toBe('done');
      expect(target.actions, stop).toEqual([{ kind: 'click', ref: 'e1' }]);
      expect(result.trace[0]?.note, stop).toContain('top:');
    }
  });

  it('tells the model which named value a field holds, never the value itself', async () => {
    const filled = el('e1', {
      kind: 'fill',
      tag: 'input',
      type: 'search',
      label: 'Search',
      value: 'asyncio',
    });
    const decider = new FakeDecider([{ choice: 'done', goalMet: 0.9 }]);
    await run(new FakeTarget([page(URL, [filled])]), decider, {
      goal: 'search',
      values: { query: 'asyncio' },
    });
    const element = decider.judged[0]?.state.split('Elements (data):')[1] ?? '';
    expect(element).toContain('[e1] button "Search" (holds the value query)');
    expect(element).not.toContain('asyncio');
  });

  it('numbers trace records by the step they belong to', async () => {
    const target = new FakeTarget([page(URL, [el('e1')]), page(`${URL}?2`, [el('e1')])]);
    const result = await run(
      target,
      new FakeDecider([{ choice: 'click e1' }, { choice: 'done', goalMet: 0.9 }]),
      { goal: 'x y z' },
    );
    expect(result.trace.map((step) => [step.step, step.action])).toEqual([
      [1, 'click e1'],
      [2, 'done'],
    ]);
  });

  it('needs_owner on ask_owner and on a high needs_owner answer, acting on nothing', async () => {
    const asked = new FakeTarget([page(URL, [el('e1')])]);
    expect(
      (await run(asked, new FakeDecider([{ choice: 'ask_owner' }]), { goal: 'pay' })).status,
    ).toBe('needs_owner');
    const judged = new FakeTarget([page(URL, [el('e1')])]);
    expect(
      (
        await run(judged, new FakeDecider([{ choice: 'click e1', needsOwner: 0.9 }]), {
          goal: 'pay',
        })
      ).status,
    ).toBe('needs_owner');
    expect(asked.actions).toEqual([]);
    expect(judged.actions).toEqual([]);
  });

  it('blocked on the model saying so, and on an answer outside the offered actions', async () => {
    expect(
      (
        await run(
          new FakeTarget([page(URL, [el('e1')])]),
          new FakeDecider([{ choice: 'blocked' }]),
          { goal: 'x y z' },
        )
      ).status,
    ).toBe('blocked');
    const target = new FakeTarget([page(URL, [el('e1')])]);
    const result = await run(target, new FakeDecider([{ choice: 'type e1 Robert' }]), {
      goal: 'x y z',
    });
    expect(result).toMatchObject({ status: 'blocked', reason: 'decision_outside_choices' });
    expect(target.actions).toEqual([]);
  });

  it('low_confidence after one retry on a fresh snapshot, with the top candidates and a screenshot', async () => {
    const target = new FakeTarget([page(URL, [el('e1'), el('e2')])]);
    const decider = new FakeDecider([
      {
        choice: 'click e2',
        confidence: 0.25,
        probabilities: { 'click e2': 0.25, 'click e1': 0.22 },
      },
      {
        choice: 'click e1',
        confidence: 0.3,
        probabilities: { 'click e1': 0.3, 'click e2': 0.28, done: 0.1 },
      },
    ]);
    const result = await run(target, decider, { goal: 'pick one' });
    expect(result.status).toBe('low_confidence');
    expect(target.snapshots).toBe(2);
    expect(decider.judged).toHaveLength(2);
    expect(result.candidates?.[0]).toMatchObject({ action: 'click e1', probability: 0.3 });
    expect(result.candidates?.[1]?.description).toContain('Button e2');
    expect(result.artifacts[0]?.label).toBe('final');
    expect(target.actions).toEqual([]);
  });

  it('acts when the low-confidence retry picks the same page action, but never takes a low-confidence stop that way', async () => {
    const target = new FakeTarget([page(URL, [el('e1'), el('e2')]), page(`${URL}?2`, [el('e1')])]);
    const decider = new FakeDecider([
      { choice: 'click e1', confidence: 0.22 },
      { choice: 'click e1', confidence: 0.2 },
      { choice: 'done', goalMet: 0.9 },
    ]);
    const result = await run(target, decider, { goal: 'pick one' });
    expect(result.status).toBe('done');
    expect(target.actions).toEqual([{ kind: 'click', ref: 'e1' }]);
    expect(result.trace[1]?.note).toContain('confirmed');
    for (const stop of ['need_value', 'blocked']) {
      const stopped = await run(
        new FakeTarget([page(URL, [el('e1')])]),
        new FakeDecider([{ choice: stop, confidence: 0.3 }]),
        { goal: 'x y z' },
      );
      expect(stopped.status, stop).toBe('low_confidence');
    }
  });

  it('acts when the retry is confident', async () => {
    const target = new FakeTarget([page(URL, [el('e1')])]);
    const decider = new FakeDecider([
      { choice: 'click e1', confidence: 0.2 },
      { choice: 'click e1', confidence: 0.9 },
      { choice: 'done', goalMet: 0.9 },
    ]);
    expect((await run(target, decider, { goal: 'pick one' })).status).toBe('done');
    expect(target.actions).toEqual([{ kind: 'click', ref: 'e1' }]);
  });

  it('budget when the step bound is reached', async () => {
    let n = 0;
    const pages = Array.from({ length: 10 }, () => page(`${URL}?p=${String(n++)}`, [el('e1')]));
    const result = await run(new FakeTarget(pages), new FakeDecider([{ choice: 'click e1' }]), {
      goal: 'keep going',
      maxSteps: 3,
    });
    expect(result).toMatchObject({ status: 'budget', reason: 'step_limit' });
    expect(result.stats.steps).toBe(3);
  });

  it('budget when the wall clock bound is passed', async () => {
    let clock = 0;
    const target = new FakeTarget([page(URL, [el('e1')])]);
    const decider = new FakeDecider([{ choice: 'wait' }]);
    const result = await runTask(
      { target, decider, saveShot, sleep: noSleep, now: () => (clock += 400) },
      { goal: 'keep going', wallMs: 1000 },
    );
    expect(result).toMatchObject({ status: 'budget', reason: 'time_limit' });
  });

  it('a decision that outlasts the wall clock is not acted on', async () => {
    let clock = 0;
    const target = new FakeTarget([page(URL, [el('e1')])]);
    const slow = new FakeDecider([{ choice: 'click e1' }]);
    const judge = slow.judge.bind(slow);
    slow.judge = (input) => {
      clock += 5_000; // the decide call itself takes 5 s of a 3 s budget
      return judge(input);
    };
    const result = await runTask(
      { target, decider: slow, saveShot, sleep: noSleep, now: () => clock },
      { goal: 'keep going', wallMs: 3_000 },
    );
    expect(result).toMatchObject({ status: 'budget', reason: 'time_limit' });
    expect(target.actions).toEqual([]);
  });

  it('decisions_unavailable when the decide service is down or missing; blocked on a bad request', async () => {
    for (const code of ['JEV_NOT_CONNECTED', 'JEV_UNAVAILABLE', 'NOT_FOUND']) {
      const result = await run(
        new FakeTarget([page(URL, [el('e1')])]),
        new FakeDecider([], new DecideError(code, 'down')),
        { goal: 'x y z' },
      );
      expect(result.status, code).toBe('decisions_unavailable');
    }
    const bad = await run(
      new FakeTarget([page(URL, [el('e1')])]),
      new FakeDecider([], new DecideError('JEV_BAD_REQUEST', 'bad')),
      { goal: 'x y z' },
    );
    expect(bad.status).toBe('blocked');
  });

  it('blocked after the same action on an unchanged page three times', async () => {
    const target = new FakeTarget([page(URL, [el('e1')])]);
    const result = await run(target, new FakeDecider([{ choice: 'click e1' }]), { goal: 'x y z' });
    expect(result).toMatchObject({ status: 'blocked', reason: 'no_progress' });
    expect(target.actions).toHaveLength(2);
  });

  it('waits (bounded) while the page is not ready', async () => {
    const target = new FakeTarget([page(URL, [el('e1')])]);
    const decider = new FakeDecider([
      { choice: 'click e1', pageReady: 0.1 },
      { choice: 'click e1', pageReady: 0.1 },
      { choice: 'click e1', pageReady: 0.1 },
      { choice: 'done', goalMet: 0.9 },
    ]);
    const result = await run(target, decider, { goal: 'x y z' });
    expect(result.trace.filter((step) => step.note === 'page not ready: waited')).toHaveLength(2);
    expect(target.actions).toEqual([{ kind: 'click', ref: 'e1' }]);
  });
});

describe('code guards (each removal must fail one of these)', () => {
  it('never offers a secret field, not even to click', async () => {
    const target = new FakeTarget([
      page(URL, [
        el('e1', { kind: 'fill', tag: 'input', type: 'email', role: 'textbox' }),
        el('e2', { kind: 'fill', tag: 'input', type: 'password', role: 'textbox', secret: true }),
        el('e3', {
          kind: 'fill',
          tag: 'input',
          type: 'text',
          role: 'textbox',
          secret: true,
          value: '(hidden)',
        }),
      ]),
    ]);
    const decider = new FakeDecider([{ choice: 'blocked' }]);
    await run(target, decider, {
      goal: 'sign in',
      values: { email: 'a@b.co', password: 'hunter2' },
    });
    const offered = Object.keys(
      (decider.judged[0]?.questions['next_action'] as { criteria: Record<string, string> })
        .criteria,
    );
    expect(offered).toContain('type e1 email');
    expect(offered.filter((action) => / e[23]\b/.test(action))).toEqual([]);
  });

  it('types only a caller-supplied value, and sends value names but never the values to the model', async () => {
    const field = el('e1', {
      kind: 'fill',
      tag: 'input',
      type: 'email',
      role: 'textbox',
      label: 'Email',
    });
    const target = new FakeTarget([page(URL, [field])]);
    const decider = new FakeDecider([
      { choice: 'type e1 email' },
      { choice: 'done', goalMet: 0.9 },
    ]);
    await run(target, decider, {
      goal: 'enter my email',
      values: { email: 'secret-person@example.org' },
    });
    expect(target.actions).toEqual([
      { kind: 'type', ref: 'e1', text: 'secret-person@example.org' },
    ]);
    const sent = JSON.stringify(decider.judged);
    expect(sent).toContain('email');
    expect(sent).not.toContain('secret-person@example.org');
  });

  it('offers no type action at all without values', async () => {
    const target = new FakeTarget([
      page(URL, [el('e1', { kind: 'fill', tag: 'input', type: 'text', role: 'textbox' })]),
    ]);
    const decider = new FakeDecider([{ choice: 'blocked' }]);
    await run(target, decider, { goal: 'search for shoes' });
    const offered = Object.keys(
      (decider.judged[0]?.questions['next_action'] as { criteria: Record<string, string> })
        .criteria,
    );
    expect(offered.some((action) => action.startsWith('type '))).toBe(false);
  });

  it.each([
    ['an off-site link', 'https://evil.example.net/login'],
    ['an OAuth link on the same site', 'https://shop.example.com/oauth/authorize?client=x'],
    ['a checkout link', 'https://shop.example.com/checkout'],
    ['a payment link', 'https://www.shop.example.com/account/payment'],
    ['an install link', 'https://shop.example.com/apps/install'],
  ])('stops with needs_owner instead of clicking %s', async (_name, href) => {
    const link = el('e1', { tag: 'a', role: 'link', label: 'Continue', href });
    const target = new FakeTarget([page(URL, [link])]);
    const result = await run(target, new FakeDecider([{ choice: 'click e1', confidence: 0.99 }]), {
      goal: 'continue',
    });
    expect(result).toMatchObject({
      status: 'needs_owner',
      reason: 'owner_must_decide',
      element: { ref: 'e1', href },
    });
    expect(target.actions).toEqual([]);
  });

  it('clicks a same-site link, a subdomain link and an allowed site', async () => {
    for (const [href, allowedSites] of [
      ['https://shop.example.com/products/2', []],
      ['https://www.shop.example.com/products/2', []],
      ['https://cdn.partner.org/guide', ['partner.org']],
    ] as const) {
      const target = new FakeTarget([page(URL, [el('e1', { tag: 'a', role: 'link', href })])]);
      await run(
        target,
        new FakeDecider([{ choice: 'click e1' }, { choice: 'done', goalMet: 0.9 }]),
        { goal: 'open it', allowedSites },
      );
      expect(target.actions, href).toEqual([{ kind: 'click', ref: 'e1' }]);
    }
  });
});
