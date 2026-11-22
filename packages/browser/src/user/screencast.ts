/**
 * Live picture of a `user` tab for a viewer (the side panel). Two transports, picked at start:
 *   - events: a bridge that forwards chrome.debugger's `Page.screencastFrame` (marley-browser-extension's event-forwarding
 *     change) offers `browserbridge.screencast.start/next/stop`; frames are pulled with a long poll on `next`, so the
 *     host's request/response `execute` is enough and no second socket is opened;
 *   - polling: any older bridge. One screenshot every POLL_MS x everyNthFrame, scaled and re-encoded as JPEG here.
 * A bridge without the event verbs answers `start` with not_found (extension_missing); that, and only that, selects
 * polling. Any other failure is the caller's error.
 */
import type {
  ScreencastFrameMeta,
  ScreencastHandle as TargetScreencastHandle,
  ScreencastOptions,
} from '../target.js';
import { BridgeError, type BridgeClient } from './bridge.js';
import { decodePng, encodeJpeg, scaleTo } from './image.js';

export type { ScreencastFrameMeta, ScreencastOptions };

export interface ScreencastHandle extends TargetScreencastHandle {
  /** Which transport is running (for status and tests). */
  readonly mode: 'events' | 'polling';
}

export interface ScreencastDeps {
  readonly bridge: BridgeClient;
  readonly tabId: number;
  readonly capture: () => Promise<{ png: Buffer; cssWidth: number }>;
  readonly sleep: (ms: number) => Promise<void>;
  readonly now: () => number;
  readonly isClosed: () => boolean;
}

/** A low rate: each poll is a full screenshot of the person's tab. */
export const POLL_MS = 1_000;
export const POLL_QUALITY = 60;
const NEXT_TIMEOUT_MS = 5_000;
const EVENT_QUALITY = 60;
const MAX_FAILURES = 3;

export async function startScreencast(
  deps: ScreencastDeps,
  opts: ScreencastOptions,
  onFrame: (jpegBase64: string, meta: ScreencastFrameMeta) => void,
): Promise<ScreencastHandle> {
  const maxWidth = Math.max(64, Math.min(4096, Math.round(opts.maxWidth)));
  const nth = Math.max(1, Math.round(opts.everyNthFrame ?? 1));
  try {
    await deps.bridge.call('browserbridge.screencast.start', {
      tabId: deps.tabId,
      maxWidth,
      everyNthFrame: nth,
      quality: EVENT_QUALITY,
    });
  } catch (error) {
    if (error instanceof BridgeError && error.code === 'extension_missing')
      return poll(deps, maxWidth, nth, onFrame);
    throw error;
  }
  return events(deps, onFrame);
}

function loop(
  deps: ScreencastDeps,
  tick: () => Promise<void>,
  onStop: () => Promise<void>,
): { stop(): Promise<void> } {
  const state = { running: true };
  let failures = 0;
  const done = (async () => {
    while (state.running && !deps.isClosed()) {
      try {
        await tick();
        failures = 0;
      } catch {
        failures += 1;
        if (failures >= MAX_FAILURES) break;
        await deps.sleep(POLL_MS);
      }
    }
    state.running = false;
  })();
  return {
    async stop() {
      state.running = false;
      await done;
      await onStop().catch(() => undefined);
    },
  };
}

function poll(
  deps: ScreencastDeps,
  maxWidth: number,
  nth: number,
  onFrame: (jpegBase64: string, meta: ScreencastFrameMeta) => void,
): ScreencastHandle {
  const interval = POLL_MS * nth;
  const handle = loop(
    deps,
    async () => {
      const began = deps.now();
      const { png } = await deps.capture();
      const image = scaleTo(decodePng(png), maxWidth);
      onFrame(encodeJpeg(image, POLL_QUALITY).toString('base64'), {
        ts: deps.now(),
        width: image.width,
        height: image.height,
      });
      await deps.sleep(Math.max(0, interval - (deps.now() - began)));
    },
    () => Promise.resolve(),
  );
  return { mode: 'polling', stop: () => handle.stop() };
}

interface NextFrame {
  readonly seq?: number;
  readonly data?: string;
  readonly width?: number;
  readonly height?: number;
  readonly ts?: number;
}

function events(
  deps: ScreencastDeps,
  onFrame: (jpegBase64: string, meta: ScreencastFrameMeta) => void,
): ScreencastHandle {
  let after = 0;
  const handle = loop(
    deps,
    async () => {
      const frame = await deps.bridge.call<NextFrame>('browserbridge.screencast.next', {
        tabId: deps.tabId,
        after,
        timeoutMs: NEXT_TIMEOUT_MS,
      });
      if (typeof frame.seq !== 'number' || frame.seq <= after || !frame.data) return;
      after = frame.seq;
      onFrame(frame.data, {
        ts: Number(frame.ts) || deps.now(),
        width: Number(frame.width) || 0,
        height: Number(frame.height) || 0,
      });
    },
    () =>
      deps.bridge
        .call('browserbridge.screencast.stop', { tabId: deps.tabId })
        .then(() => undefined),
  );
  return { mode: 'events', stop: () => handle.stop() };
}
