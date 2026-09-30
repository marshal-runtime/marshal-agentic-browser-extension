/** Capability descriptors (input/output schemas) for the computer.automation.* provider. */
import type { CapabilityDescriptor } from '../contracts.js';

const PROTOCOL_VERSION = '1.0.0';
export const OBSERVE_DEFAULT_CHARS = 1000;
export const OBSERVE_MAX_CHARS = 8000;
export const OBSERVE_MAX_FIND_TERMS = 16;
export const LIST_DEFAULT_LIMIT = 20;
export const LIST_MAX_LIMIT = 100;
export const LIST_GOAL_EXCERPT_CHARS = 200;

const RUN_INPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['goal', 'app'],
  properties: {
    goal: { type: 'string', minLength: 1 },
    app: {
      type: 'string',
      minLength: 1,
      description: 'Bundle id (e.g. com.apple.TextEdit) or app name.',
    },
    plannerModel: { type: 'string' },
    reasoningEffort: { enum: ['low', 'medium', 'high'] },
    timeoutMs: { type: 'integer', minimum: 1 },
    workspaceName: { type: 'string' },
    repoPath: { type: 'string' },
    ocrMode: {
      enum: ['auto', 'always', 'never'],
      description: 'OCR fallback over the AX tree; default "auto".',
    },
    wait: {
      type: 'boolean',
      description:
        'Default true: blocks until the run finishes. Set false to return {runId, status: "running", plannerSessionId} as soon as the planner launches, without waiting - poll computer.automation.get {runId} for the final result, or computer.automation.list if the runId is ever lost (e.g. the host backgrounded this call).',
    },
  },
} as const;

const STRING_ARRAY_SCHEMA = { type: 'array', items: { type: 'string' } } as const;

function descriptor(
  suffix: string,
  title: string,
  description: string,
  inputSchema: CapabilityDescriptor['inputSchema'],
  outputSchema: CapabilityDescriptor['outputSchema'],
  risk: 'low' | 'medium' | 'high',
): CapabilityDescriptor {
  const name = `computer.automation.${suffix}`;
  return {
    protocolVersion: PROTOCOL_VERSION,
    name,
    version: '1.0.0',
    title,
    description,
    tags: ['computer-use', 'automation', 'jev', 'accessibility'],
    inputSchema,
    outputSchema,
    permissions: [{ permission: `marshal.tool.invoke:${name}`, risk }],
  };
}

export const DESCRIPTORS: readonly CapabilityDescriptor[] = [
  descriptor(
    'apps',
    'List running GUI apps',
    'Returns running macOS GUI apps with bundleId/name/pid, and Accessibility/Screen Recording permission status.',
    { type: 'object', additionalProperties: false, properties: {} },
    {
      type: 'object',
      properties: {
        permissions: { type: 'object' },
        apps: { type: 'array', items: { type: 'object' } },
      },
      additionalProperties: false,
    },
    'low',
  ),
  descriptor(
    'run',
    'Run a native app automation goal end to end',
    'Focuses the target app, launches a cheap planner agent driving it via the Accessibility tree, and waits for it to finish.',
    RUN_INPUT_SCHEMA,
    {
      type: 'object',
      properties: {
        runId: { type: 'string' },
        status: { type: 'string' },
        result: {},
        evidence: STRING_ARRAY_SCHEMA,
        plannerSessionId: { type: 'string' },
        stats: { type: 'object' },
        error: { type: 'string' },
        reason: { type: 'string' },
        hint: { type: 'string' },
      },
      additionalProperties: false,
    },
    'high',
  ),
  descriptor(
    'subgoal',
    'Drive one subgoal with the Jev step-loop executor against a native app',
    'Runs the code-driven observe/decide/act loop until DONE/BLOCKED/stuck/budget for one small subgoal.',
    {
      type: 'object',
      additionalProperties: false,
      required: ['runId', 'goal'],
      properties: {
        runId: { type: 'string', minLength: 1 },
        goal: { type: 'string', minLength: 1 },
        values: { type: 'object' },
        check: { type: 'object' },
        maxSteps: { type: 'integer', minimum: 1 },
      },
    },
    {
      type: 'object',
      properties: {
        status: { type: 'string' },
        steps: { type: 'array', items: { type: 'object' } },
        page: { type: 'object' },
        jevCalls: { type: 'integer' },
        freshnessRechecks: { type: 'integer' },
        freshnessUnstable: { type: 'boolean' },
        check: { type: 'object' },
        missingField: { type: 'string' },
        lowConfidence: { type: 'object' },
      },
      additionalProperties: false,
    },
    'high',
  ),
  descriptor(
    'check',
    'Evaluate a code or model postcondition against the current app state',
    'Evaluates a Check (url_matches/text_visible/element_present/element_absent/field_value/all/jev_noul) in code.',
    {
      type: 'object',
      additionalProperties: false,
      required: ['runId', 'check'],
      properties: { runId: { type: 'string', minLength: 1 }, check: { type: 'object' } },
    },
    {
      type: 'object',
      properties: {
        passed: { type: 'boolean' },
        judgedBy: { type: 'string' },
        detail: { type: 'string' },
        children: { type: 'array', items: { type: 'object' } },
      },
      additionalProperties: false,
    },
    'low',
  ),
  descriptor(
    'observe',
    'Read a compact snapshot of the bound native app',
    '"find" adds snippets around each term from the app text (matches); "maxChars" widens the excerpt.',
    {
      type: 'object',
      additionalProperties: false,
      required: ['runId'],
      properties: {
        runId: { type: 'string', minLength: 1 },
        find: {
          type: 'array',
          items: { type: 'string', minLength: 1 },
          maxItems: OBSERVE_MAX_FIND_TERMS,
        },
        maxChars: { type: 'integer', minimum: 1, maximum: OBSERVE_MAX_CHARS },
      },
    },
    {
      type: 'object',
      properties: {
        url: { type: 'string' },
        title: { type: 'string' },
        textExcerpt: { type: 'string' },
        matches: { type: 'object' },
        elements: STRING_ARRAY_SCHEMA,
      },
      additionalProperties: false,
    },
    'low',
  ),
  descriptor(
    'finish',
    'End an automation run',
    'Resolves the run started by computer.automation.run with a final status/result/evidence.',
    {
      type: 'object',
      additionalProperties: false,
      required: ['runId', 'status'],
      properties: {
        runId: { type: 'string', minLength: 1 },
        status: { enum: ['succeeded', 'failed', 'blocked'] },
        result: {},
        evidence: { anyOf: [{ type: 'array', items: { type: 'string' } }, { type: 'string' }] },
      },
    },
    {
      type: 'object',
      properties: { runId: { type: 'string' }, status: { type: 'string' } },
      additionalProperties: false,
    },
    'low',
  ),
  descriptor(
    'get',
    'Read an automation run record',
    'Returns the run status, stats, and subgoal history; once finished, also the final result/evidence/error.',
    {
      type: 'object',
      additionalProperties: false,
      required: ['runId'],
      properties: { runId: { type: 'string', minLength: 1 } },
    },
    {
      type: 'object',
      properties: {
        runId: { type: 'string' },
        status: { type: 'string' },
        createdAt: { type: 'string' },
        plannerSessionId: { type: 'string' },
        stats: { type: 'object' },
        subgoals: { type: 'array', items: { type: 'object' } },
        result: {},
        evidence: STRING_ARRAY_SCHEMA,
        error: { type: 'string' },
      },
      additionalProperties: false,
    },
    'low',
  ),
  descriptor(
    'list',
    'List recent automation runs',
    'Returns recent runs (newest first) with runId, a goal excerpt, status, createdAt, and plannerSessionId. Use this to recover a run whose runId was lost or never seen (e.g. computer.automation.run was backgrounded by the host) - then call computer.automation.get with the found runId.',
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        limit: { type: 'integer', minimum: 1, maximum: LIST_MAX_LIMIT },
      },
    },
    {
      type: 'object',
      properties: {
        runs: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              runId: { type: 'string' },
              goal: { type: 'string' },
              status: { type: 'string' },
              createdAt: { type: 'string' },
              plannerSessionId: { type: 'string' },
            },
            additionalProperties: false,
          },
        },
      },
      additionalProperties: false,
    },
    'low',
  ),
];
