/**
 * Live views of a task or session. A watch holds the newest screencast frame of the tab it follows plus the task's
 * step and phase; the side-panel application polls `browser.watch.frame` for them through the host's UI bridge (the
 * panel is a sandboxed iframe with no network, so frames reach it only as capability results).
 *
 * The screencast runs only while someone looks: it starts when the watch is opened or polled and stops when no poll
 * came for IDLE_MS, when the watch is closed, or when the task ends (the last frame stays for the panel to show).
 * Frames are sized to the panel: each poll may carry the panel's size in device pixels, and the screencast is asked
 * for exactly that (src/watch/geometry.ts), so the browser downsamples once and the panel draws 1:1.
 *
 * A panel that asks to fit (`view.fit`) gets more: the page itself takes the panel's size, like a browser pane, so it
 * reflows to the pane and fills it edge to edge instead of a fixed desktop page shrunk into it. Only on the managed
 * backend, never when the caller set the viewport itself, never while something else (a recording) consumes the tab's
 * frames, and only for one panel at a time (the first to ask keeps it while it polls). The page has that size only
 * while a panel shows it: closing the watch, or no poll for IDLE_MS, puts the default size back.
 *
 * A picture at the page's own size is kept sharp. Chrome's screencast sends JPEG frames with at most one pixel per CSS
 * pixel, so on a dense screen they are half the pane's pixels. A calm page (a change now and then: a click's result, a
 * blinking caret) therefore gets one capture at its own device pixels per change, shown instead of the frame; a page
 * in motion (scrolling, an animation) streams the frames and gets a capture once it rests. Chrome also sends frames
 * for its own capture (an echo, not always the same bytes as before), so a frame inside a capture or just after it is
 * not shown: the page is looked at once more instead, and an unchanged page (the same bytes) ends it there. A capture
 * Chrome does not answer (the page navigated under it) is given up after CAPTURE_SLOW_MS: frames are shown again.
 * A typed address is only ever http or https (src/watch/geometry.ts).
 *
 * A person may also use the page from the panel (`browser.watch.input`): click, wheel, named keys, printable text,
 * back / forward / reload. Only for a session on the managed backend that no task drives; never on the person's own
 * Chrome or an app; rate-limited; text and editing keys never reach a focused password, code or card field.
 */
import { randomUUID } from 'node:crypto';
import { open } from 'node:fs/promises';
import { jpegSize } from '../chrome/screencast.js';
import { describeTask, KEPT_FRAME_MAX_BYTES, type TaskEntry } from '../tasks.js';
import {
  MODIFIERS,
  PRESS_KEYS,
  type ActOutcome,
  type Modifier,
  type PageLocation,
  type PanelFit,
  type PanelInput,
  type PressKey,
  type ScreencastFrameMeta,
  type ScreencastHandle,
  type Target,
} from '../target.js';
import {
  FRAME_MAX_BYTES,
  QUALITY,
  STREAM_LIMITS,
  addressOf,
  framePoint,
  panelFit,
  sizeChanged,
  streamSize,
} from './geometry.js';

/** What a panel says about itself with each poll. */
export interface PanelView {
  /** The picture area in device pixels. */
  readonly width: number;
  readonly height: number;
  /** The panel's devicePixelRatio (screen density times the app's zoom). */
  readonly dpr?: number;
  /** The panel wants the page sized to it. */
  readonly fit?: boolean;
  /** Which panel this is (one watch can be drawn by two: the docked panel and a second window). */
  readonly viewer?: string;
}

export type WatchSource =
  | { readonly kind: 'task'; readonly entry: TaskEntry }
  | {
      readonly kind: 'session';
      readonly sessionId: string;
      /** The live tab, or null once the session closed. */
      readonly target: () => Target | null;
      /** The task running in this session now, if any (its step and the Stop button). */
      readonly task?: () => TaskEntry | null;
      /** The task that last ended in this session, if any (the panel says how it ended for a while). */
      readonly lastTask?: () => TaskEntry | null;
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
  readonly mimeType?: 'image/jpeg' | 'image/png';
  /** The task's last picture, shown when this watch saw no live frame of a finished task (opened after it ended). */
  readonly final?: boolean;
  /** A still at the page's own device pixels, taken once frames stopped. */
  readonly sharp?: boolean;
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
  view: PanelView | undefined;
  quality: number;
  location: PageLocation & { at: number };
  locating: boolean;
  /** The panel the page is sized to, and when it last polled. */
  owner: { viewer: string; at: number } | null;
  /** The size this watch gave the page, or null when it gave none. */
  fitted: PanelFit | null;
  fitting: boolean;
  /** The caller set the viewport: this watch never resizes the page. */
  pinned: boolean;
  /** The frame sequence a still at rest was last tried for (once per rest). */
  stillFor: number;
  stilling: boolean;
  /** When the capture in flight began, and when the last one ended (frames just after it are its echo). */
  stillBegan: number;
  stillAt: number;
  /** A frame arrived inside a capture or its echo: the page may have changed, so it is looked at once more. */
  recheck: boolean;
  /** The last look found the page unchanged: its own echo asks for no further look. */
  settled: boolean;
  /** The bytes of the newest still (an unchanged page gives the same bytes again). */
  stillData: string | null;
  /** The frame a capture is replacing, shown instead if the capture cannot be taken. */
  held: Frame | null;
  /** When the recent frames arrived (three in a short while: the page is moving). */
  arrivals: number[];
  /** Times of recent inputs (rate limit). */
  inputs: number[];
  /** Inputs run one after another, in the order the panel sent them. */
  chain: Promise<unknown>;
  /** The final screenshot was looked for once (a finished task's watch without a live frame). */
  finalTried: boolean;
}

/** Without a poll for this long, the screencast stops (the panel was closed or hidden). */
export const IDLE_MS = 15_000;
const MAX_WATCHES = 20;
/** The address bar is refreshed at most this often. */
const LOCATION_MS = 1_000;
const LOCATION_LOADING_MS = 300;
/** A still larger than this is not sent to the panel (the JPEG frame stays). */
export const STILL_MAX_BYTES = 2_100_000;
/** Panel inputs per second per watch; more are refused (the panel also coalesces wheel and text). */
export const INPUT_RATE = 20;
export const TEXT_MAX = 64;
const WHEEL_MAX = 3_000;
/** A final screenshot larger than this is not sent to the panel. */
const FINAL_MAX_BYTES = 4_000_000;

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
  | { readonly kind: 'reload' }
  | { readonly kind: 'navigate'; readonly url: string };

/** Frames at rest for this long get a still. */
export const STILL_AFTER_MS = 280;
/** How long a session's watch still carries the task that last ended in it. */
export const ENDED_MS = 60_000;
/** A frame inside a capture, or this long after it, is the capture's echo. */
export const ECHO_MS = 150;
/**
 * A capture takes tens of milliseconds. One still unanswered after this long is stuck (Chrome never answers a capture
 * when the page navigates under it): frames are shown again and its answer, if any, is dropped.
 */
export const CAPTURE_SLOW_MS = 250;
/** This many frames within this long: the page is moving, and its frames are shown as they come. */
export const MOTION = { frames: 3, withinMs: 400 } as const;
/** A sharp picture at rest is looked at again this often (a change that fell inside an echo is then found). */
export const RECHECK_MS = 5_000;
/** Another panel takes the page's size over only after the first stopped polling for this long. */
export const OWNER_MS = 2_500;
/** The pointer of the automation's last click is shown for this long. */
const POINTER_MS = 6_000;

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
    case 'navigate': {
      const url = typeof event['url'] === 'string' ? addressOf(event['url']) : null;
      if (!url) return 'url must be a web address (http or https)';
      return { kind: 'navigate', url };
    }
    default:
      return 'kind must be click, wheel, key, text, back, forward, reload or navigate';
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
      owner: null,
      fitted: null,
      fitting: false,
      pinned: false,
      stillFor: -1,
      stilling: false,
      stillBegan: 0,
      stillAt: Number.NEGATIVE_INFINITY,
      recheck: false,
      settled: false,
      stillData: null,
      held: null,
      arrivals: [],
      inputs: [],
      chain: Promise.resolve(),
      finalTried: false,
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
  poll(id: string | undefined, since?: number, view?: PanelView): Record<string, unknown> {
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
      watch.view = { ...view, width: Math.round(view.width), height: Math.round(view.height) };
    this.fit(watch);
    this.ensureStream(watch);
    this.refreshLocation(watch);
    this.loadFinal(watch);
    this.sharpen(watch);
    const info: Record<string, unknown> =
      watch.source.kind === 'task'
        ? describeTask(watch.source.entry, now)
        : this.sessionInfo(watch.source);
    const target = this.currentTarget(watch);
    const viewOnly = viewOnlyReason(watch.source, target);
    const frame = watch.frame;
    const fresh = frame !== null && (since === undefined || since < watch.seq);
    const size = target?.viewport?.();
    const pointer = target?.pointer;
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
      ...(target && watch.location.loading ? { loading: true } : {}),
      ...(watch.location.canGoBack !== undefined ? { canGoBack: watch.location.canGoBack } : {}),
      ...(watch.location.canGoForward !== undefined
        ? { canGoForward: watch.location.canGoForward }
        : {}),
      ...(size
        ? {
            page: {
              width: size.width,
              height: size.height,
              deviceScaleFactor: size.deviceScaleFactor,
              // The page has this panel's size (it draws edge to edge); else it draws the page scaled to fit.
              fit: watch.fitted !== null && this.owns(watch, view?.viewer, now),
              pinned: size.pinned,
            },
          }
        : {}),
      ...(pointer && size && now - pointer.at < POINTER_MS
        ? {
            pointer: {
              nx: Math.min(1, Math.max(0, pointer.x / size.width)),
              ny: Math.min(1, Math.max(0, pointer.y / size.height)),
              at: pointer.at,
            },
          }
        : {}),
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
              mimeType: frame.mimeType ?? 'image/jpeg',
              ...(frame.final ? { final: true } : {}),
              ...(frame.sharp ? { sharp: true } : {}),
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
    if (event.kind === 'navigate') return target.act({ kind: 'navigate', url: event.url });
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
    const now = this.now();
    const last = open ? (source.lastTask?.() ?? null) : null;
    const ended =
      last?.state === 'finished' && last.finishedAt !== null && now - last.finishedAt < ENDED_MS
        ? { ...describeTask(last, now), finishedAt: last.finishedAt }
        : null;
    return {
      sessionId: source.sessionId,
      state: open ? 'running' : 'finished',
      status: open ? 'open' : 'closed',
      ...(ended ? { ended } : {}),
    };
  }

  async close(id: string): Promise<boolean> {
    const watch = this.watches.get(id);
    if (!watch) return false;
    this.watches.delete(id);
    await this.stopStream(watch);
    await this.unfit(watch);
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

  /** True when `viewer` is the panel the page is sized to (a panel that names no viewer shares one name). */
  private owns(watch: Watch, viewer: string | undefined, now: number): boolean {
    const owner = watch.owner;
    return owner !== null && owner.viewer === (viewer ?? '') && now - owner.at <= OWNER_MS;
  }

  /**
   * Sizes the page to the panel that asks for it (see the file header for when not). One panel owns the size while it
   * polls; a panel that stops asking gets the default size back.
   */
  private fit(watch: Watch): void {
    const view = watch.view;
    const target = this.currentTarget(watch);
    if (!view || !target?.fitToPanel || watch.fitting) return;
    const fitToPanel = target.fitToPanel.bind(target);
    const now = this.now();
    const viewer = view.viewer ?? '';
    const owner = watch.owner;
    if (owner && owner.viewer !== viewer && now - owner.at <= OWNER_MS) return;
    watch.owner = { viewer, at: now };
    // A recording (or another watch) reads the same frames: the page keeps its size while it does.
    const others = (target.screencastConsumers ?? 0) - (watch.streaming?.target === target ? 1 : 0);
    const wanted = view.fit === true && others <= 0 ? panelFit(view) : null;
    const same =
      (wanted === null && watch.fitted === null) ||
      (wanted !== null &&
        watch.fitted !== null &&
        wanted.width === watch.fitted.width &&
        wanted.height === watch.fitted.height &&
        wanted.deviceScaleFactor === watch.fitted.deviceScaleFactor);
    if (same || (wanted !== null && watch.pinned)) return;
    watch.fitting = true;
    const apply = (): Promise<void> =>
      fitToPanel(wanted).then((done) => {
        watch.pinned = !done;
        watch.fitted = done ? wanted : null;
      });
    // After any input already on its way, so a click never lands on a page that moved under it.
    const done = watch.chain.then(apply, apply);
    watch.chain = done.catch(() => undefined);
    void done
      .catch(() => undefined)
      .finally(() => {
        watch.fitting = false;
      });
  }

  /** True when a capture at the page's own device pixels is worth showing instead of this frame. */
  private canSharpen(watch: Watch, target: Target, frame: Frame): boolean {
    if (!target.still || frame.final) return false;
    // Something else reads the frames (a recording): a capture would put its echo into them.
    const others = (target.screencastConsumers ?? 0) - (watch.streaming?.target === target ? 1 : 0);
    if (others > 0) return false;
    // Only a picture at (about) the page's own size: a small panel's frame of a larger page is already downsampled.
    return (
      watch.fitted !== null ||
      (frame.pageWidth !== undefined && frame.width >= frame.pageWidth * 0.9)
    );
  }

  private show(watch: Watch, frame: Frame): void {
    watch.seq += 1;
    watch.frame = frame;
    watch.held = null;
    watch.settled = false;
  }

  /** A screencast frame from the watched tab (see the file header for what is shown and what is not). */
  private onFrame(watch: Watch, target: Target, data: string, meta: ScreencastFrameMeta): void {
    const now = this.now();
    const bytes = Math.floor((data.length * 3) / 4);
    // The task keeps its newest picture, so a panel opened after it ends still shows the page.
    if (watch.source.kind === 'task' && bytes <= KEPT_FRAME_MAX_BYTES)
      watch.source.entry.lastFrame = {
        data,
        width: meta.width,
        height: meta.height,
        bytes,
        at: now,
      };
    // Keep frames bounded: a heavy page gets a lower quality from the next poll on.
    if (bytes > FRAME_MAX_BYTES && watch.quality > QUALITY.min)
      watch.quality = Math.max(QUALITY.min, watch.quality - QUALITY.step);
    const stuck = watch.stilling && now - watch.stillBegan > CAPTURE_SLOW_MS;
    if (!stuck && (watch.stilling || now - watch.stillAt < ECHO_MS)) {
      watch.recheck = true;
      return;
    }
    const frame: Frame = {
      data,
      width: meta.width,
      height: meta.height,
      ts: meta.ts,
      receivedAt: now,
      bytes,
      ...(meta.pageWidth && meta.pageHeight
        ? { pageWidth: meta.pageWidth, pageHeight: meta.pageHeight }
        : {}),
    };
    watch.settled = false;
    watch.arrivals = watch.arrivals.filter((at) => now - at < MOTION.withinMs);
    watch.arrivals.push(now);
    if (
      !watch.stilling &&
      watch.arrivals.length < MOTION.frames &&
      this.canSharpen(watch, target, frame)
    ) {
      watch.held = frame;
      this.capture(watch, target);
      return;
    }
    this.show(watch, frame);
  }

  /**
   * Takes the page at its own device pixels and shows it, unless it is the picture already shown (an unchanged page
   * gives the same bytes). When it cannot be taken (a dialog, the decision marks, too large), the frame it was to
   * replace is shown.
   */
  private capture(watch: Watch, target: Target): void {
    if (!target.still || watch.stilling) return;
    watch.stilling = true;
    watch.stillBegan = this.now();
    const seq = watch.seq;
    const shown = watch.frame;
    const fallBack = (): void => {
      const held = watch.held;
      watch.held = null;
      if (held && watch.seq === seq) this.show(watch, held);
    };
    target
      .still()
      .then((still) => {
        if (this.currentTarget(watch) !== target || watch.seq !== seq) {
          watch.held = null;
          return;
        }
        const bytes = still ? Math.floor((still.data.length * 3) / 4) : 0;
        if (!still || bytes > STILL_MAX_BYTES) {
          fallBack();
          return;
        }
        if (shown?.sharp && still.data === watch.stillData) {
          watch.held = null;
          watch.settled = true;
          return;
        }
        const now = this.now();
        const held = watch.held;
        watch.stillData = still.data;
        this.show(watch, {
          data: still.data,
          mimeType: still.mimeType,
          width: still.width,
          height: still.height,
          pageWidth: still.pageWidth,
          pageHeight: still.pageHeight,
          ts: now,
          // "Last change": the frame this replaces; a JPEG frame at rest did not change by being sharpened.
          receivedAt: held?.receivedAt ?? (shown && !shown.sharp ? shown.receivedAt : now),
          bytes,
          sharp: true,
        });
      }, fallBack)
      .finally(() => {
        watch.stilling = false;
        watch.stillAt = this.now();
      });
  }

  /**
   * The poll's part in keeping the picture sharp: the look after an echo, a still for a page that came to rest after
   * moving (once per rest), and the slow second look at a sharp picture.
   */
  private sharpen(watch: Watch): void {
    const target = this.currentTarget(watch);
    const now = this.now();
    if (!target?.still || watch.stilling || now - watch.stillAt < ECHO_MS) return;
    if (watch.recheck) {
      watch.recheck = false;
      const settled = watch.settled;
      watch.settled = false;
      if (!settled) {
        this.capture(watch, target);
        return;
      }
    }
    const frame = watch.frame;
    if (!frame || !this.canSharpen(watch, target, frame)) return;
    if (frame.sharp) {
      if (now - watch.stillAt >= RECHECK_MS) this.capture(watch, target);
      return;
    }
    if (watch.stillFor === watch.seq || now - frame.receivedAt < STILL_AFTER_MS) return;
    watch.stillFor = watch.seq;
    this.capture(watch, target);
  }

  private refreshLocation(watch: Watch): void {
    const target = this.currentTarget(watch);
    // While the page loads the bar is read more often, so the loading line ends when the page does.
    const every = watch.location.loading ? LOCATION_LOADING_MS : LOCATION_MS;
    if (!target?.location || watch.locating || this.now() - watch.location.at < every) return;
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

  /**
   * A task's watch that has no live frame yet (opened or re-mounted later, or after the task ended) shows the task's
   * kept last picture at once; a finished task with none falls back to its final screenshot file, read once, only
   * from the task's own result.
   */
  private loadFinal(watch: Watch): void {
    if (watch.source.kind !== 'task') return;
    const entry = watch.source.entry;
    const kept = entry.lastFrame;
    // A live watch of a task that just ended moves to the clean end picture, taken after its last live frame.
    const newer =
      watch.frame !== null &&
      watch.frame.final !== true &&
      entry.state === 'finished' &&
      kept !== null &&
      kept.at > watch.frame.receivedAt;
    if (watch.frame && !newer) return;
    if (kept) {
      watch.seq += 1;
      watch.frame = {
        data: kept.data,
        width: kept.width,
        height: kept.height,
        bytes: kept.bytes,
        ts: kept.at,
        receivedAt: kept.at,
        ...(entry.state === 'finished' ? { final: true } : {}),
      };
      return;
    }
    if (entry.state !== 'finished' || watch.finalTried) return;
    watch.finalTried = true;
    const path = finalScreenshot(entry.output);
    if (!path) return;
    void readImage(path)
      .then((image) => {
        if (!image || watch.frame) return;
        const at = entry.finishedAt ?? this.now();
        watch.seq += 1;
        watch.frame = { ...image, ts: at, receivedAt: at, final: true };
      })
      .catch(() => undefined);
  }

  private ensureStream(watch: Watch): void {
    const target = this.currentTarget(watch);
    // A page sized to the panel streams its own pixels (Chrome sends at most one per CSS pixel): ask for the
    // largest, so the screencast never restarts while the pane is dragged.
    const size = watch.fitted
      ? { maxWidth: STREAM_LIMITS.maxWidth, maxHeight: STREAM_LIMITS.maxHeight }
      : streamSize(watch.view);
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
          this.onFrame(watch, target, data, meta);
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
    watch.held = null;
    watch.arrivals = [];
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
      // Nobody looking: the page gets its default size back (a size it has only while a panel shows it).
      if (now - watch.lastPoll > IDLE_MS) await this.unfit(watch);
      if (now - watch.lastPoll > 10 * 60_000) await this.close(watch.id);
    }
  }

  /** Gives the page its default size back when this watch sized it to a panel. */
  private async unfit(watch: Watch): Promise<void> {
    if (!watch.fitted) return;
    watch.fitted = null;
    watch.owner = null;
    const target = this.currentTarget(watch);
    const restore = async (): Promise<void> => {
      await target?.fitToPanel?.(null);
    };
    const done = watch.chain.then(restore, restore);
    watch.chain = done.catch(() => undefined);
    await done.catch(() => undefined);
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

/** The path of a task result's final screenshot (else its last screenshot), or null. */
export function finalScreenshot(output: Record<string, unknown> | null): string | null {
  const artifacts = output?.['artifacts'];
  if (!Array.isArray(artifacts)) return null;
  const shots = artifacts.filter(
    (artifact): artifact is { kind: string; path: string; label?: string } =>
      typeof artifact === 'object' &&
      artifact !== null &&
      (artifact as { kind?: unknown }).kind === 'screenshot' &&
      typeof (artifact as { path?: unknown }).path === 'string',
  );
  return (shots.find((shot) => shot.label === 'final') ?? shots.at(-1))?.path ?? null;
}

/** A PNG or JPEG file as a panel frame (base64, size), or null when it is not a small regular image file. */
async function readImage(
  path: string,
): Promise<Pick<Frame, 'data' | 'width' | 'height' | 'bytes' | 'mimeType'> | null> {
  const handle = await open(path, 'r');
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size === 0 || info.size > FINAL_MAX_BYTES) return null;
    const bytes = await handle.readFile();
    const data = bytes.toString('base64');
    if (bytes.length > 24 && bytes.readUInt32BE(0) === 0x89504e47)
      return {
        data,
        mimeType: 'image/png',
        width: bytes.readUInt32BE(16),
        height: bytes.readUInt32BE(20),
        bytes: bytes.length,
      };
    const size = jpegSize(data);
    return size ? { data, mimeType: 'image/jpeg', ...size, bytes: bytes.length } : null;
  } finally {
    await handle.close();
  }
}
