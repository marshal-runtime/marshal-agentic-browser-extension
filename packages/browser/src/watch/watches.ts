/**
 * Live views of a task or session. A watch holds the newest screencast frame of the tab it follows plus the task's
 * step and phase; the side-panel application polls `browser.watch.frame` for them through the host's UI bridge (the
 * panel is a sandboxed iframe with no network, so frames reach it only as capability results).
 *
 * The screencast runs only while someone looks: it starts when the watch is opened or polled and stops when no poll
 * came for IDLE_MS, when the watch is closed, or when the task ends (the last frame stays for the panel to show).
 */
import { randomUUID } from 'node:crypto';
import { describeTask, type TaskEntry } from '../tasks.js';
import type { ScreencastHandle, Target } from '../target.js';

export type WatchSource =
  | { readonly kind: 'task'; readonly entry: TaskEntry }
  | {
      readonly kind: 'session';
      readonly sessionId: string;
      /** The live tab, or null once the session closed. */
      readonly target: () => Target | null;
      /** The task running in this session now, if any (its step and the Stop button). */
      readonly task?: () => TaskEntry | null;
    };

interface Frame {
  readonly data: string;
  readonly width: number;
  readonly height: number;
  readonly ts: number;
}

interface Watch {
  readonly id: string;
  readonly source: WatchSource;
  readonly createdAt: number;
  lastPoll: number;
  seq: number;
  frame: Frame | null;
  streaming: { target: Target; handle: Promise<ScreencastHandle | null> } | null;
  error: string | null;
}

/** Without a poll for this long, the screencast stops (the panel was closed or hidden). */
export const IDLE_MS = 15_000;
const MAX_WATCHES = 20;
const FRAME_WIDTH = 960;

export class WatchRegistry {
  private readonly watches = new Map<string, Watch>();
  private readonly timer: ReturnType<typeof setInterval>;

  constructor(private readonly now: () => number = Date.now) {
    this.timer = setInterval(() => {
      void this.sweep();
    }, 5_000);
    this.timer.unref();
  }

  /** Starts a watch and its screencast; returns the watch id the panel polls with. */
  open(source: WatchSource): string {
    if (this.watches.size >= MAX_WATCHES) {
      const oldest = [...this.watches.values()].sort((a, b) => a.lastPoll - b.lastPoll)[0];
      if (oldest) void this.close(oldest.id);
    }
    const watch: Watch = {
      id: randomUUID(),
      source,
      createdAt: this.now(),
      lastPoll: this.now(),
      seq: 0,
      frame: null,
      streaming: null,
      error: null,
    };
    this.watches.set(watch.id, watch);
    this.ensureStream(watch);
    return watch.id;
  }

  has(id: string): boolean {
    return this.watches.has(id);
  }

  /** True while the watch's screencast is running (tests check it stops). */
  streaming(id: string): boolean {
    return (this.watches.get(id)?.streaming ?? null) !== null;
  }

  /**
   * The panel's poll: the task's state and, when a newer frame exists than `since`, the frame itself. Polling also
   * keeps (or restarts) the screencast.
   */
  poll(id: string, since?: number): Record<string, unknown> {
    const watch = this.watches.get(id);
    if (!watch)
      return {
        ok: false,
        error: 'BROWSER_NO_WATCH: this watch has ended (open a new one with browser.watch)',
      };
    watch.lastPoll = this.now();
    this.ensureStream(watch);
    const info: Record<string, unknown> =
      watch.source.kind === 'task'
        ? describeTask(watch.source.entry, this.now())
        : this.sessionInfo(watch.source);
    const fresh = watch.frame && (since === undefined || since < watch.seq);
    return {
      ok: true,
      watchId: watch.id,
      kind: watch.source.kind,
      ...info,
      seq: watch.seq,
      ...(watch.error ? { streamError: watch.error } : {}),
      ...(fresh && watch.frame
        ? {
            frame: {
              data: watch.frame.data,
              mimeType: 'image/jpeg',
              width: watch.frame.width,
              height: watch.frame.height,
              ts: watch.frame.ts,
            },
          }
        : {}),
    };
  }

  private sessionInfo(source: Extract<WatchSource, { kind: 'session' }>): Record<string, unknown> {
    const task = source.task?.() ?? null;
    if (task) return { ...describeTask(task, this.now()), sessionId: source.sessionId };
    const open = source.target() !== null;
    return {
      sessionId: source.sessionId,
      state: open ? 'running' : 'finished',
      status: open ? 'open' : 'closed',
    };
  }

  async close(id: string): Promise<boolean> {
    const watch = this.watches.get(id);
    if (!watch) return false;
    this.watches.delete(id);
    await this.stopStream(watch);
    return true;
  }

  async dispose(): Promise<void> {
    clearInterval(this.timer);
    await Promise.all([...this.watches.keys()].map((id) => this.close(id)));
  }

  private currentTarget(watch: Watch): Target | null {
    if (watch.source.kind === 'task') {
      const entry = watch.source.entry;
      return entry.state === 'running' ? entry.target : null;
    }
    return watch.source.target();
  }

  private ensureStream(watch: Watch): void {
    const target = this.currentTarget(watch);
    if (watch.streaming && watch.streaming.target === target) return;
    if (watch.streaming) void this.stopStream(watch);
    if (!target) return;
    if (!target.screencast) {
      watch.error = `the ${target.backend} backend has no live view`;
      return;
    }
    const screencast = target.screencast.bind(target);
    const handle = screencast({ maxWidth: FRAME_WIDTH }, (data, meta) => {
      watch.seq += 1;
      watch.frame = { data, width: meta.width, height: meta.height, ts: meta.ts };
    }).catch((error: unknown) => {
      watch.error = error instanceof Error ? error.message : String(error);
      if (watch.streaming?.handle === handle) watch.streaming = null;
      return null;
    });
    watch.streaming = { target, handle };
    watch.error = null;
  }

  private async stopStream(watch: Watch): Promise<void> {
    const streaming = watch.streaming;
    watch.streaming = null;
    const handle = await streaming?.handle;
    await handle?.stop().catch(() => undefined);
  }

  private async sweep(): Promise<void> {
    const now = this.now();
    for (const watch of [...this.watches.values()]) {
      const target = this.currentTarget(watch);
      // Nobody looking, or nothing left to look at: stop the screencast; drop the watch after a long silence.
      if (
        watch.streaming &&
        (now - watch.lastPoll > IDLE_MS || watch.streaming.target !== target)
      ) {
        await this.stopStream(watch);
      }
      if (now - watch.lastPoll > 10 * 60_000) await this.close(watch.id);
    }
  }

  /** Runs the idle check now (tests). */
  async check(): Promise<void> {
    await this.sweep();
  }
}
