/**
 * One tab of a Chrome this extension started (`managed` backend), driven with CDP over the launcher's pipe. Input is
 * real (Input.dispatchMouseEvent / insertText / dispatchKeyEvent), so the page sees trusted events. Nothing here
 * intercepts requests (no Fetch domain, no request interception): a `visitor` tab only ever observes.
 *
 * Step-by-step extras for browser.session.*: JavaScript dialogs are tracked (an action that opens one returns it, and
 * every page read refuses with BROWSER_DIALOG_OPEN until it is answered, instead of hanging); console and network
 * entries are collected only after `observe` asks (Runtime.enable is a known automation tell, so it is never on by
 * default); an upload sets files through Chrome's file chooser, never a native dialog.
 */
import { stat } from 'node:fs/promises';
import path from 'node:path';
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
import { isSecret } from '../engine/guards.js';
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
  LogEntry,
  LogKind,
  Modifier,
  PageDialog,
  PressKey,
  Viewport,
} from '../target.js';
import { CAPTURE_MAX_CSS, EDITING_KEYS } from '../target.js';

const VIEWPORT = { width: 1280, height: 800 } as const;
const NAVIGATION_TIMEOUT_MS = 20_000;
const LOG_LIMIT = 1_000;
const LOG_TEXT = 2_000;
const LOG_URL = 1_000;
export const UPLOAD_MAX_FILES = 10;
export const UPLOAD_MAX_BYTES = 100 * 1024 * 1024;

/** CDP key events for the named keys browser.session.act accepts (src/target.ts PRESS_KEYS). */
const KEY_EVENTS: Readonly<
  Record<PressKey, { key: string; code: string; vk: number; text?: string }>
> = {
  Enter: { key: 'Enter', code: 'Enter', vk: 13, text: '\r' },
  Tab: { key: 'Tab', code: 'Tab', vk: 9 },
  Escape: { key: 'Escape', code: 'Escape', vk: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', vk: 8 },
  Delete: { key: 'Delete', code: 'Delete', vk: 46 },
  Space: { key: ' ', code: 'Space', vk: 32, text: ' ' },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', vk: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', vk: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', vk: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', vk: 39 },
  Home: { key: 'Home', code: 'Home', vk: 36 },
  End: { key: 'End', code: 'End', vk: 35 },
  PageUp: { key: 'PageUp', code: 'PageUp', vk: 33 },
  PageDown: { key: 'PageDown', code: 'PageDown', vk: 34 },
};
const MODIFIER_BITS: Readonly<Record<Modifier, number>> = { Alt: 1, Control: 2, Meta: 4, Shift: 8 };

/** Whether the focused element (through same-origin frames and open shadow roots) is a secret field. */
export const FOCUSED_SECRET_SCRIPT = `
let el = document.activeElement;
for (let hops = 0; el && hops < 10; hops++) {
  if ((el.tagName === 'IFRAME' || el.tagName === 'FRAME')) { try { el = el.contentDocument.activeElement; continue; } catch (e) { break; } }
  if (el.shadowRoot && el.shadowRoot.activeElement) { el = el.shadowRoot.activeElement; continue; }
  break;
}
if (!el || !el.getAttribute) return false;
const tokens = ['current-password', 'new-password', 'one-time-code', 'cc-number', 'cc-csc', 'cc-exp'];
return el.type === 'password' || String(el.getAttribute('autocomplete') || '').toLowerCase().split(/\\s+/).some(t => tokens.includes(t));`;

/** The page's file inputs in the top document and open shadow roots (they are not in the snapshot). */
const FILE_INPUTS_EXPRESSION = `(() => {
  const found = [];
  const walk = (root) => { for (const el of root.querySelectorAll('*')) { if (el.tagName === 'INPUT' && el.type === 'file') found.push(el); if (el.shadowRoot) walk(el.shadowRoot); } };
  walk(document);
  return found;
})()`;

export class DialogOpen extends Error {
  constructor(readonly dialog: PageDialog) {
    super(
      `BROWSER_DIALOG_OPEN: a ${dialog.type} dialog is open ("${dialog.message.slice(0, 200)}"); answer it with browser.session.dialog`,
    );
  }
}

export class ManagedTab implements Target {
  readonly backend = 'managed';
  private last: Snapshot | null = null;
  private closed = false;
  // The page's CSS viewport, for scrolling by a screenful (browser.session.viewport changes it).
  private viewportWidth: number = VIEWPORT.width;
  private viewportHeight: number = VIEWPORT.height;
  private hub: ScreencastHub | null = null;
  private dialog: PageDialog | null = null;
  private readonly dialogWaiters = new Set<(dialog: PageDialog) => void>();
  private readonly observing = new Set<LogKind>();
  private entries: LogEntry[] = [];
  private dropped = 0;
  /** In-flight requests by id, to stamp their status or failure on the entry already recorded. */
  private readonly requests = new Map<string, { status?: number; failed?: string }>();
  private readonly offEvents: () => void;

  private constructor(
    readonly profile: ManagedProfile,
    private readonly process: ChromeProcess,
    private readonly sessionId: string,
    private readonly targetId: string,
    private readonly browserContextId: string | undefined,
    private readonly frameId: string,
  ) {
    this.offEvents = process.connection.onEvent((event) => {
      if (event.sessionId !== sessionId) return;
      this.onEvent(event.method, event.params);
    });
  }

  private onEvent(method: string, params: Readonly<Record<string, unknown>>): void {
    switch (method) {
      case 'Page.javascriptDialogOpening': {
        const dialog: PageDialog = {
          type: typeof params['type'] === 'string' ? params['type'] : 'alert',
          message: typeof params['message'] === 'string' ? params['message'] : '',
          ...(typeof params['defaultPrompt'] === 'string' && params['defaultPrompt']
            ? { defaultPrompt: params['defaultPrompt'] }
            : {}),
          ...(typeof params['url'] === 'string' ? { url: params['url'] } : {}),
        };
        this.dialog = dialog;
        for (const waiter of [...this.dialogWaiters]) waiter(dialog);
        return;
      }
      case 'Page.javascriptDialogClosed':
        this.dialog = null;
        return;
      case 'Runtime.consoleAPICalled': {
        if (!this.observing.has('console')) return;
        const args =
          (params['args'] as
            | { value?: unknown; description?: string; type?: string }[]
            | undefined) ?? [];
        const text = args
          .map((arg) =>
            arg.value !== undefined
              ? typeof arg.value === 'string'
                ? arg.value
                : JSON.stringify(arg.value)
              : (arg.description ?? arg.type ?? ''),
          )
          .join(' ');
        this.record({
          kind: 'console',
          at: Date.now(),
          level: typeof params['type'] === 'string' ? params['type'] : 'log',
          text: text.slice(0, LOG_TEXT),
        });
        return;
      }
      case 'Runtime.exceptionThrown': {
        if (!this.observing.has('console')) return;
        const details = params['exceptionDetails'] as
          | { text?: string; url?: string; exception?: { description?: string } }
          | undefined;
        this.record({
          kind: 'console',
          at: Date.now(),
          level: 'exception',
          text: (details?.exception?.description ?? details?.text ?? 'exception').slice(
            0,
            LOG_TEXT,
          ),
          ...(details?.url ? { url: details.url.slice(0, LOG_URL) } : {}),
        });
        return;
      }
      case 'Log.entryAdded': {
        if (!this.observing.has('console')) return;
        const entry = params['entry'] as
          | { level?: string; text?: string; url?: string }
          | undefined;
        this.record({
          kind: 'console',
          at: Date.now(),
          level: entry?.level ?? 'info',
          text: (entry?.text ?? '').slice(0, LOG_TEXT),
          ...(entry?.url ? { url: entry.url.slice(0, LOG_URL) } : {}),
        });
        return;
      }
      case 'Network.requestWillBeSent': {
        if (!this.observing.has('network')) return;
        const request = params['request'] as { url?: string; method?: string } | undefined;
        const outcome: { status?: number; failed?: string } = {};
        this.requests.set(String(params['requestId']), outcome);
        this.record({
          kind: 'network',
          at: Date.now(),
          method: request?.method ?? 'GET',
          url: (request?.url ?? '').slice(0, LOG_URL),
          ...(typeof params['type'] === 'string' ? { resourceType: params['type'] } : {}),
          outcome,
        } as LogEntry);
        return;
      }
      case 'Network.responseReceived': {
        const outcome = this.requests.get(String(params['requestId']));
        const response = params['response'] as { status?: number } | undefined;
        if (outcome && typeof response?.status === 'number') outcome.status = response.status;
        return;
      }
      case 'Network.loadingFailed': {
        const outcome = this.requests.get(String(params['requestId']));
        if (outcome)
          outcome.failed = typeof params['errorText'] === 'string' ? params['errorText'] : 'failed';
        this.requests.delete(String(params['requestId']));
        return;
      }
      case 'Network.loadingFinished':
        this.requests.delete(String(params['requestId']));
        return;
      default:
        return;
    }
  }

  private record(entry: LogEntry): void {
    this.entries.push(entry);
    if (this.entries.length > LOG_LIMIT) {
      const gone = this.entries.splice(0, this.entries.length - LOG_LIMIT);
      this.dropped += gone.length;
    }
    if (this.requests.size > LOG_LIMIT) {
      const oldest = this.requests.keys().next().value;
      if (oldest !== undefined) this.requests.delete(oldest);
    }
  }

  /** Runs `run`, but settles as soon as a dialog opens (a CDP call can block behind an open dialog). */
  private async raceDialog<T>(
    run: () => Promise<T>,
  ): Promise<{ value: T } | { dialog: PageDialog }> {
    if (this.dialog) throw new DialogOpen(this.dialog);
    let waiter: ((dialog: PageDialog) => void) | undefined;
    const opened = new Promise<{ dialog: PageDialog }>((resolve) => {
      waiter = (dialog) => {
        resolve({ dialog });
      };
      this.dialogWaiters.add(waiter);
    });
    const running = run().then((value) => ({ value }));
    running.catch(() => undefined);
    try {
      return await Promise.race([running, opened]);
    } finally {
      if (waiter) this.dialogWaiters.delete(waiter);
    }
  }

  pendingDialog(): PageDialog | null {
    return this.dialog;
  }

  async answerDialog(accept: boolean, promptText?: string): Promise<void> {
    if (!this.dialog) throw new Error('BROWSER_NO_DIALOG: no dialog is open in this session');
    await this.send('Page.handleJavaScriptDialog', {
      accept,
      ...(promptText !== undefined ? { promptText } : {}),
    });
    this.dialog = null;
  }

  async observe(kinds: readonly LogKind[]): Promise<void> {
    for (const kind of kinds) {
      if (this.observing.has(kind)) continue;
      if (kind === 'network') await this.send('Network.enable', {});
      else {
        await this.send('Runtime.enable', {});
        await this.send('Log.enable', {});
      }
      this.observing.add(kind);
    }
  }

  log(
    kinds: readonly LogKind[],
    clear: boolean,
  ): { entries: LogEntry[]; dropped: number; observing: LogKind[] } {
    const entries = this.entries
      .filter((entry) => kinds.includes(entry.kind))
      .map((entry) => {
        if (entry.kind !== 'network') return { ...entry };
        const { outcome, ...rest } = entry as LogEntry & {
          outcome?: { status?: number; failed?: string };
        };
        return {
          ...rest,
          ...(outcome?.status !== undefined ? { status: outcome.status } : {}),
          ...(outcome?.failed !== undefined ? { failed: outcome.failed } : {}),
        };
      });
    const dropped = this.dropped;
    if (clear) {
      this.entries = this.entries.filter((entry) => !kinds.includes(entry.kind));
      this.dropped = 0;
    }
    return { entries, dropped, observing: [...this.observing] };
  }

  async setViewport(viewport: Viewport): Promise<void> {
    const touch = viewport.touch ?? false;
    await this.send('Emulation.setDeviceMetricsOverride', {
      width: viewport.width,
      height: viewport.height,
      deviceScaleFactor: viewport.deviceScaleFactor ?? 1,
      mobile: viewport.mobile ?? false,
    });
    await this.send('Emulation.setTouchEmulationEnabled', {
      enabled: touch,
      ...(touch ? { maxTouchPoints: 5 } : {}),
    });
    this.viewportHeight = viewport.height;
    this.viewportWidth = viewport.width;
  }

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
      // Headless Chrome delivers input only to the tab it considers focused: with two tabs open (two sessions, or a
      // background task beside another), mouse-wheel events to the other one never answer. Every tab acts focused.
      await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }, sessionId);
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
    return this.evaluateRaw(asExpression(body));
  }

  /** A caller's expression (browser.session.evaluate): its JSON value, a promise awaited, bounded by `timeoutMs`. */
  async evaluateExpression(expression: string, timeoutMs: number): Promise<unknown> {
    const value = await this.evaluateRaw(expression, timeoutMs);
    return value === undefined ? null : value;
  }

  async html(): Promise<string> {
    const value = await this.evaluate(
      "return document.documentElement ? document.documentElement.outerHTML : '';",
    );
    return typeof value === 'string' ? value : '';
  }

  private async evaluateRaw(expression: string, timeoutMs?: number): Promise<unknown> {
    const raced = await this.raceDialog(() =>
      this.send(
        'Runtime.evaluate',
        { expression, returnByValue: true, awaitPromise: true, userGesture: true },
        timeoutMs,
      ),
    );
    if ('dialog' in raced) throw new DialogOpen(raced.dialog);
    const result = raced.value;
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
    if (this.dialog)
      return { ok: false, error: new DialogOpen(this.dialog).message, dialog: this.dialog };
    try {
      const raced = await this.raceDialog(() => this.perform(action));
      return 'dialog' in raced ? { ok: true, dialog: raced.dialog } : raced.value;
    } catch (error) {
      if (error instanceof DialogOpen)
        return { ok: false, error: error.message, dialog: error.dialog };
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  private async perform(action: TargetAction): Promise<ActOutcome> {
    try {
      switch (action.kind) {
        case 'forward':
          return await this.settleAfter(() => this.evaluate('history.forward(); return true;'));
        case 'reload':
          return await this.reload();
        case 'press':
          return await this.press(action.key, action.modifiers);
        case 'upload':
          if (!action.ref) return await this.upload(null, action.paths);
          break;
        case 'navigate':
          return await this.navigate(action.url);
        case 'back':
          return await this.settleAfter(() => this.evaluate('history.back(); return true;'));
        case 'wait':
          await sleep(action.ms);
          return { ok: true };
        case 'scroll': {
          const dy = Math.round(this.viewportHeight * 0.8) * (action.direction === 'down' ? 1 : -1);
          await this.send('Input.dispatchMouseEvent', {
            type: 'mouseWheel',
            x: this.viewportWidth / 2,
            y: this.viewportHeight / 2,
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
      // A password, one-time-code or card field is never typed into, clicked or sent from here, even by a direct
      // browser.session.act (the user tab refuses the same; the task engine never offers one).
      const element = this.last?.elements.find((entry) => entry.ref === action.ref);
      if (element && isSecret(element))
        return {
          ok: false,
          error: 'secret-field: a password, code or card field; the person types it themselves',
        };
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
        case 'hover': {
          const point = (await this.evaluate(pointScript(node))) as
            | { ok: boolean; x?: number; y?: number; error?: string }
            | undefined;
          if (!point?.ok || point.x === undefined || point.y === undefined)
            return { ok: false, error: point?.error ?? 'element-gone' };
          await this.send('Input.dispatchMouseEvent', {
            type: 'mouseMoved',
            x: point.x,
            y: point.y,
          });
          await sleep(250);
          return { ok: true };
        }
        case 'upload':
          return await this.upload(node, action.paths);
        default:
          break;
      }
      return { ok: false, error: 'unknown-action' };
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

  private async press(key: PressKey, modifiers: readonly Modifier[]): Promise<ActOutcome> {
    // A key that edits text never reaches a focused password, code or card field.
    if (EDITING_KEYS.has(key) && (await this.evaluate(FOCUSED_SECRET_SCRIPT)) === true)
      return {
        ok: false,
        error:
          'secret-field: a password, code or card field has focus; the person types it themselves',
      };
    const event = KEY_EVENTS[key];
    const bits = modifiers.reduce((sum, modifier) => sum | MODIFIER_BITS[modifier], 0);
    const base = {
      key: event.key,
      code: event.code,
      windowsVirtualKeyCode: event.vk,
      nativeVirtualKeyCode: event.vk,
      modifiers: bits,
    };
    const run = async (): Promise<void> => {
      // Text is sent only without Control/Meta/Alt, so a shortcut never types a character.
      const text = event.text !== undefined && (bits & 7) === 0 ? { text: event.text } : {};
      // Like Puppeteer: a key without text is a rawKeyDown, or Chrome runs no editing command (Backspace, Delete).
      await this.send('Input.dispatchKeyEvent', {
        type: 'text' in text ? 'keyDown' : 'rawKeyDown',
        ...base,
        ...text,
      });
      await this.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
    };
    if (key === 'Enter') return this.settleAfter(run);
    await run();
    return { ok: true };
  }

  private async reload(): Promise<ActOutcome> {
    const loaded = this.cdp.waitForEvent(
      (event) => event.sessionId === this.sessionId && event.method === 'Page.loadEventFired',
      NAVIGATION_TIMEOUT_MS,
    );
    await this.send('Page.reload', {});
    await loaded.promise;
    await sleep(300);
    return { ok: true, navigated: true };
  }

  /**
   * Sets files on a file input. With a ref: the element is clicked with Chrome's file chooser intercepted, so whatever
   * input it opens gets the files and no native dialog appears. Without one: the page's only file input.
   */
  private async upload(node: string | null, paths: readonly string[]): Promise<ActOutcome> {
    const files = await checkUploadPaths(paths);
    if (typeof files === 'string') return { ok: false, error: files };
    if (node === null) {
      const found = await this.send('Runtime.evaluate', {
        expression: FILE_INPUTS_EXPRESSION,
        returnByValue: false,
      });
      const arrayId = (found['result'] as { objectId?: string } | undefined)?.objectId;
      if (!arrayId) return { ok: false, error: 'no-file-input: the page has no file input' };
      const props = await this.send('Runtime.getProperties', {
        objectId: arrayId,
        ownProperties: true,
      });
      const inputs = (
        (props['result'] as { name: string; value?: { objectId?: string } }[] | undefined) ?? []
      )
        .filter((prop) => /^\d+$/.test(prop.name))
        .map((prop) => prop.value?.objectId)
        .filter((id): id is string => typeof id === 'string');
      await this.send('Runtime.releaseObject', { objectId: arrayId }).catch(() => undefined);
      if (inputs.length !== 1)
        return {
          ok: false,
          error: inputs.length
            ? `ambiguous-file-input: the page has ${String(inputs.length)} file inputs; pass the ref of the upload button`
            : 'no-file-input: the page has no file input',
        };
      await this.send('DOM.setFileInputFiles', { files, objectId: inputs[0] });
      return { ok: true };
    }
    await this.send('Page.setInterceptFileChooserDialog', { enabled: true });
    try {
      const chooser = this.cdp.waitForEvent(
        (event) => event.sessionId === this.sessionId && event.method === 'Page.fileChooserOpened',
        3_000,
      );
      await this.click(node);
      const opened = await chooser.promise;
      if (!opened)
        return {
          ok: false,
          error: 'no-file-chooser: clicking that element opened no file chooser',
        };
      if (opened.params['mode'] === 'selectSingle' && files.length > 1)
        return { ok: false, error: 'single-file: this input takes one file' };
      const backendNodeId = opened.params['backendNodeId'];
      if (typeof backendNodeId !== 'number')
        return { ok: false, error: 'no-file-chooser: no input reported' };
      await this.send('DOM.setFileInputFiles', { files, backendNodeId });
      return { ok: true };
    } finally {
      await this.send('Page.setInterceptFileChooserDialog', { enabled: false }).catch(
        () => undefined,
      );
    }
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
            height: Math.min(Math.ceil(size.height), CAPTURE_MAX_CSS),
            scale: 1,
          };
      } else if (options.clip) {
        clip = {
          x: options.clip.x,
          y: options.clip.y,
          width: options.clip.width,
          height: Math.min(options.clip.height, CAPTURE_MAX_CSS),
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
        ...(clip
          ? { clip, ...(options.fullPage || options.clip ? { captureBeyondViewport: true } : {}) }
          : {}),
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
    this.offEvents();
    this.dialogWaiters.clear();
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

/** Absolute paths of existing regular files within the limits, or the reason they are refused. */
export async function checkUploadPaths(paths: readonly string[]): Promise<string[] | string> {
  if (paths.length === 0) return 'upload-refused: no file given';
  if (paths.length > UPLOAD_MAX_FILES)
    return `upload-refused: at most ${String(UPLOAD_MAX_FILES)} files at once`;
  for (const file of paths) {
    if (!path.isAbsolute(file)) return `upload-refused: ${file} is not an absolute path`;
    const info = await stat(file).catch(() => null);
    if (!info?.isFile()) return `upload-refused: ${file} is not a readable file`;
    if (info.size > UPLOAD_MAX_BYTES) return `upload-refused: ${file} is larger than 100 MB`;
  }
  return [...paths];
}
