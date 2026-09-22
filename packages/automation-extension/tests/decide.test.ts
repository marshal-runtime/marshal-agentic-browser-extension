import { describe, expect, it, vi } from 'vitest';
import { buildActionSpace } from '../src/action-space.js';
import { decideNextAction } from '../src/decide.js';
import type { JevAskRequest, JevAskResult, JevClient } from '../src/contracts.js';
import type { RawSnapshotAction } from '../src/types.js';

function fakeClient(ask: (request: JevAskRequest) => JevAskResult): JevClient {
  return {
    status: async () => ({ state: 'connected', model: 'jev-latest' }),
    ask: async (request) => ask(request),
  };
}

const page = { url: 'https://example.com', title: 'Example', text: 'hello' };

describe('decideNextAction (port of jev-ultrafast choose())', () => {
  it('builds an operation criteria only for operations with present candidates, plus DONE/BLOCKED always', async () => {
    const actions: readonly RawSnapshotAction[] = [
      { node: '1', role: 'button', label: 'Submit', kind: 'click', value: '' },
    ];
    const space = buildActionSpace(actions);
    let seenRequest: JevAskRequest | undefined;
    const client = fakeClient((request) => {
      seenRequest = request;
      return {
        answers: {
          operation: {
            choice: 'CLICK',
            probabilities: { CLICK: 1, DONE: 0, BLOCKED: 0 },
            confidence: 0.9,
          },
          click_target: { choice: '1', probabilities: { '1': 1 }, confidence: 0.9 },
        },
        model: 'jev-latest',
        usage: { input_tokens: 1, output_tokens: 1 },
        latencyMs: 3,
      };
    });

    await decideNextAction(client, space, 'Submit the form', [], page, undefined, undefined);

    const questions = seenRequest?.questions as Record<
      string,
      { criteria: Record<string, unknown> }
    >;
    const operationQuestion = questions['operation'];
    if (!operationQuestion) throw new Error('expected an "operation" question');
    const operationCriteria = Object.keys(operationQuestion.criteria);
    expect(operationCriteria).toContain('CLICK');
    expect(operationCriteria).toContain('DONE');
    expect(operationCriteria).toContain('BLOCKED');
    expect(operationCriteria).not.toContain('TYPE_TEXT');
    expect(operationCriteria).not.toContain('SELECT');

    // Only a target question for the operation that has candidates.
    expect(questions['click_target']).toBeDefined();
    expect(questions['type_text_target']).toBeUndefined();
    expect(questions['select_target']).toBeUndefined();
  });

  it('builds one target question per present operation, each carrying the goal/operation/rules instructions', async () => {
    const actions: readonly RawSnapshotAction[] = [
      { node: '1', role: 'textbox', label: 'Email', kind: 'fill', value: '' },
      { node: '2', role: 'button', label: 'Submit', kind: 'click', value: '' },
    ];
    const space = buildActionSpace(actions);
    let seenRequest: JevAskRequest | undefined;
    const client = fakeClient((request) => {
      seenRequest = request;
      return {
        answers: {
          operation: {
            choice: 'TYPE_TEXT',
            probabilities: { TYPE_TEXT: 1, CLICK: 0, DONE: 0, BLOCKED: 0 },
            confidence: 0.9,
          },
          type_text_target: { choice: '1', probabilities: { '1': 1 }, confidence: 0.9 },
        },
        model: 'jev-latest',
        usage: { input_tokens: 1, output_tokens: 1 },
        latencyMs: 3,
      };
    });

    const { decision, action } = await decideNextAction(
      client,
      space,
      'Fill email',
      [],
      page,
      undefined,
      undefined,
    );

    const questions = seenRequest?.questions as Record<
      string,
      { instructions: { goal: string; operation?: string } }
    >;
    const typeTextTargetQuestion = questions['type_text_target'];
    const clickTargetQuestion = questions['click_target'];
    if (!typeTextTargetQuestion || !clickTargetQuestion) {
      throw new Error('expected "type_text_target" and "click_target" questions');
    }
    expect(typeTextTargetQuestion.instructions).toMatchObject({
      goal: 'Fill email',
      operation: 'TYPE_TEXT',
    });
    expect(clickTargetQuestion.instructions).toMatchObject({
      goal: 'Fill email',
      operation: 'CLICK',
    });

    expect(decision.operation).toBe('TYPE_TEXT');
    expect(action).toBe(actions[0]);
  });

  it('discards non-matching target heads: an unrelated *_target answer never determines the action', async () => {
    const actions: readonly RawSnapshotAction[] = [
      { node: '1', role: 'textbox', label: 'Email', kind: 'fill', value: '' },
      { node: '2', role: 'button', label: 'Submit', kind: 'click', value: '' },
    ];
    const space = buildActionSpace(actions);
    const client = fakeClient(() => ({
      answers: {
        operation: {
          choice: 'CLICK',
          probabilities: { TYPE_TEXT: 0, CLICK: 1, DONE: 0, BLOCKED: 0 },
          confidence: 0.95,
        },
        // A garbage/mismatched TYPE_TEXT target answer must never leak into the CLICK action.
        type_text_target: { choice: '1', probabilities: { '1': 1 }, confidence: 0.99 },
        click_target: { choice: '2', probabilities: { '2': 1 }, confidence: 0.8 },
      },
      model: 'jev-latest',
      usage: { input_tokens: 1, output_tokens: 1 },
      latencyMs: 3,
    }));

    const { decision, action } = await decideNextAction(
      client,
      space,
      'Submit',
      [],
      page,
      undefined,
      undefined,
    );
    expect(decision.operation).toBe('CLICK');
    expect(action).toBe(actions[1]);
    expect(action).not.toBe(actions[0]);
  });

  it('maps DONE/BLOCKED operations without requiring any target answer', async () => {
    const actions: readonly RawSnapshotAction[] = [
      { node: '1', role: 'button', label: 'Submit', kind: 'click', value: '' },
    ];
    const space = buildActionSpace(actions);
    const client = fakeClient(() => ({
      answers: {
        operation: {
          choice: 'DONE',
          probabilities: { CLICK: 0, DONE: 1, BLOCKED: 0 },
          confidence: 0.9,
        },
      },
      model: 'jev-latest',
      usage: { input_tokens: 1, output_tokens: 1 },
      latencyMs: 3,
    }));

    const { decision } = await decideNextAction(
      client,
      space,
      'Done',
      [],
      page,
      undefined,
      undefined,
    );
    expect(decision.operation).toBe('DONE');
  });

  it('passes the model override through to jevClient.ask when supplied', async () => {
    const space = buildActionSpace([]);
    const ask = vi.fn<(request: JevAskRequest) => JevAskResult>(() => ({
      answers: {
        operation: { choice: 'BLOCKED', probabilities: { DONE: 0, BLOCKED: 1 }, confidence: 1 },
      },
      model: 'jev-custom',
      usage: { input_tokens: 1, output_tokens: 1 },
      latencyMs: 1,
    }));
    await decideNextAction(fakeClient(ask), space, 'goal', [], page, 'jev-custom', undefined);
    expect(ask).toHaveBeenCalledWith(expect.objectContaining({ model: 'jev-custom' }));
  });
});
