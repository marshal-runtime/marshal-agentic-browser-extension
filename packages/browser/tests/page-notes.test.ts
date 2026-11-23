/**
 * Two engine findings from Marley's relay run of 2026-11-22 (zygstinct lane, marley-proof README):
 * 1. a loose want.data schema made OpenAI's structured output refuse the extract after the goal was met
 *    (`extract_failed`): the engine now sends the strict form (strict-schema.ts) and returns the caller's shape;
 * 2. a goal whose facts sit on two pages looped between them until step_limit: a page that shows part of the goal now
 *    gets its facts noted when the task moves on, and later decisions, the goal check and the extract see them.
 */
import { describe, expect, it } from 'vitest';
import { runTask } from '../src/engine/task.js';
import { loosenAnswer, strictSchema } from '../src/engine/strict-schema.js';
import { el, FakeDecider, FakeTarget, page, saveShot } from './helpers.js';

const noSleep = (): Promise<void> => Promise.resolve();
const ORDERS = 'https://shop.example.com/admin/orders';
const ANALYTICS = 'https://shop.example.com/admin/analytics';
const GOAL = 'how many orders today, and the top product';
const DATA = {
  type: 'object',
  properties: { orders: { type: 'integer' }, top: { type: 'string' } },
};

function run(
  target: FakeTarget,
  decider: FakeDecider,
  input: Partial<Parameters<typeof runTask>[1]> = {},
  settings = {},
): ReturnType<typeof runTask> {
  return runTask(
    { target, decider, saveShot, sleep: noSleep, settings },
    { goal: GOAL, want: { data: DATA }, ...input },
  );
}

const twoPages = (): FakeTarget =>
  new FakeTarget([
    page(ORDERS, [el('e1', { label: 'Analytics' })], 'Orders today\n17'),
    page(ANALYTICS, [el('e2', { label: 'Orders' })], 'Top product\nRed Mug\n42'),
  ]);

const noteCalls = (decider: FakeDecider): typeof decider.extracted =>
  decider.extracted.filter(
    (call) => Object.keys((call.schema as { properties: object }).properties).join() === 'facts',
  );

describe('strict want.data schema', () => {
  it('makes every object strict, an optional key nullable, and recurses into items, anyOf and $defs', () => {
    expect(
      strictSchema({
        type: 'object',
        properties: {
          name: { type: 'string' },
          size: { type: 'string', enum: ['S', 'M'] },
          price: { anyOf: [{ type: 'number' }, { type: 'string' }] },
          rows: {
            type: 'array',
            items: { type: 'object', properties: { sku: { type: 'string' } }, required: ['sku'] },
          },
        },
        required: ['name'],
        $defs: { tag: { type: 'object', properties: { label: { type: ['string'] } } } },
      }),
    ).toEqual({
      type: 'object',
      properties: {
        name: { type: 'string' },
        size: { type: ['string', 'null'], enum: ['S', 'M', null] },
        price: { anyOf: [{ anyOf: [{ type: 'number' }, { type: 'string' }] }, { type: 'null' }] },
        rows: {
          type: ['array', 'null'],
          items: {
            type: 'object',
            properties: { sku: { type: 'string' } },
            required: ['sku'],
            additionalProperties: false,
          },
        },
      },
      required: ['name', 'size', 'price', 'rows'],
      additionalProperties: false,
      $defs: {
        tag: {
          type: 'object',
          properties: { label: { type: ['string', 'null'] } },
          required: ['label'],
          additionalProperties: false,
        },
      },
    });
  });

  it('leaves a strict schema as it is, and a schema without properties alone', () => {
    const strict = {
      type: 'object',
      properties: { a: { type: 'string' }, b: { type: ['number', 'null'] } },
      required: ['a', 'b'],
      additionalProperties: false,
    };
    expect(strictSchema(strict)).toEqual(strict);
    expect(strictSchema({ type: 'string' })).toEqual({ type: 'string' });
  });

  it('loosenAnswer drops the nulls the strict form allowed for optional keys, keeps required ones and unknown keys', () => {
    const schema = {
      type: 'object',
      properties: {
        a: { type: 'string' },
        b: { type: 'string' },
        rows: { type: 'array', items: { type: 'object', properties: { x: { type: 'number' } } } },
      },
      required: ['a'],
    };
    expect(
      loosenAnswer({ a: null, b: null, rows: [{ x: null }, { x: 1 }], extra: null }, schema),
    ).toEqual({ a: null, rows: [{}, { x: 1 }], extra: null });
  });

  it('the engine extracts with the strict form and returns the caller its own shape', async () => {
    const target = new FakeTarget([page(ORDERS, [el('e1')], 'Orders today: seventeen')]);
    const decider = new FakeDecider([{ choice: 'done', goalMet: 0.95 }], undefined, {
      orders: 17,
      top: null,
    });
    const result = await run(target, decider);
    expect(result.status).toBe('done');
    const schema = decider.extracted.at(-1)?.schema as Record<string, unknown>;
    expect(schema['additionalProperties']).toBe(false);
    expect(schema['required']).toEqual(['orders', 'top']);
    expect(result.data).toEqual({ orders: 17 });
  });
});

describe('page notes: a goal whose facts sit on two pages', () => {
  it('notes the first page when the task moves on, and the second decision, goal check and extract see it', async () => {
    const target = twoPages();
    const decider = new FakeDecider(
      [
        { choice: 'click e1', goalMet: 0.2, pagePart: 0.9 },
        // Pointers that would read the wrong orders from this page (42): with notes the extract answers instead.
        {
          choice: 'done',
          goalMet: 0.95,
          values: [
            ['42', 0.9],
            ['Red Mug', 0.9],
          ],
        },
      ],
      undefined,
      { orders: 17, top: 'Red Mug' },
    );
    decider.noteAnswer = { facts: 'Orders today: 17' };
    const result = await run(target, decider);
    expect(result.status).toBe('done');
    expect(result.data).toEqual({ orders: 17, top: 'Red Mug' });
    expect(noteCalls(decider)).toHaveLength(1);
    // The page text the decision read (whitespace folded).
    expect(noteCalls(decider)[0]?.context).toContain('Orders today 17');
    const second = decider.judged[1];
    expect(second?.state).toContain('Read on earlier pages');
    expect(second?.state).toContain(`${ORDERS}: Orders today: 17`);
    expect(second?.questions['goal_met']?.instructions).toContain('earlier pages');
    expect(decider.judged[0]?.questions['goal_met']?.instructions).not.toContain('earlier pages');
    const final = decider.extracted.at(-1);
    expect(final?.context).toContain('Orders today: 17');
    expect(final?.question).toContain('earlier pages');
    expect(result.trace.map((step) => step.action)).toContain('note');
    expect(result.stats.modelCalls).toBe(4);
  });

  it('a page that shows none of the goal is not noted', async () => {
    const decider = new FakeDecider([
      { choice: 'click e1', goalMet: 0.1, pagePart: 0.2 },
      { choice: 'done', goalMet: 0.95 },
    ]);
    const result = await run(twoPages(), decider);
    expect(result.status).toBe('done');
    expect(noteCalls(decider)).toHaveLength(0);
    expect(decider.judged[1]?.state).not.toContain('Read on earlier pages');
  });

  it('pageNotes:false asks no page_part and notes nothing', async () => {
    const decider = new FakeDecider([
      { choice: 'click e1', goalMet: 0.2, pagePart: 0.9 },
      { choice: 'done', goalMet: 0.95 },
    ]);
    await run(twoPages(), decider, {}, { pageNotes: false });
    expect(decider.judged[0]?.questions['page_part']).toBeUndefined();
    expect(noteCalls(decider)).toHaveLength(0);
  });

  it('notes one page once, however often the task comes back to it', async () => {
    const target = new FakeTarget([
      page(ORDERS, [el('e1')], 'Orders today\n17'),
      page(ANALYTICS, [el('e2')], 'Top product\nRed Mug'),
      page(ORDERS, [el('e1')], 'Orders today\n17'),
      page(ANALYTICS, [el('e2')], 'Top product\nRed Mug'),
    ]);
    const decider = new FakeDecider([
      { choice: 'click e1', goalMet: 0.2, pagePart: 0.9 },
      { choice: 'click e2', goalMet: 0.2, pagePart: 0.9 },
      { choice: 'click e1', goalMet: 0.2, pagePart: 0.9 },
      { choice: 'done', goalMet: 0.95 },
    ]);
    decider.noteAnswer = { facts: 'something' };
    await run(target, decider);
    expect(noteCalls(decider)).toHaveLength(2);
  });

  it('a failed note is traced and the task carries on without it', async () => {
    const decider = new FakeDecider([
      { choice: 'click e1', goalMet: 0.2, pagePart: 0.9 },
      { choice: 'done', goalMet: 0.95 },
    ]);
    decider.noteAnswer = new Error('model down');
    const result = await run(twoPages(), decider);
    expect(result.status).toBe('done');
    const note = result.trace.find((step) => step.action === 'note');
    expect(note?.outcome).toBe('failed');
    expect(note?.note).toBe('model down');
    expect(decider.judged[1]?.state).not.toContain('Read on earlier pages');
  });

  it('an early extract that did not see a later note is not used', async () => {
    const target = new FakeTarget([page(ORDERS, [el('e1')], 'Orders today\n17')]);
    const decider = new FakeDecider([
      // A weak pick is re-decided on the same page; the note of this page is kept meanwhile.
      { choice: 'click e1', confidence: 0.1, goalMet: 0.2, pagePart: 0.9 },
      { choice: 'done', goalMet: 0.95 },
    ]);
    decider.noteAnswer = { facts: 'Orders today: 17' };
    // The caller's triage says the start page answers, so the extract starts beside the first decision.
    const result = await run(target, decider, { startPageAnswers: true });
    expect(result.status).toBe('done');
    const data = decider.extracted.filter((call) => !noteCalls(decider).includes(call));
    // The one beside the first decision, and a fresh one that sees the note.
    expect(data).toHaveLength(2);
    expect(data[0]?.context).not.toContain('Read on earlier pages');
    expect(data[1]?.context).toContain('Read on earlier pages');
    expect(result.stats.unusedCalls).toBe(1);
  });
});

describe('loop guard: the same move between two pages again with nothing new read', () => {
  const back = (): FakeTarget =>
    new FakeTarget([
      page(ORDERS, [el('e1')], 'Orders today\n17'),
      page(ANALYTICS, [el('e2')], 'Top product\nRed Mug'),
      page(ORDERS, [el('e1')], 'Orders today\n17'),
      page(ANALYTICS, [el('e2')], 'Top product\nRed Mug'),
      page(ORDERS, [el('e1')], 'Orders today\n17'),
    ]);

  it('stops as blocked / page_loop at the repeated move instead of running to step_limit', async () => {
    const decider = new FakeDecider([
      { choice: 'click e1', goalMet: 0.2 },
      { choice: 'click e2', goalMet: 0.2 },
      { choice: 'click e1', goalMet: 0.2 },
      { choice: 'click e2', goalMet: 0.2 },
    ]);
    const result = await run(back(), decider);
    expect(result.status).toBe('blocked');
    expect(result.reason).toMatch(/^page_loop: back and forth between .*orders and .*analytics/);
    // Orders, Analytics, Orders decided; the second arrival at Analytics stops before its decision.
    expect(decider.judged).toHaveLength(3);
    expect(result.trace.at(-1)).toMatchObject({ action: 'loop', outcome: 'stop' });
  });

  it('a new fact read since the first move is progress: no stop', async () => {
    const decider = new FakeDecider([
      { choice: 'click e1', goalMet: 0.2 },
      { choice: 'click e2', goalMet: 0.2, pagePart: 0.9 },
      { choice: 'click e1', goalMet: 0.2 },
      { choice: 'done', goalMet: 0.95 },
    ]);
    decider.noteAnswer = { facts: 'Top product: Red Mug' };
    const result = await run(back(), decider);
    expect(result.status).toBe('done');
  });

  it('a fragment change is not a move, and list -> item -> list -> another item is no loop', async () => {
    const LIST = 'https://shop.example.com/products';
    const target = new FakeTarget([
      page(LIST, [el('e1')], 'list'),
      page(`${LIST}#reviews`, [el('e1')], 'list'),
      page(LIST, [el('e1')], 'list'),
      page(`${LIST}#reviews`, [el('e1')], 'list'),
      page(`${LIST}/1`, [el('e1')], 'item 1'),
      page(LIST, [el('e1')], 'list'),
      page(`${LIST}/2`, [el('e1')], 'item 2'),
    ]);
    const decider = new FakeDecider([
      { choice: 'click e1', goalMet: 0.2 },
      { choice: 'click e1', goalMet: 0.2 },
      { choice: 'click e1', goalMet: 0.2 },
      { choice: 'click e1', goalMet: 0.2 },
      { choice: 'click e1', goalMet: 0.2 },
      { choice: 'click e1', goalMet: 0.2 },
      { choice: 'done', goalMet: 0.95 },
    ]);
    const result = await run(target, decider);
    expect(result.status).toBe('done');
  });
});
