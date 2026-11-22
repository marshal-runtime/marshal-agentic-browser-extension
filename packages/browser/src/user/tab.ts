/**
 * One tab of the person's own Chrome (`user` backend), opened by this session in the background inside the bridge's
 * "Marley" tab group, and driven only through the bridge's non-evaluate verbs. It never adopts a tab the person
 * already had, never focuses Chrome, and closes only the tab it opened.
 *
 * Code guards on top of the task engine's (which every backend gets): a secret field (password, one-time code, or a
 * value the bridge masked) is never typed into or clicked, even by a direct `browser.session.act`; the bridge's own
 * local `type` verb does not refuse those.
 */
import { readFile, unlink } from 'node:fs/promises';
import { isSecret } from '../engine/guards.js';
import type {
  ActOutcome,
  ScreencastFrameMeta,
  ScreencastHandle,
  ScreencastOptions,
  ScreenshotOptions,
  Shot,
  Snapshot,
  SnapshotElement,
  Target,
  TargetAction,
} from '../target.js';
import { EDITING_KEYS, unsupportedOn } from '../target.js';
import { BridgeError, type BridgeClient, type BridgeSnapshot, type BridgeTab } from './bridge.js';
import { decodePng, drawMarks, encodeJpeg, encodePng, scaleTo, type Mark } from './image.js';
import { startScreencast } from './screencast.js';
import { bridgeToSnapshot } from './snapshot.js';

/** The bridge's caps are 50 000 characters and 1 000 elements; a decision needs far less. */
const SNAPSHOT_TEXT = 8_000;
const SNAPSHOT_ELEMENTS = 300;
const FULL_TEXT = 50_000;
const LOAD_WAIT_MS = 10_000;
const LOAD_POLL_MS = 300;
const MAX_WAIT_MS = 10_000;

export interface UserTabDeps {
  readonly readFile?: (path: string) => Promise<Buffer>;
  readonly removeFile?: (path: string) => Promise<void>;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
}

export class UserTab implements Target {
  readonly backend = 'user';
  private last: Snapshot | null = null;
  private closed = false;
  private readonly read: (path: string) => Promise<Buffer>;
  private readonly remove: (path: string) => Promise<void>;
  private readonly sleep: (ms: number) => Promise<void>;
  readonly now: () => number;

  private constructor(
    private bridge: BridgeClient,
    readonly tabId: number,
    deps: UserTabDeps,
  ) {
    this.read = deps.readFile ?? ((file) => readFile(file));
    this.remove = deps.removeFile ?? ((file) => unlink(file));
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = deps.now ?? Date.now;
  }

  /** Opens `url` in a new background tab of the bridge's tab group. Chrome is never brought to the front. */
  static async open(bridge: BridgeClient, url: string, deps: UserTabDeps = {}): Promise<UserTab> {
    if (!/^https?:\/\//i.test(url))
      throw new Error('BROWSER_BAD_INPUT: the user backend opens only http(s) addresses');
    const tab = await bridge.call<BridgeTab>('browserbridge.tabs.open', { url, active: false });
    if (!Number.isInteger(tab.tabId))
      throw new BridgeError('failed', 'tabs.open returned no tabId');
    return new UserTab(bridge, tab.tabId, deps);
  }

  get description(): string {
    return `the person's own Chrome, tab ${String(this.tabId)} of the Marley group`;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /** Later calls go through the bridge client of the invocation that asks, so the host applies that caller's policy. */
  rebind(bridge: BridgeClient): void {
    this.bridge = bridge;
  }

  async snapshot(): Promise<Snapshot> {
    const raw = await this.call<BridgeSnapshot>('browserbridge.snapshot', {
      tabId: this.tabId,
      maxText: SNAPSHOT_TEXT,
      maxElements: SNAPSHOT_ELEMENTS,
    });
    this.last = bridgeToSnapshot(raw);
    return this.last;
  }

  async act(action: TargetAction): Promise<ActOutcome> {
    try {
      return await this.perform(action);
    } catch (error) {
      // A failed step is an outcome the engine counts; a dead bridge shows up as the next snapshot's error.
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  private async perform(action: TargetAction): Promise<ActOutcome> {
    switch (action.kind) {
      case 'navigate': {
        if (!/^https?:\/\//i.test(action.url))
          return { ok: false, error: 'navigate-refused: only http(s) addresses' };
        await this.call('browserbridge.tabs.navigate', { tabId: this.tabId, url: action.url });
        return { ok: true, navigated: true };
      }
      case 'back':
      case 'forward':
      case 'reload':
        await this.call('browserbridge.tabs.navigate', { tabId: this.tabId, url: action.kind });
        return { ok: true, navigated: true };
      case 'press': {
        // The bridge cannot say which field has focus: a key that edits text is refused while the page shows any
        // secret field (the person's password stays theirs).
        if (EDITING_KEYS.has(action.key) && (this.last?.elements ?? []).some(isSecret))
          return {
            ok: false,
            error:
              'secret-field: this page has a password or code field; the person types there themselves',
          };
        const before = this.last?.url ?? '';
        await this.call('browserbridge.key', {
          tabId: this.tabId,
          key: action.key === 'Space' ? ' ' : action.key,
          ...(action.modifiers.length ? { modifiers: action.modifiers } : {}),
        });
        return { ok: true, navigated: action.key === 'Enter' ? await this.settle(before) : false };
      }
      case 'hover':
      case 'upload':
        // The bridge has no hover verb, and the Chrome extension takes no uploads (its README).
        return unsupportedOn('user', action.kind);
      case 'wait':
        await this.sleep(Math.min(Math.max(action.ms, 0), MAX_WAIT_MS));
        return { ok: true };
      case 'scroll': {
        const height = this.last?.viewport.h ?? 800;
        const dy = Math.round(height * 0.8) * (action.direction === 'up' ? -1 : 1);
        await this.call('browserbridge.scroll', { tabId: this.tabId, dy });
        return { ok: true };
      }
      case 'select':
        // The bridge reports no <select> options and has no select verb yet (see the README's user backend section).
        return {
          ok: false,
          error: 'select-unsupported: the user backend cannot pick a <select> option yet',
        };
      case 'click':
      case 'submit':
      case 'type': {
        const element = this.element(action.ref);
        if (!element)
          return { ok: false, error: `unknown-ref: ${action.ref}; take a new snapshot` };
        if (isSecret(element))
          return {
            ok: false,
            error: 'secret-field: a password or code field of the person; they type it themselves',
          };
        if (action.kind === 'type') {
          if (element.kind !== 'fill') return { ok: false, error: `not-editable: ${action.ref}` };
          await this.call('browserbridge.type', {
            tabId: this.tabId,
            ref: element.node,
            text: action.text,
            clear: true,
          });
          return { ok: true };
        }
        const before = this.last?.url ?? '';
        if (action.kind === 'submit' && element.kind === 'fill') {
          await this.call('browserbridge.type', {
            tabId: this.tabId,
            ref: element.node,
            text: '',
            submit: true,
          });
          return { ok: true, navigated: await this.settle(before) };
        }
        const clicked = await this.call<{ clicked?: boolean; url?: string; loading?: boolean }>(
          'browserbridge.click',
          { tabId: this.tabId, ref: element.node },
        );
        if (clicked.clicked === false) return { ok: false, error: 'click-failed' };
        return { ok: true, navigated: await this.settle(before, clicked) };
      }
      default:
        return { ok: false, error: 'unknown-action' };
    }
  }

  /** After a click or Enter: wait (bounded) while the tab loads; true when its address changed. */
  private async settle(
    before: string,
    seen: { url?: string; loading?: boolean } = { loading: true },
  ): Promise<boolean> {
    let url = seen.url ?? before;
    let loading = seen.loading === true;
    const deadline = this.now() + LOAD_WAIT_MS;
    while (loading && this.now() < deadline) {
      await this.sleep(LOAD_POLL_MS);
      const listed = await this.call<{
        tabs?: readonly { tabId?: number; url?: string; loading?: boolean }[];
      }>('browserbridge.tabs.list', {});
      const tab = listed.tabs?.find((entry) => entry.tabId === this.tabId);
      if (!tab) break;
      url = tab.url ?? url;
      loading = tab.loading === true;
    }
    return url !== before;
  }

  async screenshot(options: ScreenshotOptions = {}): Promise<Shot> {
    const { png, cssWidth } = await this.capture();
    const marks = (options.marks ?? []).flatMap((element): Mark[] =>
      element.box && !element.offscreen ? [{ ref: element.ref, box: element.box }] : [],
    );
    const format = options.format ?? 'png';
    if (!marks.length && !options.width && format === 'png')
      return { data: png.toString('base64'), mimeType: 'image/png' };
    let image = decodePng(png);
    if (marks.length) drawMarks(image, marks, cssWidth > 0 ? image.width / cssWidth : 1);
    if (options.width) image = scaleTo(image, options.width);
    return format === 'jpeg'
      ? {
          data: encodeJpeg(image, options.quality ?? 70).toString('base64'),
          mimeType: 'image/jpeg',
        }
      : { data: encodePng(image).toString('base64'), mimeType: 'image/png' };
  }

  /** The bridge writes its PNG to a file of its own; it is read once and removed (a picture of the person's page). */
  async capture(): Promise<{ png: Buffer; cssWidth: number }> {
    const shot = await this.call<{ path?: string; width?: number }>('browserbridge.screenshot', {
      tabId: this.tabId,
    });
    if (typeof shot.path !== 'string' || !shot.path)
      throw new BridgeError('failed', 'screenshot returned no file');
    try {
      return { png: await this.read(shot.path), cssWidth: Number(shot.width) || 0 };
    } finally {
      await this.remove(shot.path).catch(() => undefined);
    }
  }

  async fullText(): Promise<string> {
    const raw = await this.call<BridgeSnapshot>('browserbridge.snapshot', {
      tabId: this.tabId,
      maxText: FULL_TEXT,
      maxElements: 1,
    });
    return raw.text;
  }

  screencast(
    opts: ScreencastOptions,
    onFrame: (jpegBase64: string, meta: ScreencastFrameMeta) => void,
  ): Promise<ScreencastHandle> {
    return startScreencast(
      {
        bridge: this.bridge,
        tabId: this.tabId,
        capture: () => this.capture(),
        sleep: this.sleep,
        now: this.now,
        isClosed: () => this.closed,
      },
      opts,
      onFrame,
    );
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.bridge
      .call('browserbridge.tabs.close', { tabId: this.tabId })
      .catch(() => undefined);
  }

  private element(ref: string): SnapshotElement | undefined {
    return this.last?.elements.find((element) => element.ref === ref);
  }

  private async call<T = Record<string, unknown>>(
    name: string,
    input: Record<string, unknown>,
  ): Promise<T> {
    try {
      return await this.bridge.call<T>(name, input);
    } catch (error) {
      // The person closed the tab or took it out of the group: this session is over.
      if (error instanceof BridgeError && error.code === 'no_tab') this.closed = true;
      throw error;
    }
  }
}
