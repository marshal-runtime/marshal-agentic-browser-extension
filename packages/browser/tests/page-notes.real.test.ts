/**
 * The two-page goal of Marley's relay run, end to end in a real Chrome through the embedding entry (activateEmbedded,
 * browser.task, a scripted decide function): the first page's facts are noted and the second page's decision sees them,
 * and with nothing new read the back-and-forth stops as page_loop. Skipped, with a notice, when no Chrome is installed.
 */
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { findChrome } from '../src/chrome/launcher.js';
import type { CapabilityProvider, DecideMultiInput, DecideSchemaInput } from '../src/contracts.js';
import { activateEmbedded } from '../src/extension.js';

const chrome = findChrome();
if (!chrome.path) console.warn(`[page-notes.real] SKIPPED: ${chrome.reason}`);

const PAGES: Record<string, string> = {
  '/orders':
    '<title>Orders</title><h1>Orders today</h1><p>17</p><a href="/analytics">Analytics</a>',
  '/analytics':
    '<title>Analytics</title><h1>Top product</h1><p>Red Mug</p><a href="/orders">Orders</a>',
};
let server: http.Server;
let base = '';
const roots: string[] = [];

beforeAll(async () => {
  server = http.createServer((request, response) => {
    const body = PAGES[new URL(request.url ?? '/', 'http://x').pathname];
    response.writeHead(body ? 200 : 404, { 'content-type': 'text/html' });
    response.end(body ? `<!doctype html><html><body>${body}</body></html>` : 'no');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${String((server.address() as { port: number }).port)}`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true, maxRetries: 5 })));
});

/** The model, scripted: go to the other page; with notes on the analytics page, say done. */
function scripted(mode: 'notes' | 'loop'): {
  decide: (input: DecideMultiInput | DecideSchemaInput) => Promise<unknown>;
  states: string[];
} {
  const states: string[] = [];
  return {
    states,
    decide: (input) => {
      if ('questions' in input) {
        if (input.questions['start_page_answers'])
          return Promise.resolve({
            success: true,
            answers: { start_page_answers: { type: 'predicate', probability: 0.1 } },
          });
        states.push(input.state);
        const onOrders = input.state.includes('/orders (');
        const knows = input.state.includes('Read on earlier pages');
        const criteria = (input.questions['next_action'] as { criteria: Record<string, string> })
          .criteria;
        const link = onOrders ? 'Analytics' : 'Orders';
        const done = mode === 'notes' && !onOrders && knows;
        const choice = done
          ? 'done'
          : (Object.keys(criteria).find((key) => criteria[key]?.includes(`"${link}"`)) ??
            'blocked');
        return Promise.resolve({
          success: true,
          answers: {
            next_action: {
              type: 'choice',
              choice,
              confidence: 0.9,
              probabilities: { [choice]: 0.9 },
            },
            goal_met: { type: 'predicate', probability: done ? 0.95 : 0.1 },
            needs_owner: { type: 'predicate', probability: 0.02 },
            page_ready: { type: 'predicate', probability: 0.97 },
            page_part: { type: 'predicate', probability: mode === 'notes' ? 0.9 : 0.05 },
          },
        });
      }
      const properties = Object.keys((input.schema as { properties: object }).properties);
      if (properties.join() === 'facts')
        return Promise.resolve({
          success: true,
          choice: { facts: input.context.includes('Orders today 17') ? 'Orders today: 17' : '' },
        });
      return Promise.resolve({
        success: true,
        choice: {
          orders: input.context.includes('Orders today: 17') ? 17 : null,
          top: input.context.includes('Red Mug') ? 'Red Mug' : null,
        },
      });
    },
  };
}

async function task(mode: 'notes' | 'loop'): Promise<{
  output: Record<string, unknown>;
  states: string[];
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mbn-'));
  roots.push(root);
  const model = scripted(mode);
  const activation = await activateEmbedded({
    decide: model.decide,
    configuration: { artifactDir: root, tempRoot: path.join(root, 't'), vision: false },
  });
  try {
    const provider = activation.capabilityProviders?.[0] as CapabilityProvider;
    const output = (
      await provider.invoke(
        'browser.task',
        {
          goal: 'how many orders today, and the top product',
          startUrl: `${base}/orders`,
          on: 'managed',
          want: {
            data: {
              type: 'object',
              properties: { orders: { type: 'integer' }, top: { type: 'string' } },
            },
          },
          maxSteps: 10,
        },
        { principal: { id: 'test', kind: 'agent' } },
      )
    ).output as Record<string, unknown>;
    return { output, states: model.states };
  } finally {
    await activation.dispose?.();
  }
}

describe.skipIf(!chrome.path)('a goal whose facts sit on two pages, in a real Chrome', () => {
  it('notes the orders page and finishes on the analytics page with both facts', async () => {
    const { output, states } = await task('notes');
    expect(output).toMatchObject({ status: 'done', data: { orders: 17, top: 'Red Mug' } });
    expect(states).toHaveLength(2);
    expect(states[1]).toContain('Orders today: 17');
  }, 90_000);

  it('with nothing new read, the back-and-forth stops as page_loop well before step_limit', async () => {
    const { output, states } = await task('loop');
    expect(output['status']).toBe('blocked');
    expect(String(output['reason'])).toMatch(/^page_loop: /);
    expect(states).toHaveLength(3);
  }, 90_000);
});
