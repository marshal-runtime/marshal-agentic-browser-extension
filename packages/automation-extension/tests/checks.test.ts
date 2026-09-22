import { describe, expect, it } from 'vitest';
import { evaluateCheck } from '../src/checks.js';
import type { JevClient } from '../src/contracts.js';
import type { Check, PageSnapshot, RawSnapshotAction } from '../src/types.js';

const actions: readonly RawSnapshotAction[] = [
  { node: '1', role: 'textbox', label: 'Destination', kind: 'fill', value: 'Berlin' },
  { node: '2', role: 'button', label: 'Search', kind: 'click', value: '' },
];

function snapshot(overrides: Partial<PageSnapshot> = {}): PageSnapshot {
  return {
    url: 'https://example.com/search?q=berlin',
    title: 'Search results',
    w: 1024,
    h: 768,
    text: 'Showing results for Berlin flights',
    scroll: { y: 0, height: 2000 },
    actions,
    marker: ['m'],
    omittedActions: 0,
    ...overrides,
  };
}

function noulClient(noul: number): JevClient {
  return {
    status: async () => ({ state: 'connected', model: 'jev-latest' }),
    ask: async () => ({
      answers: { verdict: { type: 'noul', noul } },
      model: 'jev-latest',
      usage: { input_tokens: 1, output_tokens: 1 },
      latencyMs: 1,
    }),
  };
}

describe('evaluateCheck', () => {
  it('url_matches: passes on regex or substring match, judged by code', async () => {
    const check: Check = { kind: 'url_matches', pattern: 'search' };
    const result = await evaluateCheck(check, snapshot(), noulClient(0), undefined);
    expect(result).toMatchObject({ passed: true, judgedBy: 'code' });
  });

  it('url_matches: fails and reports a detail when the pattern does not match', async () => {
    const check: Check = { kind: 'url_matches', pattern: '^https://other\\.example' };
    const result = await evaluateCheck(check, snapshot(), noulClient(0), undefined);
    expect(result.passed).toBe(false);
    expect(result.detail).toContain('does not match');
  });

  it('text_visible: case-insensitive substring match', async () => {
    const check: Check = { kind: 'text_visible', text: 'berlin flights' };
    const result = await evaluateCheck(check, snapshot(), noulClient(0), undefined);
    expect(result).toMatchObject({ passed: true, judgedBy: 'code' });
  });

  it('element_present / element_absent match by label substring and optional role', async () => {
    const present: Check = { kind: 'element_present', label: 'Destination' };
    const absent: Check = { kind: 'element_absent', label: 'Nonexistent field' };
    await expect(
      evaluateCheck(present, snapshot(), noulClient(0), undefined),
    ).resolves.toMatchObject({ passed: true });
    await expect(
      evaluateCheck(absent, snapshot(), noulClient(0), undefined),
    ).resolves.toMatchObject({ passed: true });

    const wrongRole: Check = { kind: 'element_present', label: 'Destination', role: 'button' };
    await expect(
      evaluateCheck(wrongRole, snapshot(), noulClient(0), undefined),
    ).resolves.toMatchObject({ passed: false });
  });

  it('field_value: equals and contains against the current field value', async () => {
    const equalsPass: Check = { kind: 'field_value', label: 'Destination', equals: 'Berlin' };
    const equalsFail: Check = { kind: 'field_value', label: 'Destination', equals: 'Paris' };
    const containsPass: Check = { kind: 'field_value', label: 'Destination', contains: 'erl' };
    await expect(
      evaluateCheck(equalsPass, snapshot(), noulClient(0), undefined),
    ).resolves.toMatchObject({ passed: true });
    await expect(
      evaluateCheck(equalsFail, snapshot(), noulClient(0), undefined),
    ).resolves.toMatchObject({ passed: false });
    await expect(
      evaluateCheck(containsPass, snapshot(), noulClient(0), undefined),
    ).resolves.toMatchObject({ passed: true });
  });

  it('all: passes only when every sub-check passes, and surfaces the first failure detail', async () => {
    const allPass: Check = {
      kind: 'all',
      checks: [
        { kind: 'url_matches', pattern: 'search' },
        { kind: 'element_present', label: 'Search' },
      ],
    };
    const allFail: Check = {
      kind: 'all',
      checks: [
        { kind: 'url_matches', pattern: 'search' },
        { kind: 'element_present', label: 'Nope' },
      ],
    };
    await expect(
      evaluateCheck(allPass, snapshot(), noulClient(0), undefined),
    ).resolves.toMatchObject({ passed: true });
    const failed = await evaluateCheck(allFail, snapshot(), noulClient(0), undefined);
    expect(failed.passed).toBe(false);
    expect(failed.detail).toContain('Nope');
    expect(failed.children).toHaveLength(2);
  });

  it('jev_noul: passes at p >= 0.8 and is judged by the model', async () => {
    const check: Check = { kind: 'jev_noul', question: 'Did the search return flight results?' };
    await expect(
      evaluateCheck(check, snapshot(), noulClient(0.85), undefined),
    ).resolves.toMatchObject({
      passed: true,
      judgedBy: 'model',
    });
    await expect(
      evaluateCheck(check, snapshot(), noulClient(0.79), undefined),
    ).resolves.toMatchObject({
      passed: false,
      judgedBy: 'model',
    });
  });
});
