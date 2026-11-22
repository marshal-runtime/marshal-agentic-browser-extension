/** Capability descriptors (names, schemas, permissions) for runtime-extension.json's `contributes.capabilities`. */
import type { CapabilityDescriptor, JsonSchema } from './contracts.js';

const PROFILE = {
  enum: ['agent', 'visitor', 'offline'],
  description:
    'agent: lasting profile (logins persist); visitor: fresh, no cookies, observes only; offline: no network (pages we render). Default visitor.',
} as const;
const SESSION_ID = {
  type: 'string',
  description: 'From browser.session.open (or a task run with keepOpen).',
} as const;
const QUESTION = {
  type: 'object',
  description:
    'A marshal.models.decide question: {type: "choice", criteria: {option: description}} | {type: "predicate", instructions} | {type: "score", criteria}.',
  properties: {
    type: { enum: ['choice', 'predicate', 'score'] },
    criteria: { type: 'object', additionalProperties: { type: 'string' } },
    instructions: { type: 'string' },
  },
  required: ['type'],
  additionalProperties: false,
} as const;

const object = (
  properties: Record<string, unknown>,
  required: readonly string[] = [],
): JsonSchema => ({
  type: 'object',
  properties,
  ...(required.length ? { required } : {}),
  additionalProperties: false,
});

const OK_ERROR = { ok: { type: 'boolean' }, error: { type: 'string' } } as const;
const TRACE_STEP = {
  type: 'object',
  description:
    'One step: the action, which rung answered (0 code, 1 decision model, 2 extraction), milliseconds, url.',
} as const;

const permission = (
  name: string,
  reason: string,
  risk: 'low' | 'medium' | 'high',
): { permission: string; reason: string; risk: 'low' | 'medium' | 'high' }[] => [
  { permission: `marshal.tool.invoke:${name}`, reason, risk },
];

export const DESCRIPTORS: readonly CapabilityDescriptor[] = [
  {
    protocolVersion: '1.0.0',
    name: 'browser.status',
    version: '0.1.0',
    title: 'Which browsers are available',
    description:
      "Lists the browser backends this extension can drive right now (managed Chrome with agent / visitor / offline profiles; the person's own Chrome and native apps are planned) and why one is not ready, plus whether marshal.models.decide is offered.",
    inputSchema: object({}),
    outputSchema: object({
      ...OK_ERROR,
      backends: { type: 'array' },
      decide: { type: 'object' },
      openSessions: { type: 'array' },
    }),
  },
  {
    protocolVersion: '1.0.0',
    name: 'browser.session.open',
    version: '0.1.0',
    title: 'Open a browser session',
    description:
      'Opens a tab in a Chrome this extension starts, optionally at a URL. Returns a sessionId for snapshot / act / screenshot / close. Idle sessions close after 10 minutes.',
    inputSchema: object({ profile: PROFILE, url: { type: 'string' } }),
    outputSchema: object({
      ...OK_ERROR,
      sessionId: { type: 'string' },
      profile: { type: 'string' },
      url: { type: 'string' },
      title: { type: 'string' },
    }),
    permissions: permission(
      'browser.session.open',
      'Opens websites in a Chrome the browser extension starts.',
      'low',
    ),
  },
  {
    protocolVersion: '1.0.0',
    name: 'browser.session.snapshot',
    version: '0.1.0',
    title: 'Read the page',
    description:
      'Visible text and the interactive elements with refs (e1, e2, ...) for browser.session.act. screenshot:true also saves a marked screenshot (each ref drawn in a box) and returns its path.',
    inputSchema: object({ sessionId: SESSION_ID, screenshot: { type: 'boolean' } }, ['sessionId']),
    outputSchema: object({
      ...OK_ERROR,
      url: { type: 'string' },
      title: { type: 'string' },
      text: { type: 'string' },
      elements: { type: 'array' },
      canScrollDown: { type: 'boolean' },
      screenshotPath: { type: 'string' },
    }),
  },
  {
    protocolVersion: '1.0.0',
    name: 'browser.session.act',
    version: '0.1.0',
    title: 'Do one action',
    description:
      'One action in a session, with refs from the latest browser.session.snapshot: {kind: click|submit, ref} | {kind: type, ref, text} | {kind: select, ref, value} | {kind: scroll, direction} | {kind: navigate, url} | {kind: back} | {kind: wait, ms}.',
    inputSchema: object(
      {
        sessionId: SESSION_ID,
        action: object(
          {
            kind: {
              enum: ['click', 'type', 'select', 'submit', 'scroll', 'navigate', 'back', 'wait'],
            },
            ref: { type: 'string' },
            text: { type: 'string' },
            value: { type: 'string' },
            url: { type: 'string' },
            direction: { enum: ['down', 'up'] },
            ms: { type: 'number' },
          },
          ['kind'],
        ),
      },
      ['sessionId', 'action'],
    ),
    outputSchema: object({ ...OK_ERROR, url: { type: 'string' }, title: { type: 'string' } }),
    permissions: permission(
      'browser.session.act',
      'Clicks, types and navigates in a Chrome the browser extension starts.',
      'medium',
    ),
  },
  {
    protocolVersion: '1.0.0',
    name: 'browser.session.screenshot',
    version: '0.1.0',
    title: 'Screenshot a session',
    description:
      'Saves a PNG of the tab (marks:true draws each element ref; fullPage:true captures the whole page) and returns its path.',
    inputSchema: object(
      { sessionId: SESSION_ID, marks: { type: 'boolean' }, fullPage: { type: 'boolean' } },
      ['sessionId'],
    ),
    outputSchema: object({ ...OK_ERROR, path: { type: 'string' } }),
  },
  {
    protocolVersion: '1.0.0',
    name: 'browser.session.close',
    version: '0.1.0',
    title: 'Close a session',
    description: 'Closes the tab (and, for visitor and offline, its cookies and storage).',
    inputSchema: object({ sessionId: SESSION_ID }, ['sessionId']),
    outputSchema: object({ ...OK_ERROR, closed: { type: 'boolean' } }),
  },
  {
    protocolVersion: '1.0.0',
    name: 'browser.task',
    version: '0.1.0',
    title: 'Do a browser task',
    description:
      'Gives a goal ("open X and get me Y") to a code loop: each step one marshal.models.decide call with a marked screenshot picks the action, code guards stop on off-site, sign-in-grant or payment links. Returns status done | needs_input | needs_owner | blocked | low_confidence | budget | decisions_unavailable, the data/text/screenshot asked for in want, and a per-step trace.',
    inputSchema: object(
      {
        goal: { type: 'string' },
        startUrl: { type: 'string' },
        on: {
          enum: ['auto', 'managed'],
          description: 'Backend; only managed exists in this version.',
        },
        profile: PROFILE,
        sessionId: SESSION_ID,
        keepOpen: {
          type: 'boolean',
          description: 'Keep the session open and return its sessionId.',
        },
        values: {
          type: 'object',
          additionalProperties: { type: 'string' },
          description:
            'The only strings the task may type, by name (e.g. {"email": "..."}). Their names, never the values, go to the model.',
        },
        want: object({
          data: {
            type: 'object',
            description: 'JSON schema of the data to return once the goal is met.',
          },
          text: { type: 'boolean' },
          screenshot: { type: 'boolean' },
        }),
        bounds: object({ steps: { type: 'number' }, wallMs: { type: 'number' } }),
        allowedSites: {
          type: 'array',
          items: { type: 'string' },
          description: 'Extra host names a link may lead to without stopping for the owner.',
        },
        vision: {
          type: 'boolean',
          description: 'Attach the marked screenshot to each decision (default true).',
        },
      },
      ['goal'],
    ),
    outputSchema: object({
      ...OK_ERROR,
      taskId: { type: 'string' },
      profile: { type: 'string' },
      sessionId: { type: 'string' },
      status: {
        enum: [
          'done',
          'needs_input',
          'needs_owner',
          'blocked',
          'low_confidence',
          'budget',
          'decisions_unavailable',
        ],
      },
      reason: { type: 'string' },
      data: {},
      text: { type: 'string' },
      url: { type: 'string' },
      title: { type: 'string' },
      artifacts: { type: 'array' },
      candidates: { type: 'array' },
      element: { type: 'object' },
      trace: { type: 'array', items: TRACE_STEP },
      stats: { type: 'object' },
    }),
    permissions: permission(
      'browser.task',
      'Runs a multi-step task (clicks, typing supplied values) in a Chrome the browser extension starts.',
      'medium',
    ),
  },
  {
    protocolVersion: '1.0.0',
    name: 'browser.ask',
    version: '0.1.0',
    title: 'Ask about a page',
    description:
      'Opens a URL (or reads an open session) and answers named questions about it from its screenshot and text in one marshal.models.decide call. No clicking.',
    inputSchema: object(
      {
        url: { type: 'string' },
        sessionId: SESSION_ID,
        profile: PROFILE,
        questions: {
          type: 'object',
          additionalProperties: QUESTION,
          description: 'Named questions, answered together.',
        },
      },
      ['questions'],
    ),
    outputSchema: object({
      ...OK_ERROR,
      status: { type: 'string' },
      url: { type: 'string' },
      title: { type: 'string' },
      answers: { type: 'object' },
      decideMs: { type: 'number' },
      elapsedMs: { type: 'number' },
      screenshotPath: { type: 'string' },
    }),
  },
];
