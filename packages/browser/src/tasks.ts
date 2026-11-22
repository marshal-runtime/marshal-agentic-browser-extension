/**
 * Task lifecycle for `browser.task`: every task gets an id the moment it is accepted, so a caller can run it in the
 * background (`wait: false`), read its progress (`browser.task.get` / `list`), watch it, and cancel it
 * (`browser.task.cancel`). Cancel fires the task's AbortSignal: the engine stops before its next action, the service
 * closes what the task opened, and the task ends with the typed `cancelled` status.
 */
import { randomUUID } from 'node:crypto';
import type { TaskPhase, TraceStep } from './engine/task.js';
import type { Target } from './target.js';

export type TaskState = 'running' | 'finished';

export interface TaskEntry {
  readonly id: string;
  readonly goal: string;
  readonly startedAt: number;
  readonly controller: AbortController;
  state: TaskState;
  phase: TaskPhase | 'starting' | 'closing';
  /** The tab the task drives, once it is open (the watch panel screencasts it). */
  target: Target | null;
  /** The session id when the task runs in, or keeps, a session. */
  sessionId: string | null;
  steps: number;
  lastStep: TraceStep | null;
  finishedAt: number | null;
  /** The task's final output, as `browser.task` returns it. */
  output: Record<string, unknown> | null;
  done: Promise<Record<string, unknown>>;
}

const KEEP_FINISHED_MS = 30 * 60_000;
const MAX_FINISHED = 50;
const DEFAULT_CANCEL_WAIT_MS = 15_000;

export class TaskRegistry {
  private readonly tasks = new Map<string, TaskEntry>();

  constructor(private readonly now: () => number = Date.now) {}

  /** Registers a task and runs `work` with its entry; the returned entry's `done` settles with the output. */
  start(goal: string, work: (entry: TaskEntry) => Promise<Record<string, unknown>>): TaskEntry {
    this.prune();
    const controller = new AbortController();
    const entry: TaskEntry = {
      id: randomUUID(),
      goal,
      startedAt: this.now(),
      controller,
      state: 'running',
      phase: 'starting',
      target: null,
      sessionId: null,
      steps: 0,
      lastStep: null,
      finishedAt: null,
      output: null,
      done: Promise.resolve({}),
    };
    this.tasks.set(entry.id, entry);
    entry.done = Promise.resolve()
      .then(() => work(entry))
      .catch((error: unknown) => ({
        ok: false,
        taskId: entry.id,
        error: error instanceof Error ? error.message : String(error),
      }))
      .then((output) => {
        entry.output = output;
        entry.state = 'finished';
        entry.finishedAt = this.now();
        entry.target = null;
        return output;
      });
    return entry;
  }

  get(id: string): TaskEntry | undefined {
    return this.tasks.get(id);
  }

  /** Running tasks first, then the most recently finished. */
  list(): TaskEntry[] {
    this.prune();
    return [...this.tasks.values()].sort((a, b) => {
      if (a.state !== b.state) return a.state === 'running' ? -1 : 1;
      return b.startedAt - a.startedAt;
    });
  }

  /**
   * Cancels a running task and waits (bounded) for it to end. A task that already finished is left as it was and
   * reported so; a cancel never rewrites a finished result.
   */
  async cancel(
    id: string,
    waitMs = DEFAULT_CANCEL_WAIT_MS,
  ): Promise<
    | { readonly found: false }
    | {
        readonly found: true;
        readonly wasRunning: boolean;
        readonly entry: TaskEntry;
        readonly settled: boolean;
      }
  > {
    const entry = this.tasks.get(id);
    if (!entry) return { found: false };
    if (entry.state === 'finished') return { found: true, wasRunning: false, entry, settled: true };
    entry.controller.abort();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settled = await Promise.race([
      entry.done.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => {
          resolve(false);
        }, waitMs);
      }),
    ]);
    if (timer) clearTimeout(timer);
    return { found: true, wasRunning: true, entry, settled };
  }

  /** Cancels every running task (the extension is shutting down). */
  async cancelAll(waitMs = 5_000): Promise<void> {
    await Promise.all(
      [...this.tasks.values()]
        .filter((entry) => entry.state === 'running')
        .map((entry) => this.cancel(entry.id, waitMs)),
    );
  }

  private prune(): void {
    const cutoff = this.now() - KEEP_FINISHED_MS;
    const finished = [...this.tasks.values()]
      .filter((entry) => entry.state === 'finished')
      .sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0));
    finished.forEach((entry, index) => {
      if (index >= MAX_FINISHED || (entry.finishedAt ?? 0) < cutoff) this.tasks.delete(entry.id);
    });
  }
}

/** The final status a task's output carries, or `fallback`. */
export function statusOf(output: Record<string, unknown> | null, fallback: string): string {
  const status = output?.['status'];
  return typeof status === 'string' ? status : fallback;
}

/** The public summary of a task, as browser.task.get and browser.task.list return it. */
export function describeTask(entry: TaskEntry, now: number = Date.now()): Record<string, unknown> {
  const status =
    entry.state === 'running'
      ? entry.controller.signal.aborted
        ? 'cancelling'
        : 'running'
      : statusOf(entry.output, entry.output?.['ok'] === false ? 'failed' : 'done');
  return {
    taskId: entry.id,
    goal: entry.goal.slice(0, 300),
    state: entry.state,
    status,
    phase: entry.state === 'running' ? entry.phase : 'finished',
    steps: entry.steps,
    elapsedMs: (entry.finishedAt ?? now) - entry.startedAt,
    ...(entry.sessionId ? { sessionId: entry.sessionId } : {}),
    ...(entry.lastStep ? { lastStep: entry.lastStep } : {}),
  };
}
