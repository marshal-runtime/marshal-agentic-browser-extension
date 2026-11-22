/**
 * Live views of a task or session. A watch holds the newest screencast frame of the tab it follows plus the task's
 * step and phase; the side-panel application polls `browser.watch.frame` for them through the host's UI bridge (the
 * panel is a sandboxed iframe with no network, so frames reach it only as capability results).
 *
 * The screencast runs only while someone looks: it starts when the watch is opened or polled and stops when no poll
 * came for IDLE_MS, when the watch is closed, or when the task ends (the last frame stays for the panel to show).
 * Frames are sized to the panel: each poll may carry the panel's size in device pixels, and the screencast is asked
 * for exactly that (src/watch/geometry.ts), so the browser downsamples once and the panel draws 1:1. Who watches never
 * changes the page's own viewport: only the frames are resized.
 *
 * A person may also use the page from the panel (`browser.watch.input`): click, wheel, named keys, printable text,
 * back / forward / reload. Only for a session on the managed backend that no task drives; never on the person's own
 * Chrome or an app; rate-limited; text and editing keys never reach a focused password, code or card field.
 */
import { randomUUID } from 'node:crypto';
import { describeTask, type TaskEntry } from '../tasks.js';
import {
  MODIFIERS,
  PRESS_KEYS,
  type ActOutcome,
  type Modifier,
  type PanelInput,
  type PressKey,
  type ScreencastHandle,
  type Target,
} from '../target.js';
import { FRAME_MAX_BYTES, QUALITY, framePoint, sizeChanged, streamSize } from './geometry.js';

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
  /** When the extension received it (the panel's "last change"). */
  readonly receivedAt: number;
  readonly bytes: number;
  readonly pageWidth?: number;
  readonly pageHeight?: number;
}

interface Stream {
  readonly target: Target;
  readonly handle: Promise<ScreencastHandle | null>;
  readonly size: { maxWidth: number; maxHeight: number };
  readonly quality: number;
}

interface Watch {
  readonly id: string;
  readonly source: WatchSource;
  readonly createdAt: number;
  lastPoll: number;
  seq: number;
  frame: Frame | null;
  streaming: Stream | null;
  error: string | null;
  /** The panel's picture size in device pixels, from its newest poll. */
  view: { width: number; height: number } | undefined;
  quality: number;
  location: { url: string; title: string; at: number };
  locating: boolean;
  /** Times of recent inputs (rate limit). */
  inputs: number[];
  /** Inputs run one after another, in the order the panel sent them. */
  chain: Promise<unknown>;
}

/** Without a poll for this long, the screencast stops (the panel was closed or hidden). */
export const IDLE_MS = 15_000;
const MAX_WATCHES = 20;
/** The address bar is refreshed at most this often. */
const LOCATION_MS = 1_000;
/** Panel inputs per second per watch; more are refused (the panel also coalesces wheel and text). */
export const INPUT_RATE = 20;
export const TEXT_MAX = 64;
const WHEEL_MAX = 3_000;

/** Why a watch is view-only (the panel words it); undefined when the person may use the page. */
export type ViewOnlyReason = 'task' | 'closed' | 'user' | 'app' | 'unsupported';

export type PanelEvent =
  | { readonly kind: 'click'; readonly nx: number; readonly ny: number; readonly clickCount: 1 | 2 }
  | {
      readonly kind: 'wheel';
      readonly nx: number;
      readonly ny: number;
      readonly deltaX: number;
      readonly deltaY: number;
    }
  | { readonly kind: 'key'; readonly key: PressKey; readonly modifiers: readonly Modifier[] }
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'back' }
  | { readonly kind: 'forward' }
  | { readonly kind: 'reload' };

/** The panel's input, checked; a string names what is wrong (BROWSER_BAD_INPUT). */
export function parsePanelEvent(raw: unknown): PanelEvent | string {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
    return 'event must be an object';
  const event = raw as Record<string, unknown>;
  const finite = (value: unknown): value is number =>
    typeof value === 'number' && Number.isFinite(value);
  const unit = (value: unknown): value is number => finite(value) && value >= 0 && value <= 1;
  switch (event['kind']) {
    case 'click': {
      if (!unit(event['nx']) || !unit(event['ny'])) return 'click needs nx and ny from 0 to 1';
      return {
        kind: 'click',
        nx: event['nx'],
        ny: event['ny'],
        clickCount: event['clickCount'] === 2 ? 2 : 1,
      };
    }
    case 'wheel': {
      if (!unit(event['nx']) || !unit(event['ny'])) return 'wheel needs nx and ny from 0 to 1';
      const dx = event['deltaX'] ?? 0;
      const dy = event['deltaY'] ?? 0;
      if (!finite(dx) || !finite(dy)) return 'wheel needs numeric deltaX and deltaY';
      const clamp = (value: number): number =>
        Math.max(-WHEEL_MAX, Math.min(WHEEL_MAX, Math.round(value)));
      return {
        kind: 'wheel',
        nx: event['nx'],
        ny: event['ny'],
        deltaX: clamp(dx),
        deltaY: clamp(dy),
      };
    }
    case 'key': {
      const key = event['key'];
      if (typeof key !== 'string' || !(PRESS_KEYS as readonly string[]).includes(key))
        return `key must be one of ${PRESS_KEYS.join(', ')}`;
      const modifiers = event['modifiers'] ?? [];
      if (
        !Array.isArray(modifiers) ||
        !modifiers.every((modifier) => (MODIFIERS as readonly unknown[]).includes(modifier))
      )
        return `modifiers must be from ${MODIFIERS.join(', ')}`;
      return { kind: 'key', key: key as PressKey, modifiers: modifiers as Modifier[] };
    }
    case 'text': {
      const text = event['text'];
      if (typeof text !== 'string' || text.length === 0 || text.length > TEXT_MAX)
        return `text must be 1 to ${String(TEXT_MAX)} characters`;
      // Printable only: a control character (Enter, Tab, Backspace) is a named key, which has its own checks.
      if (/\p{Cc}/u.test(text))
        return 'text must be printable (send Enter, Tab and the like as a key)';
      return { kind: 'text', text };
    }
    case 'back':
      return { kind: 'back' };
    case 'forward':
      return { kind: 'forward' };
    case 'reload':
      return { kind: 'reload' };
    default:
      return 'kind must be click, wheel, key, text, back, forward or reload';
  }
}

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
      view: undefined,
      quality: QUALITY.start,
      location: { url: '', title: '', at: 0 },
      locating: false,
      inputs: [],
      chain: Promise.resolve(),
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

  /** The size and quality the watch's screencast was asked for (tests). */
  streamSettings(id: string): { maxWidth: number; maxHeight: number; quality: number } | null {
    const stream = this.watches.get(id)?.streaming;
    return stream ? { ...stream.size, quality: stream.quality } : null;
  }

  /**
   * The panel's poll: the task's state and, when a newer frame exists than `since`, the frame itself. Polling also
   * keeps (or restarts) the screencast; `view` (the panel's picture in device pixels) resizes it.
   */
  poll(
    id: string | undefined,
    since?: number,
    view?: { width: number; height: number },
  ): Record<string, unknown> {
    // Without an id (a panel opened by hand): the newest watch.
    const watch =
      id === undefined
        ? [...this.watches.values()].sort((a, b) => b.createdAt - a.createdAt)[0]
        : this.watches.get(id);
    if (!watch)
      return {
        ok: false,
        error:
          id === undefined
            ? 'BROWSER_NO_WATCH: nothing is being watched (start one with browser.watch)'
            : 'BROWSER_NO_WATCH: this watch has ended (open a new one with browser.watch)',
      };
    const now = this.now();
    watch.lastPoll = now;
    if (view && view.width > 0 && view.height > 0)
      watch.view = { width: Math.round(view.width), height: Math.round(view.height) };
    this.ensureStream(watch);
    this.refreshLocation(watch);
    const info: Record<string, unknown> =
      watch.source.kind === 'task'
        ? describeTask(watch.source.entry, now)
        : this.sessionInfo(watch.source);
    const target = this.currentTarget(watch);
    const viewOnly = viewOnlyReason(watch.source, target);
    const frame = watch.frame;
    const fresh = frame !== null && (since === undefined || since < watch.seq);
    return {
      ok: true,
      watchId: watch.id,
      kind: watch.source.kind,
      ...info,
      seq: watch.seq,
      now,
      ...(target ? { backend: target.backend } : {}),
      url: watch.location.url,
      title: watch.location.title,
      interactive: viewOnly === undefined,
      ...(viewOnly ? { viewOnly } : {}),
      ...(frame
        ? {
            lastFrameAt: frame.receivedAt,
            frameBytes: frame.bytes,
            quality: watch.streaming?.quality ?? watch.quality,
          }
        : {}),
      ...(watch.error ? { streamError: watch.error } : {}),
      ...(fresh
        ? {
            frame: {
              data: frame.data,
              mimeType: 'image/jpeg',
              width: frame.width,
              height: frame.height,
              ts: frame.ts,
              ...(frame.pageWidth && frame.pageHeight
                ? { pageWidth: frame.pageWidth, pageHeight: frame.pageHeight }
                : {}),
            },
          }
        : {}),
    };
  }

  /**
   * A person's input from the panel. Refused (`status: view_only`) for a task's watch, while a task drives the
   * session, on the user or app backend, and once the session closed; refused (`rate_limited`) past INPUT_RATE per
   * second. Points arrive as fractions of the frame and are mapped to the page's CSS pixels here. The typed text is
   * never logged or returned.
   */
  async input(id: string, raw: unknown): Promise<Record<string, unknown>> {
    const watch = this.watches.get(id);
    if (!watch) return { ok: false, error: 'BROWSER_NO_WATCH: this watch has ended' };
    const event = parsePanelEvent(raw);
    if (typeof event === 'string') throw new Error(`BROWSER_BAD_INPUT: ${event}`);
    const target = this.currentTarget(watch);
    const viewOnly = viewOnlyReason(watch.source, target);
    if (viewOnly !== undefined || !target) {
      const reason = viewOnly ?? 'closed';
      return {
        ok: false,
        status: 'view_only',
        viewOnly: reason,
        error: `view_only: ${VIEW_ONLY_TEXT[reason]}`,
      };
    }
    const now = this.now();
    watch.inputs = watch.inputs.filter((at) => now - at < 1_000);
    if (watch.inputs.length >= INPUT_RATE)
      return {
        ok: false,
        status: 'rate_limited',
        error: 'rate_limited: too many inputs, slow down',
      };
    watch.inputs.push(now);
    watch.lastPoll = now;
    const run = (): Promise<ActOutcome> => this.perform(watch, target, event);
    const outcome = watch.chain.then(run, run);
    watch.chain = outcome.catch(() => undefined);
    const result = await outcome;
    // An input usually moves the page: read the address bar again on the next poll.
    watch.location = { ...watch.location, at: 0 };
    return {
      ok: result.ok,
      ...(result.error ? { error: result.error } : {}),
      ...(result.error?.startsWith('secret-field:') ? { status: 'secret_field' } : {}),
      ...(result.navigated ? { navigated: true } : {}),
      ...(result.dialog ? { dialog: result.dialog } : {}),
    };
  }

  private async perform(watch: Watch, target: Target, event: PanelEvent): Promise<ActOutcome> {
    if (event.kind === 'back') return target.act({ kind: 'back' });
    if (event.kind === 'forward') return target.act({ kind: 'forward' });
    if (event.kind === 'reload') return target.act({ kind: 'reload' });
    if (!target.panelInput) return { ok: false, error: VIEW_ONLY_TEXT.unsupported };
    let input: PanelInput;
    if (event.kind === 'click' || event.kind === 'wheel') {
      const frame = watch.frame;
      const page =
        frame?.pageWidth && frame.pageHeight
          ? { width: frame.pageWidth, height: frame.pageHeight }
          : null;
      const point = page ? framePoint(event.nx, event.ny, page) : null;
      if (!point) return { ok: false, error: 'no-frame: wait for the picture before clicking' };
      input =
        event.kind === 'click'
          ? { kind: 'click', ...point, clickCount: event.clickCount }
          : { kind: 'wheel', ...point, deltaX: event.deltaX, deltaY: event.deltaY };
    } else {
      input = event;
    }
    return target.panelInput(input);
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

  private refreshLocation(watch: Watch): void {
    const target = this.currentTarget(watch);
    if (!target?.location || watch.locating || this.now() - watch.location.at < LOCATION_MS) return;
    watch.locating = true;
    target
      .location()
      .then((location) => {
        watch.location = { ...location, at: this.now() };
      })
      .catch(() => {
        // A dialog or a navigation in flight: keep the last address, try again on a later poll.
        watch.location = { ...watch.location, at: this.now() };
      })
      .finally(() => {
        watch.locating = false;
      });
  }

  private ensureStream(watch: Watch): void {
    const target = this.currentTarget(watch);
    const size = streamSize(watch.view);
    const running = watch.streaming;
    if (
      running &&
      running.target === target &&
      running.quality === watch.quality &&
      !sizeChanged(running.size, size)
    )
      return;
    // Stop before starting again: a single consumer then gets exactly the new size (the hub never shrinks a
    // screencast another consumer still holds).
    const previous = running ? this.stopStream(watch) : Promise.resolve();
    if (!target) return;
    if (!target.screencast) {
      watch.error = `the ${target.backend} backend has no live view`;
      return;
    }
    const screencast = target.screencast.bind(target);
    const quality = watch.quality;
    const handle: Promise<ScreencastHandle | null> = previous
      .then(() =>
        screencast({ ...size, quality }, (data, meta) => {
          const bytes = Math.floor((data.length * 3) / 4);
          watch.seq += 1;
          watch.frame = {
            data,
            width: meta.width,
            height: meta.height,
            ts: meta.ts,
            receivedAt: this.now(),
            bytes,
            ...(meta.pageWidth && meta.pageHeight
              ? { pageWidth: meta.pageWidth, pageHeight: meta.pageHeight }
              : {}),
          };
          // Keep frames bounded: a heavy page gets a lower quality from the next poll on.
          if (bytes > FRAME_MAX_BYTES && watch.quality > QUALITY.min)
            watch.quality = Math.max(QUALITY.min, watch.quality - QUALITY.step);
        }),
      )
      .catch((error: unknown) => {
        watch.error = error instanceof Error ? error.message : String(error);
        if (watch.streaming?.handle === handle) watch.streaming = null;
        return null;
      });
    watch.streaming = { target, handle, size, quality };
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

const VIEW_ONLY_TEXT: Readonly<Record<ViewOnlyReason, string>> = {
  task: 'a task is driving this tab; stop it to use the page yourself',
  closed: 'the session is closed',
  user: "this is the person's own Chrome; use it there",
  app: 'this is a native app; use it there',
  unsupported: 'this backend takes no input from the panel',
};

/** Why the person may not use the page from the panel now, or undefined when they may. */
export function viewOnlyReason(
  source: WatchSource,
  target: Target | null,
): ViewOnlyReason | undefined {
  if (source.kind === 'task') return 'task';
  if (source.task?.()) return 'task';
  if (!target) return 'closed';
  if (target.backend === 'user') return 'user';
  if (target.backend === 'app') return 'app';
  if (!target.panelInput) return 'unsupported';
  return undefined;
}
