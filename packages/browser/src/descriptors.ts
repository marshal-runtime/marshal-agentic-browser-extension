/** Capability descriptors (names, schemas, permissions) for runtime-extension.json's `contributes.capabilities`. */
import type { CapabilityDescriptor, JsonSchema } from './contracts.js';
import { LIFECYCLE_DESCRIPTORS, VIDEO_SCHEMA } from './lifecycle-descriptors.js';

const PROFILE = {
  enum: ['agent', 'visitor', 'offline'],
  description:
    'agent: lasting profile (logins persist); visitor: fresh, no cookies, observes only; offline: no network (pages we render). Default visitor.',
} as const;
const ON_USER = {
  enum: ['managed', 'user', 'app'],
  description:
    "user: a background tab in the person's own signed-in Chrome (through the browser bridge; needs url). app: a native macOS app (needs app). Default managed.",
} as const;
const SESSION_ID = {
  type: 'string',
  description: 'From browser.session.open (or a task run with keepOpen).',
} as const;
/** The app backend's inputs (native macOS apps through Accessibility), shared by task, session.open and ask. */
const APP_INPUTS = {
  app: {
    type: 'string',
    description:
      'With on:"app": the app, by bundle id (com.apple.TextEdit) or name (TextEdit). Started in the background when not running, and quit afterwards.',
  },
  allowRealInput: {
    type: 'boolean',
    description:
      'With on:"app": may a step bring the app to the front or use real keyboard/mouse input when Accessibility alone cannot do it? Default false: such a step stops with needs_input (real_input_required).',
  },
  launch: {
    type: 'boolean',
    description: 'With on:"app": start the app when it is not running (default true).',
  },
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
      "Lists the backends this extension can drive right now (managed Chrome with agent / visitor / offline profiles; the person's own Chrome through the browser bridge, with why it is not paired: extension_missing, no_socket, control_off, not_connected, denied; native macOS apps with their Accessibility and Screen Recording permission, each with the reason and System Settings link when missing, the screen lock and the running apps) and whether marshal.models.decide is offered.",
    inputSchema: object({}),
    outputSchema: object({
      ...OK_ERROR,
      backends: { type: 'array' },
      decide: { type: 'object' },
      recorder: {
        type: 'object',
        description: 'Whether session videos can be made: the ffmpeg in use, or why there is none.',
      },
      openSessions: { type: 'array' },
    }),
  },
  {
    protocolVersion: '1.0.0',
    name: 'browser.session.open',
    version: '0.1.0',
    title: 'Open a browser session',
    description:
      'Opens a tab in a Chrome this extension starts (or, on:"user", in the person\'s own Chrome), optionally at a URL, or (on:"app") a native macOS app. Returns a sessionId for snapshot / act / screenshot / close. Idle sessions close after 10 minutes.',
    inputSchema: object({ on: ON_USER, profile: PROFILE, url: { type: 'string' }, ...APP_INPUTS }),
    outputSchema: object({
      ...OK_ERROR,
      sessionId: { type: 'string' },
      profile: { type: 'string' },
      backend: { type: 'string' },
      app: { type: 'string' },
      launched: { type: 'boolean' },
      reason: { type: 'string' },
      url: { type: 'string' },
      title: { type: 'string' },
    }),
    permissions: permission(
      'browser.session.open',
      'Opens websites in a Chrome the browser extension starts, or a background tab of the person\'s own Chrome. High risk with profile "agent" (the agent\'s lasting logins) or on "user" (the person\'s own signed-in Chrome).',
      'medium',
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
    outputSchema: object({
      ...OK_ERROR,
      url: { type: 'string' },
      title: { type: 'string' },
      needsRealInput: { type: 'boolean' },
      realInput: { type: 'boolean' },
    }),
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
    outputSchema: object({ ...OK_ERROR, closed: { type: 'boolean' }, quit: { type: 'boolean' } }),
  },
  {
    protocolVersion: '1.0.0',
    name: 'browser.task',
    version: '0.1.0',
    title: 'Do a browser task',
    description:
      'Gives a goal ("open X and get me Y") to a code loop: each step one marshal.models.decide call with a marked screenshot picks the action, code guards stop on off-site, sign-in-grant or payment links. Returns status done | needs_input | needs_owner | blocked | low_confidence | budget | decisions_unavailable | cancelled, the data/text/screenshot asked for in want, and a per-step trace.',
    inputSchema: object(
      {
        goal: { type: 'string' },
        startUrl: { type: 'string' },
        on: {
          enum: ['auto', 'managed', 'user', 'app'],
          description:
            "auto (default): the managed Chrome, unless the goal needs the person's own login; then their own Chrome, or needs_owner 'connect your browser' when it is not paired (never another browser). user: the person's own Chrome (needs startUrl). app: a native macOS app (needs app).",
        },
        needsLogin: {
          type: 'boolean',
          description:
            "For on:auto: whether the goal needs the person's own signed-in session. When absent, one decision call judges it.",
        },
        ...APP_INPUTS,
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
            'The only strings the task may type, by name (e.g. {"email": "..."}). The model reads their names only, and \u27e8value <name>\u27e9 where the page text shows one (values of 3 characters or more); the screenshot still shows the page as it is.',
        },
        want: object({
          data: {
            type: 'object',
            description: 'JSON schema of the data to return once the goal is met.',
          },
          text: { type: 'boolean' },
          screenshot: { type: 'boolean' },
          video: {
            type: 'boolean',
            description:
              'Record the session as an MP4 (artifact kind video). Refused with recorder_unavailable when no ffmpeg is found.',
          },
        }),
        wait: {
          type: 'boolean',
          description:
            'false: return {taskId} at once and run in the background (browser.task.get / cancel / watch). Default true.',
        },
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
      backend: { type: 'string' },
      userBrowser: { type: 'object' },
      profile: { type: 'string' },
      app: { type: 'string' },
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
          'cancelled',
          'recorder_unavailable',
          'running',
        ],
      },
      state: { type: 'string' },
      video: VIDEO_SCHEMA,
      videoError: { type: 'string' },
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
      'Runs a multi-step task (clicks, typing supplied values) in a Chrome the browser extension starts or the person\'s own Chrome. High risk with profile "agent" (the agent\'s lasting logins) or on "user" (the person\'s own signed-in Chrome).',
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
        on: ON_USER,
        profile: PROFILE,
        ...APP_INPUTS,
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
      reason: { type: 'string' },
      backend: { type: 'string' },
      url: { type: 'string' },
      title: { type: 'string' },
      answers: { type: 'object' },
      decideMs: { type: 'number' },
      elapsedMs: { type: 'number' },
      screenshotPath: { type: 'string' },
    }),
    permissions: permission(
      'browser.ask',
      'Opens a page and sends its screenshot and text to the decision model. High risk with profile "agent" (the agent\'s lasting logins) or on "user" (the person\'s own signed-in Chrome).',
      'medium',
    ),
  },
  ...LIFECYCLE_DESCRIPTORS,
];
