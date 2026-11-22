/** Descriptors of the task lifecycle, live view and recording capabilities (handled in src/lifecycle.ts). */
import type { CapabilityDescriptor, JsonSchema } from './contracts.js';

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
const TASK_ID = {
  type: 'string',
  description: 'From browser.task (returned at once with wait:false).',
} as const;
const TASK_SUMMARY = {
  taskId: { type: 'string' },
  goal: { type: 'string' },
  state: { enum: ['running', 'finished'] },
  status: {
    type: 'string',
    description: 'running | cancelling while it runs; the final browser.task status once finished.',
  },
  phase: {
    type: 'string',
    description:
      'starting | routing | navigating | reading | deciding | acting | waiting | extracting | closing | finished',
  },
  steps: { type: 'number' },
  elapsedMs: { type: 'number' },
  sessionId: { type: 'string' },
  lastStep: { type: 'object', description: 'The newest trace step: action, rung, ms, outcome.' },
} as const;
const VIDEO = object({
  path: { type: 'string' },
  frames: { type: 'number' },
  durationMs: { type: 'number' },
  bytes: { type: 'number' },
  width: { type: 'number' },
  height: { type: 'number' },
});
const permission = (
  name: string,
  reason: string,
  risk: 'low' | 'medium' | 'high',
): { permission: string; reason: string; risk: 'low' | 'medium' | 'high' }[] => [
  { permission: `marshal.tool.invoke:${name}`, reason, risk },
];

export const LIFECYCLE_DESCRIPTORS: readonly CapabilityDescriptor[] = [
  {
    protocolVersion: '1.0.0',
    name: 'browser.task.get',
    version: '0.2.0',
    title: 'Progress or result of a task',
    description:
      'The state of a browser.task by taskId: running (with its phase and newest step) or finished (with the full result in `result`). Finished tasks are kept for 30 minutes.',
    inputSchema: object({ taskId: TASK_ID }, ['taskId']),
    outputSchema: object({ ...OK_ERROR, ...TASK_SUMMARY, result: { type: 'object' } }),
  },
  {
    protocolVersion: '1.0.0',
    name: 'browser.task.list',
    version: '0.2.0',
    title: 'List browser tasks',
    description:
      'Running tasks first, then the ones finished in the last 30 minutes, each with its state and newest step.',
    inputSchema: object({}),
    outputSchema: object({ ...OK_ERROR, tasks: { type: 'array', items: { type: 'object' } } }),
  },
  {
    protocolVersion: '1.0.0',
    name: 'browser.task.cancel',
    version: '0.2.0',
    title: 'Stop a running task',
    description:
      'Stops a task before its next action (a decision in flight is dropped, never acted on), closes the tab it opened and ends it with status `cancelled`. A finished task is left unchanged.',
    inputSchema: object({ taskId: TASK_ID }, ['taskId']),
    outputSchema: object({
      ...OK_ERROR,
      taskId: { type: 'string' },
      cancelled: { type: 'boolean' },
      status: { type: 'string' },
      note: { type: 'string' },
      result: { type: 'object' },
    }),
    permissions: permission(
      'browser.task.cancel',
      'Stops a browser task the extension is running.',
      'low',
    ),
  },
  {
    protocolVersion: '1.0.0',
    name: 'browser.watch',
    version: '0.2.0',
    title: 'Watch a task or session live',
    description:
      'Opens a side-panel view of the tab a task (taskId) or session (sessionId) drives: the page live, the step the engine is on and a Stop button. The screencast runs only while the panel looks. open:false returns the ui.application.open input instead.',
    inputSchema: object({
      taskId: TASK_ID,
      sessionId: { type: 'string', description: 'From browser.session.open.' },
      placement: {
        enum: ['side', 'floating', 'bottom', 'chat-tab', 'card'],
        description: 'Default side.',
      },
      open: { type: 'boolean', description: 'Open the panel now (default true).' },
    }),
    outputSchema: object({
      ...OK_ERROR,
      watchId: { type: 'string' },
      opened: { type: 'boolean' },
      instanceId: { type: 'string' },
      openError: { type: 'string' },
      openWith: { type: 'object' },
    }),
    permissions: permission(
      'browser.watch',
      'Shows the automated tab live in a Marshal panel.',
      'low',
    ),
  },
  {
    protocolVersion: '1.0.0',
    name: 'browser.watch.frame',
    version: '0.2.0',
    title: 'Newest live frame of a watch',
    description:
      "The watch panel's poll: the task's state and newest step plus the newest JPEG frame (base64) when it is newer than `since`; without watchId, the newest watch. Meant for the panel; agents use browser.task.get.",
    inputSchema: object({ watchId: { type: 'string' }, since: { type: 'number' } }),
    outputSchema: {
      type: 'object',
      properties: {
        ...OK_ERROR,
        watchId: { type: 'string' },
        kind: { enum: ['task', 'session'] },
        ...TASK_SUMMARY,
        seq: { type: 'number' },
        streamError: { type: 'string' },
        frame: object({
          data: { type: 'string' },
          mimeType: { type: 'string' },
          width: { type: 'number' },
          height: { type: 'number' },
          ts: { type: 'number' },
        }),
      },
      additionalProperties: false,
    },
  },
  {
    protocolVersion: '1.0.0',
    name: 'browser.watch.close',
    version: '0.2.0',
    title: 'Stop a watch',
    description:
      'Ends a watch and its screencast (an unpolled watch also stops by itself after 15 seconds).',
    inputSchema: object({ watchId: { type: 'string' } }, ['watchId']),
    outputSchema: object({ ...OK_ERROR, closed: { type: 'boolean' } }),
  },
  {
    protocolVersion: '1.0.0',
    name: 'browser.session.record.start',
    version: '0.2.0',
    title: 'Start recording a session',
    description:
      'Records an open session as an MP4 from its screencast until browser.session.record.stop. Fails with status recorder_unavailable when no ffmpeg is found.',
    inputSchema: object({ sessionId: { type: 'string' } }, ['sessionId']),
    outputSchema: object({
      ...OK_ERROR,
      status: { type: 'string' },
      recordingId: { type: 'string' },
      path: { type: 'string' },
    }),
    permissions: permission(
      'browser.session.record.start',
      'Records a browser session to a video file.',
      'low',
    ),
  },
  {
    protocolVersion: '1.0.0',
    name: 'browser.session.record.stop',
    version: '0.2.0',
    title: 'Stop recording and save the MP4',
    description:
      'Ends a recording and writes its MP4; returns the path, frame count, duration and size.',
    inputSchema: object({ recordingId: { type: 'string' } }, ['recordingId']),
    outputSchema: object({
      ...OK_ERROR,
      status: { type: 'string' },
      recordingId: { type: 'string' },
      video: VIDEO,
    }),
  },
];

export const VIDEO_SCHEMA = VIDEO;
