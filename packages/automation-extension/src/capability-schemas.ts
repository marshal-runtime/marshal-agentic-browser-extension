/**
 * JSON Schema descriptors for every `browser.automation.*` capability, split
 * out of capabilities.ts (mechanical move, no behavior change) to keep that
 * module under the repo's 600-line-per-module limit. See capabilities.ts for
 * the handlers that produce/consume the shapes described here.
 */
import type { CapabilityDescriptor } from './contracts.js';

const PROTOCOL_VERSION = '1.0.0';

export const OBSERVE_DEFAULT_CHARS = 1000;
export const OBSERVE_MAX_CHARS = 8000;
export const OBSERVE_MAX_FIND_TERMS = 16;

function descriptor(
  suffix: string,
  title: string,
  description: string,
  inputSchema: CapabilityDescriptor['inputSchema'],
  outputSchema: CapabilityDescriptor['outputSchema'],
  risk: 'low' | 'medium' | 'high',
): CapabilityDescriptor {
  const name = `browser.automation.${suffix}`;
  return {
    protocolVersion: PROTOCOL_VERSION,
    name,
    version: '1.0.0',
    title,
    description,
    tags: ['browser', 'automation', 'jev'],
    inputSchema,
    outputSchema,
    permissions: [{ permission: `marshal.tool.invoke:${name}`, risk }],
  };
}

const RUN_INPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['goal'],
  properties: {
    goal: { type: 'string', minLength: 1 },
    startUrl: { type: 'string' },
    plannerModel: { type: 'string' },
    reasoningEffort: { enum: ['low', 'medium', 'high'] },
    maxSubgoals: { type: 'integer', minimum: 1 },
    timeoutMs: { type: 'integer', minimum: 1 },
    workspaceName: { type: 'string' },
    repoPath: { type: 'string' },
  },
} as const;

export const STRING_ARRAY_SCHEMA = { type: 'array', items: { type: 'string' } } as const;

export const TIMING_STATS_PROPERTIES = {
  jevLatencyMs: { type: 'number' },
  subgoalMs: { type: 'number' },
  checkMs: { type: 'number' },
  observeMs: { type: 'number' },
  startupMs: { type: 'number' },
  plannerThinkMs: { type: 'number' },
  capabilityCalls: { type: 'integer' },
  allowlistApplied: { type: 'boolean' },
  plannerMessages: { type: 'integer' },
  plannerInputTokens: { type: 'number' },
  plannerOutputTokens: { type: 'number' },
  plannerCachedInputTokens: { type: 'number' },
} as const;

const RUN_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    runId: { type: 'string' },
    status: { type: 'string' },
    result: {},
    evidence: STRING_ARRAY_SCHEMA,
    plannerSessionId: { type: 'string' },
    stats: {
      type: 'object',
      properties: {
        subgoals: { type: 'integer' },
        jevCalls: { type: 'integer' },
        steps: { type: 'integer' },
        durationMs: { type: 'number' },
        ...TIMING_STATS_PROPERTIES,
      },
      additionalProperties: false,
    },
    error: { type: 'string' },
    reason: { type: 'string' },
    hint: { type: 'string' },
  },
  additionalProperties: false,
} as const;

const SUBGOAL_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    status: { type: 'string' },
    steps: { type: 'array', items: { type: 'object' } },
    page: {
      type: 'object',
      properties: { url: { type: 'string' }, title: { type: 'string' } },
      additionalProperties: false,
    },
    jevCalls: { type: 'integer' },
    freshnessRechecks: { type: 'integer' },
    freshnessUnstable: { type: 'boolean' },
    check: { type: 'object' },
    missingField: { type: 'string' },
    lowConfidence: {
      type: 'object',
      properties: {
        operation: { type: 'string' },
        confidence: { type: 'number' },
        topCandidates: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              index: { type: 'string' },
              label: { type: 'string' },
              probability: { type: 'number' },
            },
            additionalProperties: false,
          },
        },
      },
      additionalProperties: false,
    },
  },
  additionalProperties: false,
} as const;

const CHECK_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    passed: { type: 'boolean' },
    judgedBy: { type: 'string' },
    detail: { type: 'string' },
    children: { type: 'array', items: { type: 'object' } },
  },
  additionalProperties: false,
} as const;

const OBSERVE_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    url: { type: 'string' },
    title: { type: 'string' },
    textExcerpt: { type: 'string' },
    matches: {
      type: 'object',
      additionalProperties: STRING_ARRAY_SCHEMA,
    },
    elements: STRING_ARRAY_SCHEMA,
    screenshotPath: { type: 'string' },
    screenshotBytes: { type: 'integer' },
  },
  additionalProperties: false,
} as const;

const FINISH_OUTPUT_SCHEMA = {
  type: 'object',
  properties: { runId: { type: 'string' }, status: { type: 'string' } },
  additionalProperties: false,
} as const;

const GET_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    runId: { type: 'string' },
    status: { type: 'string' },
    createdAt: { type: 'string' },
    plannerSessionId: { type: 'string' },
    stats: {
      type: 'object',
      properties: {
        subgoals: { type: 'integer' },
        jevCalls: { type: 'integer' },
        steps: { type: 'integer' },
        durationMs: { type: 'number' },
        ...TIMING_STATS_PROPERTIES,
      },
      additionalProperties: false,
    },
    subgoals: { type: 'array', items: { type: 'object' } },
    result: {},
    evidence: STRING_ARRAY_SCHEMA,
  },
  additionalProperties: false,
} as const;

const SUBGOAL_INPUT_SCHEMA = {
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
} as const;

const CHECK_INPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['runId', 'check'],
  properties: {
    runId: { type: 'string', minLength: 1 },
    check: { type: 'object' },
  },
} as const;

const OBSERVE_INPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['runId'],
  properties: {
    runId: { type: 'string', minLength: 1 },
    screenshot: { type: 'boolean' },
    find: {
      type: 'array',
      items: { type: 'string', minLength: 1 },
      maxItems: OBSERVE_MAX_FIND_TERMS,
    },
    maxChars: { type: 'integer', minimum: 1, maximum: OBSERVE_MAX_CHARS },
  },
} as const;

const FINISH_INPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['runId', 'status'],
  properties: {
    runId: { type: 'string', minLength: 1 },
    status: { enum: ['succeeded', 'failed', 'blocked'] },
    result: {},
    evidence: { anyOf: [{ type: 'array', items: { type: 'string' } }, { type: 'string' }] },
  },
} as const;

const GET_INPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['runId'],
  properties: { runId: { type: 'string', minLength: 1 } },
} as const;

export const DESCRIPTORS: readonly CapabilityDescriptor[] = [
  descriptor(
    'run',
    'Run a browser automation goal end to end',
    'Binds the caller browser session, checks Jev connectivity, launches a cheap planner agent, and waits for it to finish.',
    RUN_INPUT_SCHEMA,
    RUN_OUTPUT_SCHEMA,
    'high',
  ),
  descriptor(
    'subgoal',
    'Drive one subgoal with the Jev step-loop executor',
    'Runs the code-driven observe/decide/act loop until DONE/BLOCKED/stuck/budget for one small subgoal.',
    SUBGOAL_INPUT_SCHEMA,
    SUBGOAL_OUTPUT_SCHEMA,
    'high',
  ),
  descriptor(
    'check',
    'Evaluate a code or model postcondition against the current page',
    'Evaluates a Check (url_matches/text_visible/element_present/element_absent/field_value/all/jev_noul) in code.',
    CHECK_INPUT_SCHEMA,
    CHECK_OUTPUT_SCHEMA,
    'low',
  ),
  descriptor(
    'observe',
    'Read a compact snapshot of the bound browser session',
    'Returns url/title/visible-text excerpt/element table; "find" adds snippets around each term from the FULL page text (matches), "maxChars" widens the excerpt, and screenshot saves an image to a file (screenshotPath).',
    OBSERVE_INPUT_SCHEMA,
    OBSERVE_OUTPUT_SCHEMA,
    'low',
  ),
  descriptor(
    'finish',
    'End an automation run',
    'Resolves the run started by browser.automation.run with a final status/result/evidence. Only valid for an active runId.',
    FINISH_INPUT_SCHEMA,
    FINISH_OUTPUT_SCHEMA,
    'low',
  ),
  descriptor(
    'get',
    'Read an automation run record',
    'Returns the run status, stats, and subgoal history.',
    GET_INPUT_SCHEMA,
    GET_OUTPUT_SCHEMA,
    'low',
  ),
];
