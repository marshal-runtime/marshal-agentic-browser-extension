/**
 * TypeScript port of jev-ultrafast's `choose()`
 * (/tmp/jev-ultrafast/jev_ultrafast/model.py:81-148, MIT - see README.md).
 * Builds the `operation` choice question plus one speculative
 * `<op>_target` choice question per operation that has candidates, sends a
 * single `jevClient.ask()` call, and maps the answer(s) back to a concrete
 * action. Unused target heads (operations not selected) are discarded and
 * can never cause an action, mirroring upstream.
 *
 * Unlike upstream, this port does not re-validate probability shape itself:
 * `JevClient.ask()` "validates every choice/score/noul answer before
 * resolving... throws a JevClientError on any failure" (see
 * extensions/jev-runtime-extension/src/api.ts JevClient docstring), so an
 * invalid answer surfaces as a thrown error rather than a silent no-op.
 */
import { NEXT_ACTION, TARGET } from './questions.js';
import type { ActionSpace, Decision, FocusedField, RawSnapshotAction } from './types.js';
import type { ChoiceAnswer, ChoiceQuestion, JevAskOptions, JevClient } from './contracts.js';

const OPERATION_LABELS: Readonly<Record<string, string>> = {
  CLICK: 'Click an element, button, menu option, autocomplete suggestion, or calendar day.',
  TYPE_TEXT:
    "Enter or replace text in an editable field. The value comes from the caller's supplied field values.",
  SELECT: 'Select an observed dropdown value.',
  SUBMIT:
    'Press Enter in the currently focused field to submit its form, instead of finding a Search/Submit button.',
};

export interface DecideResult {
  readonly decision: Decision;
  readonly action: RawSnapshotAction;
}

export async function decideNextAction(
  jevClient: JevClient,
  space: ActionSpace,
  goal: string,
  history: readonly {
    readonly action: string;
    readonly kind: string;
    readonly pageChanged: boolean | null;
  }[],
  page: { readonly url: string; readonly title: string; readonly text: string },
  model: string | undefined,
  askOptions: JevAskOptions | undefined,
  focusedField?: FocusedField | null,
): Promise<DecideResult> {
  const operations: Record<string, string> = {};
  for (const key of Object.keys(space.targets)) {
    operations[key] = OPERATION_LABELS[key] ?? key;
  }
  for (const [id, control] of Object.entries(space.controls)) {
    operations[id] = control.label;
  }
  operations['DONE'] = 'Every requirement is visibly satisfied.';
  operations['BLOCKED'] = 'No supported operation can progress.';

  const questions: Record<string, ChoiceQuestion> = {
    operation: {
      type: 'choice',
      criteria: operations,
      instructions: { goal, rules: NEXT_ACTION },
    },
  };
  for (const [operation, candidates] of Object.entries(space.targets)) {
    const criteria: Record<string, unknown> = {};
    for (const [index, a] of Object.entries(candidates)) {
      criteria[index] = {
        element: `[${index}] ${a.label}`,
        current_value: a.current_value ?? a.value ?? '',
        ...(a.role === undefined ? {} : { role: a.role }),
        ...(a.checked === undefined ? {} : { checked: a.checked }),
        ...(a.selected === undefined ? {} : { selected: a.selected }),
        ...(a.expanded === undefined ? {} : { expanded: a.expanded }),
        ...(a.where === undefined ? {} : { where: a.where }),
        ...(a.near === undefined ? {} : { near: a.near }),
        ...(a.offscreen === undefined ? {} : { offscreen: a.offscreen }),
        ...(a.source === undefined ? {} : { source: a.source }),
      };
    }
    questions[`${operation.toLowerCase()}_target`] = {
      type: 'choice',
      criteria,
      instructions: { goal, operation, rules: [NEXT_ACTION, TARGET] },
    };
  }

  const started = Date.now();
  const result = await jevClient.ask(
    {
      ...(model === undefined ? {} : { model }),
      state: {
        page,
        elements: space.elements,
        recent_actions: history.slice(-10),
        ...(focusedField === undefined ? {} : { focused_field: focusedField }),
      },
      questions,
    },
    askOptions,
  );
  const jevLatencyMs = Date.now() - started;

  const operationAnswer = result.answers['operation'] as ChoiceAnswer | undefined;
  if (!operationAnswer || typeof operationAnswer.choice !== 'string') {
    throw new Error('AUTOMATION_INVALID_JEV_RESPONSE: missing operation answer');
  }
  const operation = operationAnswer.choice;

  if (operation === 'DONE' || operation === 'BLOCKED') {
    return {
      decision: {
        operation,
        choice: operation,
        confidence: operationAnswer.confidence,
        jevLatencyMs,
        probabilities: operationAnswer.probabilities,
      },
      action: { node: null, kind: operation === 'DONE' ? 'wait' : 'wait', label: operation },
    };
  }

  const candidates = space.targets[operation];
  if (candidates) {
    const targetAnswer = result.answers[`${operation.toLowerCase()}_target`] as
      | ChoiceAnswer
      | undefined;
    if (!targetAnswer || typeof targetAnswer.choice !== 'string') {
      throw new Error(
        `AUTOMATION_INVALID_JEV_RESPONSE: missing ${operation.toLowerCase()}_target answer`,
      );
    }
    const action = candidates[targetAnswer.choice];
    if (!action) {
      throw new Error(
        `AUTOMATION_INVALID_JEV_RESPONSE: target "${targetAnswer.choice}" not offered for ${operation}`,
      );
    }
    return {
      decision: {
        operation,
        choice: targetAnswer.choice,
        confidence: targetAnswer.confidence,
        jevLatencyMs,
        probabilities: targetAnswer.probabilities,
      },
      action,
    };
  }

  const control = space.controls[operation];
  if (!control) {
    throw new Error(`AUTOMATION_INVALID_JEV_RESPONSE: unknown operation "${operation}"`);
  }
  return {
    decision: {
      operation,
      choice: operation,
      confidence: operationAnswer.confidence,
      jevLatencyMs,
      probabilities: operationAnswer.probabilities,
    },
    action: control,
  };
}
