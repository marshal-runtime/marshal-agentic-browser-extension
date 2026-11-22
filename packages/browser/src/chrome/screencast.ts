/**
 * Live JPEG frames of one tab through Chrome's own screencast (`Page.startScreencast`) over the CDP connection the
 * tab already holds. Chrome runs one screencast per target, so a `ScreencastHub` multiplexes every consumer of a tab
 * (the watch panel, a recorder) onto one: it starts on the first consumer, restarts when a consumer asks for wider,
 * taller or better frames (it never shrinks a running screencast another consumer holds), and stops (and drops its
 * event listener) when the last consumer stops. Nothing runs while nobody consumes. Chrome never upscales a frame: a
 * request larger than the page gets the page's own pixels. Frames taken while the engine's numbered decision marks are
 * on the page are dropped (acknowledged, never delivered): the marks are for the model, not for the person or a video.
 */
import type { CdpEvent } from './cdp.js';
import type { ScreencastFrameMeta, ScreencastHandle, ScreencastOptions } from '../target.js';

/** The part of `CdpConnection` the hub needs, so tests can drive it with a fake. */
export interface ScreencastChannel {
  send(
    method: string,
    params?: Readonly<Record<string, unknown>>,
    sessionId?: string,
    timeoutMs?: number,
  ): Promise<Record<string, unknown>>;
  onEvent(listener: (event: CdpEvent) => void): () => void;
  readonly closed: boolean;
}

type FrameListener = (jpegBase64: string, meta: ScreencastFrameMeta) => void;

interface Consumer {
  readonly maxWidth: number;
  /** Infinity: no height limit. */
  readonly maxHeight: number;
  readonly quality: number;
  readonly everyNthFrame: number;
  readonly onFrame: FrameListener;
}

const QUALITY = 70;
const MIN_WIDTH = 160;
const MAX_WIDTH = 1920;
const MIN_HEIGHT = 120;
const MAX_HEIGHT = 1920;
const CALL_TIMEOUT_MS = 5_000;

export class ScreencastHub {
  private readonly consumers = new Set<Consumer>();
  private off: (() => void) | null = null;
  /** Size, quality and frame step of the screencast Chrome is running now, or null. */
  private running: Settings | null = null;
  /** Serializes start/restart/stop so two consumers never race Chrome's single screencast. */
  private chain: Promise<void> = Promise.resolve();

  constructor(
    private readonly channel: ScreencastChannel,
    private readonly sessionId: string,
    /** True while frames must not reach consumers (the decision marks are on the page); they are still acknowledged. */
    private readonly held: () => boolean = () => false,
  ) {}

  /** True while Chrome is screencasting for at least one consumer. */
  get active(): boolean {
    return this.running !== null;
  }

  get consumerCount(): number {
    return this.consumers.size;
  }

  async subscribe(options: ScreencastOptions, onFrame: FrameListener): Promise<ScreencastHandle> {
    if (this.channel.closed) throw new Error('BROWSER_SCREENCAST_FAILED: the tab is closed');
    const consumer: Consumer = {
      maxWidth: clampWidth(options.maxWidth),
      maxHeight:
        options.maxHeight === undefined
          ? Number.POSITIVE_INFINITY
          : clamp(options.maxHeight, MIN_HEIGHT, MAX_HEIGHT, 800),
      quality: options.quality === undefined ? QUALITY : clamp(options.quality, 10, 100, QUALITY),
      everyNthFrame: Math.max(1, Math.floor(options.everyNthFrame ?? 1)),
      onFrame,
    };
    this.consumers.add(consumer);
    try {
      await this.serialize(() => this.reconcile());
    } catch (error) {
      this.consumers.delete(consumer);
      await this.serialize(() => this.reconcile()).catch(() => undefined);
      throw error;
    }
    let stopped = false;
    return {
      stop: async () => {
        if (stopped) return;
        stopped = true;
        this.consumers.delete(consumer);
        await this.serialize(() => this.reconcile());
      },
    };
  }

  /** Stops the screencast and forgets every consumer (the tab is closing). */
  async dispose(): Promise<void> {
    this.consumers.clear();
    await this.serialize(() => this.reconcile()).catch(() => undefined);
  }

  private serialize(work: () => Promise<void>): Promise<void> {
    const next = this.chain.then(work, work);
    this.chain = next.catch(() => undefined);
    return next;
  }

  /** Brings Chrome's screencast in line with the current consumers. */
  private async reconcile(): Promise<void> {
    if (this.consumers.size === 0) {
      await this.stopChrome();
      return;
    }
    // The widest, tallest, best and most frequent any consumer asked for. A screencast that already gives at least
    // that keeps running (a consumer leaving never restarts it).
    let maxWidth = 0;
    let maxHeight = 0;
    let quality = 0;
    let everyNthFrame = Number.POSITIVE_INFINITY;
    for (const consumer of this.consumers) {
      maxWidth = Math.max(maxWidth, consumer.maxWidth);
      maxHeight = Math.max(maxHeight, consumer.maxHeight);
      quality = Math.max(quality, consumer.quality);
      everyNthFrame = Math.min(everyNthFrame, consumer.everyNthFrame);
    }
    if (
      this.running &&
      this.running.maxWidth >= maxWidth &&
      this.running.maxHeight >= maxHeight &&
      this.running.quality >= quality &&
      this.running.everyNthFrame <= everyNthFrame
    )
      return;
    if (this.running) await this.stopChrome();
    if (this.channel.closed) throw new Error('BROWSER_SCREENCAST_FAILED: the tab is closed');
    this.off ??= this.channel.onEvent((event) => {
      this.onEvent(event);
    });
    try {
      await this.channel.send(
        'Page.startScreencast',
        {
          format: 'jpeg',
          quality,
          maxWidth,
          ...(Number.isFinite(maxHeight) ? { maxHeight } : {}),
          everyNthFrame,
        },
        this.sessionId,
        CALL_TIMEOUT_MS,
      );
    } catch (error) {
      this.detach();
      throw new Error(
        `BROWSER_SCREENCAST_FAILED: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    this.running = { maxWidth, maxHeight, quality, everyNthFrame };
  }

  private async stopChrome(): Promise<void> {
    const wasRunning = this.running !== null;
    this.running = null;
    this.detach();
    if (wasRunning && !this.channel.closed) {
      await this.channel
        .send('Page.stopScreencast', {}, this.sessionId, CALL_TIMEOUT_MS)
        .catch(() => undefined);
    }
  }

  private detach(): void {
    this.off?.();
    this.off = null;
  }

  private onEvent(event: CdpEvent): void {
    if (event.method !== 'Page.screencastFrame' || event.sessionId !== this.sessionId) return;
    const params = event.params;
    const frameSession = params['sessionId'];
    // Chrome sends the next frame only after this one is acknowledged.
    if (typeof frameSession === 'number' && !this.channel.closed) {
      void this.channel
        .send(
          'Page.screencastFrameAck',
          { sessionId: frameSession },
          this.sessionId,
          CALL_TIMEOUT_MS,
        )
        .catch(() => undefined);
    }
    const data = params['data'];
    if (typeof data !== 'string' || !data) return;
    if (this.held()) return;
    const metadata = (params['metadata'] ?? {}) as {
      timestamp?: number;
      deviceWidth?: number;
      deviceHeight?: number;
    };
    const pageWidth = Math.round(metadata.deviceWidth ?? 0);
    const pageHeight = Math.round(metadata.deviceHeight ?? 0);
    // The frame's own pixel size (scaled to maxWidth), read from the JPEG header; the page's size if unreadable.
    const size = jpegSize(data);
    const meta: ScreencastFrameMeta = {
      ts:
        typeof metadata.timestamp === 'number' ? Math.round(metadata.timestamp * 1000) : Date.now(),
      width: size?.width ?? pageWidth,
      height: size?.height ?? pageHeight,
      ...(pageWidth > 0 && pageHeight > 0 ? { pageWidth, pageHeight } : {}),
    };
    for (const consumer of [...this.consumers]) {
      try {
        consumer.onFrame(data, meta);
      } catch {
        // One consumer's failure never stops the others' frames.
      }
    }
  }
}

/** Width and height from a base64 JPEG's start-of-frame marker, or null when it has none. */
export function jpegSize(base64: string): { width: number; height: number } | null {
  // The SOF marker sits in the first few KB; decode only that much.
  const head = Buffer.from(base64.slice(0, 32_768), 'base64');
  if (head.length < 4 || head[0] !== 0xff || head[1] !== 0xd8) return null;
  let at = 2;
  while (at + 9 < head.length) {
    if (head[at] !== 0xff) return null;
    const marker = head[at + 1] ?? 0;
    const length = head.readUInt16BE(at + 2);
    const isSof =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) return { height: head.readUInt16BE(at + 5), width: head.readUInt16BE(at + 7) };
    at += 2 + length;
  }
  return null;
}

interface Settings {
  maxWidth: number;
  maxHeight: number;
  quality: number;
  everyNthFrame: number;
}

function clamp(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function clampWidth(width: number): number {
  return clamp(width, MIN_WIDTH, MAX_WIDTH, 800);
}
