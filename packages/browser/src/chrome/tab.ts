/**
 * One tab of a Chrome this extension started (`managed` backend), driven with CDP over the launcher's pipe. Input is
 * real (Input.dispatchMouseEvent / insertText / dispatchKeyEvent), so the page sees trusted events. Nothing here
 * intercepts requests (no Fetch domain, no request interception): a `visitor` tab only ever observes.
 */
import { DEAD_PROXY, sleep, type ChromeLauncher, type ChromeProcess } from './launcher.js';
import type { CdpConnection } from './cdp.js';
import { ScreencastHub } from './screencast.js';
import { SNAPSHOT_SCRIPT } from '../page/snapshot-script.js';
import {
  asExpression,
  drawMarksScript,
  focusAndClearScript,
  focusScript,
  FULL_TEXT_SCRIPT,
  jsClickScript,
  pointScript,
  REMOVE_MARKS_SCRIPT,
  selectScript,
} from '../page/scripts.js';
import { isRawSnapshot, toSnapshot } from '../page/to-snapshot.js';
import type {
  ActOutcome,
  ManagedProfile,
  ScreencastFrameMeta,
  ScreencastHandle,
  ScreencastOptions,
  ScreenshotOptions,
  Shot,
  Snapshot,
  Target,
  TargetAction,
} from '../target.js';

const VIEWPORT = { width: 1280, height: 800 } as const;
const NAVIGATION_TIMEOUT_MS = 20_000;

export class ManagedTab implements Target {
  readonly backend = 'managed';
  private last: Snapshot | null = null;
  private closed = false;
  private hub: ScreencastHub | null = null;

  private constructor(
    readonly profile: ManagedProfile,
    private readonly process: ChromeProcess,
    private readonly sessionId: string,
    private readonly targetId: string,
    private readonly browserContextId: string | undefined,
    private readonly frameId: string,
  ) {}

  static async open(launcher: ChromeLauncher, profile: ManagedProfile): Promise<ManagedTab> {
    const process = await launcher.processFor(profile);
    const cdp = process.connection;
    let browserContextId: string | undefined;
    if (profile !== 'agent') {
      const created = await cdp.send('Target.createBrowserContext', {
        disposeOnDetach: true,
        ...(profile === 'offline'
          ? { proxyServer: DEAD_PROXY, proxyBypassList: '<-loopback>' }
          : {}),
      });
      browserContextId = String(created['browserContextId']);
    }
    const target = await cdp.send('Target.createTarget', {
      url: 'about:blank',
      ...(browserContextId ? { browserContextId } : {}),
    });
    const targetId = String(target['targetId']);
    const attached = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    const sessionId = String(attached['sessionId']);
    await cdp.send('Page.enable', {}, sessionId);
    const tree = await cdp.send('Page.getFrameTree', {}, sessionId);
    const frameId = String((tree['frameTree'] as { frame: { id: string } }).frame.id);
    if (!process.headed) {
      await cdp.send(
        'Emulation.setDeviceMetricsOverride',
        { width: VIEWPORT.width, height: VIEWPORT.height, deviceScaleFactor: 1, mobile: false },
        sessionId,
      );
    }
    // Headless Chrome names itself "HeadlessChrome"; a page should see the same browser a person would.
    if (process.userAgent.includes('HeadlessChrome')) {
      await cdp.send(
        'Emulation.setUserAgentOverride',
        { userAgent: process.userAgent.replace('HeadlessChrome', 'Chrome') },
        sessionId,
      );
    }
    return new ManagedTab(profile, process, sessionId, targetId, browserContextId, frameId);
  }

  get description(): string {
    return `managed ${this.profile} tab ${this.targetId.slice(0, 8)}`;
  }

  get isClosed(): boolean {
    return this.closed || this.process.connection.closed;
  }

  private get cdp(): CdpConnection {
    return this.process.connection;
  }

  private send(
    method: string,
    params: Readonly<Record<string, unknown>> = {},
    timeoutMs?: number,
  ): Promise<Record<string, unknown>> {
    return this.cdp.send(method, params, this.sessionId, timeoutMs);
  }

  async evaluate(body: string): Promise<unknown> {
    const result = await this.send('Runtime.evaluate', {
      expression: asExpression(body),
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
    });
    const details = result['exceptionDetails'] as
      | { exception?: { description?: string }; text?: string }
      | undefined;
    if (details)
      throw new Error(
        `page script failed: ${details.exception?.description ?? details.text ?? 'exception'}`,
      );
    return (result['result'] as { value?: unknown } | undefined)?.value;
  }

  async snapshot(): Promise<Snapshot> {
    const raw = await this.evaluate(SNAPSHOT_SCRIPT);
    if (!isRawSnapshot(raw))
      throw new Error('BROWSER_SNAPSHOT_FAILED: the snapshot script returned no page');
    this.last = toSnapshot(raw);
    return this.last;
  }

  private nodeOf(ref: string): string | null {
    return this.last?.elements.find((element) => element.ref === ref)?.node ?? null;
  }

  async act(action: TargetAction): Promise<ActOutcome> {
    try {
      switch (action.kind) {
        case 'navigate':
          return await this.navigate(action.url);
        case 'back':
          return await this.settleAfter(() => this.evaluate('history.back(); return true;'));
        case 'wait':
          await sleep(action.ms);
          return { ok: true };
        case 'scroll': {
          const dy = Math.round(VIEWPORT.height * 0.8) * (action.direction === 'down' ? 1 : -1);
          await this.send('Input.dispatchMouseEvent', {
            type: 'mouseWheel',
            x: VIEWPORT.width / 2,
            y: VIEWPORT.height / 2,
            deltaX: 0,
            deltaY: dy,
          });
          await sleep(250);
          return { ok: true };
        }
        default:
          break;
      }
      const node = this.nodeOf(action.ref);
      if (!node) return { ok: false, error: `unknown ref ${action.ref} (take a new snapshot)` };
      switch (action.kind) {
        case 'click':
          return await this.settleAfter(() => this.click(node));
        case 'type': {
          const cleared = (await this.evaluate(focusAndClearScript(node))) as
            | { ok?: boolean; error?: string }
            | undefined;
          if (!cleared?.ok)
            return { ok: false, error: cleared?.error ?? 'could not focus the field' };
          await this.send('Input.insertText', { text: action.text });
          return { ok: true };
        }
        case 'select': {
          const done = (await this.evaluate(selectScript(node, action.value))) as
            | { ok?: boolean }
            | undefined;
          return done?.ok ? { ok: true } : { ok: false, error: 'option not selected' };
        }
        case 'submit': {
          const focused = (await this.evaluate(focusScript(node))) as { ok?: boolean } | undefined;
          if (!focused?.ok) return { ok: false, error: 'element-gone' };
          return await this.settleAfter(() => this.pressEnter());
        }
      }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  private async click(node: string): Promise<void> {
    const point = (await this.evaluate(pointScript(node))) as
      | { ok: boolean; x?: number; y?: number; hit?: boolean; error?: string }
      | undefined;
    if (!point?.ok || point.x === undefined || point.y === undefined) {
      throw new Error(point?.error ?? 'element-gone');
    }
    if (!point.hit) {
      // Something covers the element: click it in the page instead of clicking the cover.
      const done = (await this.evaluate(jsClickScript(node))) as { ok?: boolean } | undefined;
      if (!done?.ok) throw new Error('element-gone');
      return;
    }
    const at = { x: point.x, y: point.y };
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...at });
    await this.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      ...at,
      button: 'left',
      clickCount: 1,
    });
    await this.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      ...at,
      button: 'left',
      clickCount: 1,
    });
  }

  private async pressEnter(): Promise<void> {
    const key = {
      key: 'Enter',
      code: 'Enter',
      windowsVirtualKeyCode: 13,
      nativeVirtualKeyCode: 13,
    };
    await this.send('Input.dispatchKeyEvent', { type: 'keyDown', ...key, text: '\r' });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', ...key });
  }

  private async navigate(url: string): Promise<ActOutcome> {
    const loaded = this.cdp.waitForEvent(
      (event) => event.sessionId === this.sessionId && event.method === 'Page.loadEventFired',
      NAVIGATION_TIMEOUT_MS,
    );
    const answer = await this.send('Page.navigate', { url }, NAVIGATION_TIMEOUT_MS);
    if (typeof answer['errorText'] === 'string' && answer['errorText']) {
      loaded.cancel();
      return { ok: false, error: `navigation failed: ${answer['errorText']}` };
    }
    await loaded.promise;
    await sleep(300);
    return { ok: true, navigated: true };
  }

  /** Runs an action, then waits for a navigation it started (if any) to load. */
  private async settleAfter(run: () => Promise<unknown>): Promise<ActOutcome> {
    const started = this.cdp.waitForEvent(
      (event) =>
        event.sessionId === this.sessionId &&
        event.method === 'Page.frameStartedLoading' &&
        event.params['frameId'] === this.frameId,
      600,
    );
    await run();
    const navigation = await started.promise;
    if (navigation) {
      const stopped = this.cdp.waitForEvent(
        (event) =>
          event.sessionId === this.sessionId &&
          (event.method === 'Page.loadEventFired' ||
            (event.method === 'Page.frameStoppedLoading' &&
              event.params['frameId'] === this.frameId)),
        NAVIGATION_TIMEOUT_MS,
      );
      await stopped.promise;
    }
    await sleep(navigation ? 400 : 250);
    return { ok: true, navigated: navigation !== null };
  }

  async screenshot(options: ScreenshotOptions = {}): Promise<Shot> {
    const format = options.format ?? 'png';
    const marks = options.marks?.filter((element) => !element.offscreen) ?? [];
    if (marks.length)
      await this.evaluate(
        drawMarksScript(marks.map((element) => ({ node: element.node, ref: element.ref }))),
      );
    try {
      let clip: Record<string, number> | undefined;
      if (options.fullPage) {
        const metrics = await this.send('Page.getLayoutMetrics');
        const size = metrics['cssContentSize'] as { width: number; height: number } | undefined;
        if (size)
          clip = {
            x: 0,
            y: 0,
            width: Math.ceil(size.width),
            height: Math.min(Math.ceil(size.height), 12_000),
            scale: 1,
          };
      } else if (options.width) {
        const metrics = await this.send('Page.getLayoutMetrics');
        const view = metrics['cssVisualViewport'] as
          | { pageX: number; pageY: number; clientWidth: number; clientHeight: number }
          | undefined;
        if (view && view.clientWidth > options.width)
          clip = {
            x: view.pageX,
            y: view.pageY,
            width: view.clientWidth,
            height: view.clientHeight,
            scale: options.width / view.clientWidth,
          };
      }
      const shot = await this.send('Page.captureScreenshot', {
        format,
        ...(format === 'jpeg' ? { quality: options.quality ?? 70 } : {}),
        ...(clip ? { clip, ...(options.fullPage ? { captureBeyondViewport: true } : {}) } : {}),
      });
      return {
        data: String(shot['data']),
        mimeType: format === 'jpeg' ? 'image/jpeg' : 'image/png',
      };
    } finally {
      if (marks.length) await this.evaluate(REMOVE_MARKS_SCRIPT).catch(() => undefined);
    }
  }

  async fullText(): Promise<string> {
    const text = await this.evaluate(FULL_TEXT_SCRIPT);
    return typeof text === 'string' ? text : '';
  }

  /** Live JPEG frames over the same CDP pipe; Chrome screencasts only while at least one handle is open. */
  async screencast(
    opts: ScreencastOptions,
    onFrame: (jpegBase64: string, meta: ScreencastFrameMeta) => void,
  ): Promise<ScreencastHandle> {
    if (this.isClosed) throw new Error('BROWSER_SCREENCAST_FAILED: the tab is closed');
    this.hub ??= new ScreencastHub(this.cdp, this.sessionId);
    return this.hub.subscribe(opts, onFrame);
  }

  /** True while Chrome is screencasting this tab (tests check it ends with the last consumer). */
  get screencasting(): boolean {
    return this.hub?.active ?? false;
  }

  async cookies(): Promise<readonly { readonly name: string; readonly domain: string }[]> {
    const answer = await this.send('Network.getCookies');
    return (answer['cookies'] as { name: string; domain: string }[] | undefined) ?? [];
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.hub?.dispose();
    if (this.cdp.closed) return;
    await this.cdp
      .send('Target.closeTarget', { targetId: this.targetId }, undefined, 5_000)
      .catch(() => undefined);
    if (this.browserContextId) {
      await this.cdp
        .send(
          'Target.disposeBrowserContext',
          { browserContextId: this.browserContextId },
          undefined,
          5_000,
        )
        .catch(() => undefined);
    }
  }
}
