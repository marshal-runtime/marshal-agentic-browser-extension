/**
 * The task lifecycle, live view and recording capabilities (browser.task.get / list / cancel, browser.watch,
 * browser.watch.frame, browser.watch.close, browser.session.record.start / stop), kept out of capabilities.ts so the
 * service only routes to them. BrowserService.task registers each run here (TaskRegistry) and wraps it with a
 * recording when `want.video` is set.
 */
import path from 'node:path';
import os from 'node:os';
import {
  RUNTIME_PROTOCOL_VERSION,
  type InvocationContext,
  type RuntimeExecuteFn,
} from './contracts.js';
import {
  Recorder,
  RecorderUnavailable,
  type Recording,
  type VideoResult,
} from './record/recorder.js';
import { describeTask, statusOf, TaskRegistry, type TaskEntry } from './tasks.js';
import type { Target } from './target.js';
import { WATCH_APPLICATION_ID } from './watch/app.js';
import { WatchRegistry } from './watch/watches.js';

export const LIFECYCLE_CAPABILITIES = [
  'browser.task.get',
  'browser.task.list',
  'browser.task.cancel',
  'browser.watch',
  'browser.watch.frame',
  'browser.watch.close',
  'browser.session.record.start',
  'browser.session.record.stop',
] as const;

export interface LifecycleHost {
  /** The open session's tab, or null. */
  readonly sessionTarget: (sessionId: string) => Target | null;
  /** Where artifacts go (configuration artifactDir or the temp folder). */
  readonly artifactRoot: () => string;
  /** The host's execute, used only to open the watch panel (ui.application.open). */
  readonly execute?: RuntimeExecuteFn;
  readonly ffmpegPath?: string;
}

const PLACEMENTS = ['side', 'floating', 'bottom', 'chat-tab', 'card'] as const;
type Placement = (typeof PLACEMENTS)[number];

export class Lifecycle {
  readonly tasks = new TaskRegistry();
  readonly watches = new WatchRegistry();
  readonly recorder: Recorder;
  private readonly recordings = new Map<string, { recording: Recording; sessionId: string }>();

  constructor(private readonly host: LifecycleHost) {
    this.recorder = new Recorder(host.ffmpegPath ? { ffmpegPath: host.ffmpegPath } : {});
  }

  handles(name: string): boolean {
    return (LIFECYCLE_CAPABILITIES as readonly string[]).includes(name);
  }

  async invoke(
    name: string,
    args: Record<string, unknown>,
    context?: InvocationContext,
  ): Promise<Record<string, unknown>> {
    switch (name) {
      case 'browser.task.get':
        return this.get(args);
      case 'browser.task.list':
        return {
          ok: true,
          tasks: this.tasks.list().map((entry) => describeTask(entry)),
        };
      case 'browser.task.cancel':
        return this.cancel(args);
      case 'browser.watch':
        return this.watch(args, context);
      case 'browser.watch.frame': {
        const id =
          typeof args['watchId'] === 'string' && args['watchId'] ? args['watchId'] : undefined;
        const since = typeof args['since'] === 'number' ? args['since'] : undefined;
        return this.watches.poll(id, since);
      }
      case 'browser.watch.close':
        return { ok: true, closed: await this.watches.close(stringArg(args, 'watchId')) };
      case 'browser.session.record.start':
        return this.recordStart(args);
      case 'browser.session.record.stop':
        return this.recordStop(args);
      default:
        throw new Error(`BROWSER_UNKNOWN_CAPABILITY: ${name}`);
    }
  }

  /** Whether a video can be made at all: `{ok:false, reason}` is surfaced as `recorder_unavailable`. */
  async recorderStatus(): Promise<{ available: boolean; detail: string }> {
    const lookup = await this.recorder.available();
    return lookup.ok
      ? {
          available: true,
          detail: `${lookup.tool.version} (${lookup.tool.ffmpeg}, ${lookup.tool.encoder})`,
        }
      : { available: false, detail: lookup.reason };
  }

  /** Starts recording a task's tab into the task's artifact folder (want.video). */
  async startTaskVideo(target: Target, taskId: string): Promise<Recording> {
    return this.recorder.start(target, this.videoPath(taskId, 'task'));
  }

  async stopVideo(recording: Recording): Promise<VideoResult> {
    return this.recorder.stop(recording);
  }

  async abortVideo(recording: Recording): Promise<void> {
    await this.recorder.abort(recording);
  }

  async dispose(): Promise<void> {
    await this.tasks.cancelAll();
    await this.watches.dispose();
    this.recordings.clear();
    await this.recorder.dispose();
  }

  private get(args: Record<string, unknown>): Record<string, unknown> {
    const entry = this.tasks.get(stringArg(args, 'taskId'));
    if (!entry)
      return {
        ok: false,
        error: 'BROWSER_NO_TASK: no such task (finished tasks are kept for 30 minutes)',
      };
    return {
      ok: true,
      ...describeTask(entry),
      ...(entry.output ? { result: entry.output } : {}),
    };
  }

  private async cancel(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const taskId = stringArg(args, 'taskId');
    const outcome = await this.tasks.cancel(taskId);
    if (!outcome.found) return { ok: false, taskId, error: 'BROWSER_NO_TASK: no such task' };
    const entry = outcome.entry;
    if (!outcome.wasRunning) {
      return {
        ok: true,
        taskId,
        cancelled: false,
        status: statusOf(entry.output, 'finished'),
        note: 'the task had already finished; its result is unchanged',
      };
    }
    return {
      ok: true,
      taskId,
      cancelled: true,
      status: outcome.settled ? statusOf(entry.output, 'cancelled') : 'cancelling',
      ...(outcome.settled && entry.output ? { result: entry.output } : {}),
    };
  }

  private async watch(
    args: Record<string, unknown>,
    context?: InvocationContext,
  ): Promise<Record<string, unknown>> {
    const taskId = typeof args['taskId'] === 'string' ? args['taskId'] : '';
    const sessionId = typeof args['sessionId'] === 'string' ? args['sessionId'] : '';
    if (Boolean(taskId) === Boolean(sessionId))
      throw new Error('BROWSER_BAD_INPUT: give exactly one of taskId or sessionId');
    let watchId: string;
    let title: string;
    if (taskId) {
      const entry = this.tasks.get(taskId);
      if (!entry) return { ok: false, error: 'BROWSER_NO_TASK: no such task' };
      watchId = this.watches.open({ kind: 'task', entry });
      title = `Browser · ${entry.goal.slice(0, 60)}`;
    } else {
      if (!this.host.sessionTarget(sessionId))
        return { ok: false, error: `BROWSER_NO_SESSION: ${sessionId} is not open` };
      watchId = this.watches.open({
        kind: 'session',
        sessionId,
        target: () => this.host.sessionTarget(sessionId),
        task: () => this.runningTaskIn(sessionId),
      });
      title = 'Browser · live session';
    }
    const placement: Placement = PLACEMENTS.includes(args['placement'] as Placement)
      ? (args['placement'] as Placement)
      : 'side';
    const openInput = {
      extensionId: '@marshal/browser',
      applicationId: WATCH_APPLICATION_ID,
      placement,
      title,
      state: { watchId },
      idempotencyKey: `marshal-browser-watch-${watchId}`,
    };
    if (args['open'] === false || !this.host.execute)
      return {
        ok: true,
        watchId,
        opened: false,
        openWith: { capability: 'ui.application.open', input: openInput },
      };
    const response = await this.host
      .execute(
        {
          protocolVersion: RUNTIME_PROTOCOL_VERSION,
          targetType: 'operation',
          target: 'ui.application.open',
          input: openInput,
        },
        context,
      )
      .catch((error: unknown) => ({
        status: 'failed' as const,
        error: { code: 'ERROR', message: error instanceof Error ? error.message : String(error) },
        result: undefined,
      }));
    const output = response.result?.output as
      | {
          ok?: boolean;
          value?: { instance?: { instanceId?: string } };
          error?: { message?: string };
        }
      | undefined;
    if (response.status === 'success' && output?.ok !== false) {
      const instanceId = output?.value?.instance?.instanceId;
      return { ok: true, watchId, opened: true, ...(instanceId ? { instanceId } : {}) };
    }
    // The panel could not be opened from here (policy or host): the watch runs, and the agent can open it.
    return {
      ok: true,
      watchId,
      opened: false,
      openError: output?.error?.message ?? response.error?.message ?? response.status,
      openWith: { capability: 'ui.application.open', input: openInput },
    };
  }

  private runningTaskIn(sessionId: string): TaskEntry | null {
    return (
      this.tasks
        .list()
        .find((entry) => entry.state === 'running' && entry.sessionId === sessionId) ?? null
    );
  }

  private async recordStart(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const sessionId = stringArg(args, 'sessionId');
    const target = this.host.sessionTarget(sessionId);
    if (!target) return { ok: false, error: `BROWSER_NO_SESSION: ${sessionId} is not open` };
    for (const active of this.recordings.values()) {
      if (active.sessionId === sessionId)
        return {
          ok: false,
          error: 'BROWSER_ALREADY_RECORDING: stop the current recording first',
          recordingId: active.recording.id,
        };
    }
    try {
      const recording = await this.recorder.start(target, this.videoPath(sessionId, 'session'));
      this.recordings.set(recording.id, { recording, sessionId });
      return { ok: true, recordingId: recording.id, path: recording.outputPath };
    } catch (error) {
      if (error instanceof RecorderUnavailable)
        return { ok: false, status: 'recorder_unavailable', error: error.message };
      throw error;
    }
  }

  private async recordStop(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const id = stringArg(args, 'recordingId');
    const active = this.recordings.get(id);
    if (!active) return { ok: false, error: 'BROWSER_NO_RECORDING: no such recording' };
    this.recordings.delete(id);
    try {
      const video = await this.recorder.stop(active.recording);
      return { ok: true, recordingId: id, video };
    } catch (error) {
      return {
        ok: false,
        status: 'recorder_failed',
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private videoPath(folder: string, label: string): string {
    return path.join(this.host.artifactRoot(), folder, `${label}-${String(Date.now())}.mp4`);
  }
}

export function defaultArtifactRoot(artifactDir?: string): string {
  return artifactDir ?? path.join(os.tmpdir(), 'marshal-browser', 'artifacts');
}

function stringArg(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== 'string' || !value) throw new Error(`BROWSER_BAD_INPUT: ${key} is required`);
  return value;
}
