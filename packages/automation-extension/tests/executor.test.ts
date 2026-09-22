import { describe, expect, it } from 'vitest';
import { runSubgoal } from '../src/executor.js';
import { DomAdapter } from '../src/dom-adapter.js';
import type { PerceptionAdapter, ActResult, ScreenshotResult } from '../src/adapter.js';
import type {
  AgenticBrowserRuntimeHost,
  BrowserCommandResult,
  BrowserRequestContext,
  ChoiceAnswer,
  JevAskRequest,
  JevAskResult,
  JevClient,
} from '../src/contracts.js';
import type { PageSnapshot, RawSnapshotAction } from '../src/types.js';

function snap(marker: string, overrides: Partial<PageSnapshot> = {}): PageSnapshot {
  return {
    url: 'https://example.com/',
    title: 'Example',
    w: 1024,
    h: 768,
    text: 'hello',
    scroll: { y: 0, height: 1000 },
    actions: [{ node: '1', role: 'button', label: 'Submit', kind: 'click', value: '' }],
    marker: [marker],
    omittedActions: 0,
    ...overrides,
  };
}

interface RecordedCall {
  readonly name: 'snapshot' | 'act';
  readonly action?: RawSnapshotAction;
  readonly text?: string;
}

/** Fake DOM-shaped adapter: no `marker()` fast path, so the executor falls back to `snapshot().marker` for freshness checks. */
function makeAdapter(snapshots: readonly PageSnapshot[]): {
  adapter: PerceptionAdapter;
  calls: RecordedCall[];
} {
  let index = 0;
  const calls: RecordedCall[] = [];
  const adapter: PerceptionAdapter = {
    kind: 'dom',
    target: 'test',
    snapshot: async (): Promise<PageSnapshot> => {
      calls.push({ name: 'snapshot' });
      const data = snapshots[Math.min(index, snapshots.length - 1)];
      if (!data) throw new Error('makeAdapter: expected at least one queued snapshot');
      index++;
      return data;
    },
    act: async (action: RawSnapshotAction, text?: string): Promise<ActResult> => {
      calls.push({ name: 'act', action, text });
      return { ok: true };
    },
    fullText: async () => '',
    screenshot: async (): Promise<ScreenshotResult> => ({ data: '', mimeType: 'image/png' }),
  };
  return { adapter, calls };
}

type QueuedDecision = {
  operation: string;
  target?: string;
  confidence?: number;
  probabilities?: Record<string, number>;
};

function makeJevClient(decisions: readonly QueuedDecision[]): {
  client: JevClient;
  calls: JevAskRequest[];
} {
  let index = 0;
  const calls: JevAskRequest[] = [];
  const client: JevClient = {
    status: async () => ({ state: 'connected', model: 'jev-latest' }),
    ask: async (request) => {
      calls.push(request);
      const next = decisions[Math.min(index, decisions.length - 1)];
      if (!next) throw new Error('makeJevClient: expected at least one queued decision');
      index++;
      const answers: Record<string, ChoiceAnswer> = {
        operation: {
          choice: next.operation,
          probabilities: next.probabilities ?? { [next.operation]: 1 },
          confidence: next.confidence ?? 0.9,
        },
      };
      if (next.target !== undefined) {
        answers[`${next.operation.toLowerCase()}_target`] = {
          choice: next.target,
          probabilities: next.probabilities ?? { [next.target]: 1 },
          confidence: next.confidence ?? 0.9,
        };
      }
      const result: JevAskResult = {
        answers,
        model: 'jev-latest',
        usage: { input_tokens: 1, output_tokens: 1 },
        latencyMs: 1,
      };
      return result;
    },
  };
  return { client, calls };
}

describe('freshness circuit breaker (unstable marker()/snapshot() adapter)', () => {
  it('acts on the latest snapshot within <=3 freshness re-observes (never burns the Jev budget) and flags freshnessUnstable', async () => {
    const finalSnapshot = snap('X', {
      actions: [{ node: '1', role: 'button', label: 'Submit', kind: 'click', value: '' }],
    });
    let markerCalls = 0;
    const markerLog: string[] = [];
    const otherCalls: RecordedCall[] = [];
    const adapter: PerceptionAdapter = {
      kind: 'dom',
      target: 'test',
      snapshot: async (): Promise<PageSnapshot> => {
        otherCalls.push({ name: 'snapshot' });
        return finalSnapshot;
      },
      // Always disagrees with snapshot().marker (['X']) - simulates the
      // hybrid-adapter marker/snapshot mismatch that caused the 48-Jev-call,
      // 0-step run this circuit breaker was added to bound.
      marker: async (): Promise<readonly unknown[]> => {
        markerCalls++;
        const value = `unstable-${markerCalls}`;
        markerLog.push(value);
        return [value];
      },
      act: async (action: RawSnapshotAction, text?: string): Promise<ActResult> => {
        otherCalls.push({ name: 'act', action, text });
        return { ok: true };
      },
      fullText: async () => '',
      screenshot: async (): Promise<ScreenshotResult> => ({ data: '', mimeType: 'image/png' }),
    };
    const { client, calls: jevAskCalls } = makeJevClient([{ operation: 'CLICK', target: '1' }]);

    const result = await runSubgoal({
      adapter,
      jevClient: client,
      jevModel: undefined,
      goal: 'Click submit',
      values: undefined,
      check: undefined,
      maxSteps: 1,
    });

    // The breaker trips after 2 consecutive "changed" freshness re-observes
    // (never more) and the action is performed anyway.
    expect(markerCalls).toBeLessThanOrEqual(3);
    expect(result.freshnessRechecks).toBeLessThanOrEqual(3);
    expect(result.freshnessUnstable).toBe(true);
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0]).toMatchObject({ freshnessUnstable: true });
    expect(otherCalls.some((c) => c.name === 'act' && c.action?.kind === 'click')).toBe(true);
    // Jev is only ever called from decideNextAction, once per redecide cycle - bounded by the breaker, not 48.
    expect(jevAskCalls.length).toBeLessThanOrEqual(3);
    expect(result.jevCalls).toBeLessThanOrEqual(3);
  });
});

describe('runSubgoal (ported jev-ultrafast step loop)', () => {
  it('types the planner-supplied value for a TYPE_TEXT field and reports claimed_done with no check', async () => {
    const filled = snap('B', {
      actions: [
        { node: '1', role: 'textbox', label: 'Destination', kind: 'fill', value: 'Berlin' },
      ],
    });
    const { adapter, calls } = makeAdapter([
      snap('A', {
        actions: [{ node: '1', role: 'textbox', label: 'Destination', kind: 'fill', value: '' }],
      }), // initial
      snap('A', {
        actions: [{ node: '1', role: 'textbox', label: 'Destination', kind: 'fill', value: '' }],
      }), // freshness check (matches)
      filled, // after action
      filled, // DONE freshness check (matches)
    ]);
    const { client } = makeJevClient([
      { operation: 'TYPE_TEXT', target: '1' },
      { operation: 'DONE' },
    ]);

    const result = await runSubgoal({
      adapter,
      jevClient: client,
      jevModel: undefined,
      goal: 'Fill destination',
      values: { Destination: 'Berlin' },
      check: undefined,
      maxSteps: 10,
    });

    expect(result.status).toBe('claimed_done');
    expect(result.steps).toEqual([
      expect.objectContaining({
        op: 'TYPE_TEXT',
        target: 'Destination',
        text: 'Berlin',
        pageChanged: true,
      }),
    ]);
    expect(
      calls.some((c) => c.name === 'act' && c.action?.kind === 'fill' && c.text === 'Berlin'),
    ).toBe(true);
  });

  it('returns needs_value and never touches the browser when no value matches the field label', async () => {
    const { adapter, calls } = makeAdapter([
      snap('A', {
        actions: [{ node: '1', role: 'textbox', label: 'Destination', kind: 'fill', value: '' }],
      }),
    ]);
    const { client } = makeJevClient([{ operation: 'TYPE_TEXT', target: '1' }]);

    const result = await runSubgoal({
      adapter,
      jevClient: client,
      jevModel: undefined,
      goal: 'Fill destination',
      values: {},
      check: undefined,
      maxSteps: 10,
    });

    expect(result.status).toBe('needs_value');
    expect(result.missingField).toBe('Destination');
    expect(calls.some((c) => c.name === 'act')).toBe(false);
  });

  it('skips the action and re-decides when the page changed since the decision (freshness check)', async () => {
    const { adapter } = makeAdapter([
      snap('A'), // initial
      snap('B'), // freshness check before acting: page changed -> skip, re-decide on B
      snap('B'), // DONE freshness check: matches B
    ]);
    const { client, calls } = makeJevClient([
      { operation: 'CLICK', target: '1' },
      { operation: 'DONE' },
    ]);

    const result = await runSubgoal({
      adapter,
      jevClient: client,
      jevModel: undefined,
      goal: 'Click submit',
      values: undefined,
      check: undefined,
      maxSteps: 10,
    });

    expect(result.status).toBe('claimed_done');
    expect(result.steps).toHaveLength(0);
    expect(calls).toHaveLength(2);
  });

  it('retries a click once via {strategy: "js"} when the first attempt reports no page change, and uses the retry result', async () => {
    const unchanged = snap('A');
    const changedAfterRetry = snap('B');
    const { adapter, calls } = makeAdapter([
      unchanged, // initial
      unchanged, // freshness check before acting (matches)
      unchanged, // snapshot right after the native act() - no page change
      changedAfterRetry, // snapshot after the js-strategy retry act() - page changed
      changedAfterRetry, // DONE freshness check (matches)
    ]);
    const { client } = makeJevClient([{ operation: 'CLICK', target: '1' }, { operation: 'DONE' }]);

    const result = await runSubgoal({
      adapter,
      jevClient: client,
      jevModel: undefined,
      goal: 'Click search',
      values: undefined,
      check: undefined,
      maxSteps: 10,
    });

    expect(result.status).toBe('claimed_done');
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0]).toMatchObject({ pageChanged: true });
    const actCalls = calls.filter((c) => c.name === 'act');
    expect(actCalls).toHaveLength(2);
    expect(actCalls[0]?.action?.kind).toBe('click');
    expect(actCalls[1]?.action?.kind).toBe('click');
  });

  it('accepts a genuine no-op click after the single js-strategy retry also reports no page change', async () => {
    const unchanged = snap('A');
    const { adapter, calls } = makeAdapter([
      unchanged,
      unchanged,
      unchanged,
      unchanged,
      unchanged,
      unchanged,
      unchanged,
    ]);
    const { client } = makeJevClient([{ operation: 'CLICK', target: '1' }]);

    const result = await runSubgoal({
      adapter,
      jevClient: client,
      jevModel: undefined,
      goal: 'Click submit',
      values: undefined,
      check: undefined,
      maxSteps: 10,
    });

    expect(result.status).toBe('stuck');
    // Each stuck step performs a native act() plus one js-strategy retry act().
    expect(calls.filter((c) => c.name === 'act')).toHaveLength(6);
  });

  it('reports stuck after 3 consecutive actions with no page change', async () => {
    const unchanged = snap('A');
    const { adapter } = makeAdapter([
      unchanged,
      unchanged,
      unchanged,
      unchanged,
      unchanged,
      unchanged,
      unchanged,
    ]);
    const { client } = makeJevClient([{ operation: 'CLICK', target: '1' }]);

    const result = await runSubgoal({
      adapter,
      jevClient: client,
      jevModel: undefined,
      goal: 'Click submit',
      values: undefined,
      check: undefined,
      maxSteps: 10,
    });

    expect(result.status).toBe('stuck');
    expect(result.steps).toHaveLength(3);
    expect(result.steps.every((s) => s.pageChanged === false)).toBe(true);
  });

  it('evaluates the check on DONE and reports achieved when it passes', async () => {
    const done = snap('A', { url: 'https://example.com/thanks' });
    const { adapter } = makeAdapter([done, done]);
    const { client } = makeJevClient([{ operation: 'DONE' }]);

    const result = await runSubgoal({
      adapter,
      jevClient: client,
      jevModel: undefined,
      goal: 'Submit',
      values: undefined,
      check: { kind: 'url_matches', pattern: 'thanks' },
      maxSteps: 10,
    });

    expect(result.status).toBe('achieved');
    expect(result.check).toMatchObject({ passed: true, judgedBy: 'code' });
  });

  it('evaluates the check on DONE and reports check_failed when it fails', async () => {
    const done = snap('A', { url: 'https://example.com/still-here' });
    const { adapter } = makeAdapter([done, done]);
    const { client } = makeJevClient([{ operation: 'DONE' }]);

    const result = await runSubgoal({
      adapter,
      jevClient: client,
      jevModel: undefined,
      goal: 'Submit',
      values: undefined,
      check: { kind: 'url_matches', pattern: 'thanks' },
      maxSteps: 10,
    });

    expect(result.status).toBe('check_failed');
    expect(result.check).toMatchObject({ passed: false });
  });

  it('reports blocked when Jev chooses BLOCKED', async () => {
    const stable = snap('A');
    const { adapter } = makeAdapter([stable, stable]);
    const { client } = makeJevClient([{ operation: 'BLOCKED' }]);

    const result = await runSubgoal({
      adapter,
      jevClient: client,
      jevModel: undefined,
      goal: 'Do something irreversible',
      values: undefined,
      check: undefined,
      maxSteps: 10,
    });

    expect(result.status).toBe('blocked');
  });

  it('reports budget_exhausted when maxSteps is reached without a terminal decision', async () => {
    const changing = (n: number): PageSnapshot => snap(`v${n}`);
    const snapshots: PageSnapshot[] = [];
    for (let i = 0; i < 20; i++) snapshots.push(changing(i));
    const { adapter } = makeAdapter(snapshots);
    const { client } = makeJevClient([{ operation: 'CLICK', target: '1' }]);

    const result = await runSubgoal({
      adapter,
      jevClient: client,
      jevModel: undefined,
      goal: 'Keep clicking',
      values: undefined,
      check: undefined,
      maxSteps: 3,
    });

    expect(result.status).toBe('budget_exhausted');
    expect(result.steps.length).toBeLessThanOrEqual(3);
  });

  describe('confidence gating (minConfidence)', () => {
    it('gates a low-confidence action, retries once with a wait, then returns low_confidence with topCandidates', async () => {
      const unchanged = snap('A', {
        actions: [
          { node: '1', role: 'button', label: 'Save', kind: 'click', value: '' },
          { node: '2', role: 'button', label: 'Save draft', kind: 'click', value: '' },
        ],
      });
      const { adapter, calls } = makeAdapter([
        unchanged,
        unchanged,
        unchanged,
        unchanged,
        unchanged,
      ]);
      const { client } = makeJevClient([
        {
          operation: 'CLICK',
          target: '1',
          confidence: 0.2,
          probabilities: { '1': 0.55, '2': 0.45 },
        },
        {
          operation: 'CLICK',
          target: '1',
          confidence: 0.2,
          probabilities: { '1': 0.55, '2': 0.45 },
        },
      ]);

      const result = await runSubgoal({
        adapter,
        jevClient: client,
        jevModel: undefined,
        goal: 'Click save',
        values: undefined,
        check: undefined,
        maxSteps: 10,
        minConfidence: 0.4,
      });

      expect(result.status).toBe('low_confidence');
      expect(result.lowConfidence).toMatchObject({ operation: 'CLICK', confidence: 0.2 });
      expect(result.lowConfidence?.topCandidates).toEqual([
        { index: '1', label: 'Save', probability: 0.55 },
        { index: '2', label: 'Save draft', probability: 0.45 },
      ]);
      // One gated retry step (the wait), recorded with gated: true; the click itself never happened.
      expect(result.steps).toHaveLength(1);
      expect(result.steps[0]).toMatchObject({ gated: true, confidence: 0.2 });
      expect(calls.some((c) => c.name === 'act' && c.action?.kind === 'click')).toBe(false);
      expect(calls.filter((c) => c.name === 'act' && c.action?.kind === 'wait')).toHaveLength(1);
    });

    it('re-decides instead of gating when the page changed since the low-confidence decision', async () => {
      const before = snap('A');
      const after = snap('B');
      const { adapter } = makeAdapter([before, after, after]);
      const { client } = makeJevClient([
        { operation: 'CLICK', target: '1', confidence: 0.1 },
        { operation: 'DONE', confidence: 0.99 },
      ]);

      const result = await runSubgoal({
        adapter,
        jevClient: client,
        jevModel: undefined,
        goal: 'Click submit',
        values: undefined,
        check: undefined,
        maxSteps: 10,
        minConfidence: 0.4,
      });

      expect(result.status).toBe('claimed_done');
    });

    it('acts normally when confidence meets the threshold', async () => {
      const filled = snap('B', {
        actions: [{ node: '1', role: 'button', label: 'Submit', kind: 'click', value: '' }],
      });
      const { adapter } = makeAdapter([snap('A'), snap('A'), filled, filled]);
      const { client } = makeJevClient([
        { operation: 'CLICK', target: '1', confidence: 0.9 },
        { operation: 'DONE' },
      ]);

      const result = await runSubgoal({
        adapter,
        jevClient: client,
        jevModel: undefined,
        goal: 'Click submit',
        values: undefined,
        check: undefined,
        maxSteps: 10,
        minConfidence: 0.4,
      });

      expect(result.status).toBe('claimed_done');
      expect(result.steps).toHaveLength(1);
      expect(result.steps[0]?.gated).toBeUndefined();
    });
  });

  it('uses DomAdapter.marker() (not the full snapshot script) for pre-act freshness checks', async () => {
    const context: BrowserRequestContext = {
      chatId: 'chat-1',
      executionId: 'exec-1',
      browserSessionId: 'browser-1',
    };
    const scriptCalls: string[] = [];
    let clicked = false;
    const host: AgenticBrowserRuntimeHost = {
      createId: (kind) => `${kind}-1`,
      invokeBrowserCommand: async (name, input): Promise<BrowserCommandResult> => {
        if (name === 'browser_execute_script') {
          const script = String((input as { script?: unknown }).script ?? '');
          scriptCalls.push(script);
          const marker = [
            'https://example.com/',
            0,
            0,
            1024,
            768,
            'Example',
            clicked ? 'done' : 'hello',
            '[]',
            'null',
          ];
          if (script.includes('data-mjev-id')) {
            return {
              success: true,
              data: {
                url: 'https://example.com/',
                title: 'Example',
                w: 1024,
                h: 768,
                text: clicked ? 'done' : 'hello',
                scroll: { y: 0, height: 1000 },
                actions: [{ node: '1', role: 'button', label: 'Submit', kind: 'click', value: '' }],
                marker,
                omittedActions: 0,
              },
            };
          }
          return { success: true, data: marker };
        }
        if (name === 'browser_click') {
          clicked = true;
          return { success: true, data: {} };
        }
        return { success: true, data: {} };
      },
    };
    const adapter = new DomAdapter(host, context);
    const { client } = makeJevClient([{ operation: 'CLICK', target: '1' }, { operation: 'DONE' }]);

    const result = await runSubgoal({
      adapter,
      jevClient: client,
      jevModel: undefined,
      goal: 'Click submit',
      values: undefined,
      check: undefined,
      maxSteps: 10,
    });

    expect(result.status).toBe('claimed_done');
    const markerOnlyCalls = scriptCalls.filter((s) => !s.includes('data-mjev-id'));
    const fullSnapshotCalls = scriptCalls.filter((s) => s.includes('data-mjev-id'));
    // Every pre-act/pre-terminal freshness check goes through the cheap marker script.
    expect(markerOnlyCalls.length).toBeGreaterThan(0);
    // The initial snapshot and the post-action snapshot use the full stamping script.
    expect(fullSnapshotCalls.length).toBeGreaterThan(0);
  });
});
