/**
 * The `app` backend: one running macOS app behind the same `Target` the managed Chrome uses. Lifted from
 * automation-extension's AxAdapter/HybridAdapter (src/native), reshaped to the shared `Snapshot` (eN refs) and with
 * these rules, all enforced here or in the Swift helper (native/ax-helper), never by the model:
 *   - Accessibility actions only (AXPress, AX value set, AXConfirm, scroll-bar paging): they move no pointer and leave
 *     the app where it is. A step that only real keyboard/mouse input or bringing the app to the front could do
 *     returns `needsRealInput`, which the engine turns into a typed `needs_input` stop, unless the caller set
 *     `allowRealInput`; then the outcome says `realInput` and the trace records it.
 *   - A password field (AXSecureTextField) is marked `secret` and its value is never read, so the engine never
 *     offers it; `act` also refuses it directly (browser.session.act reaches here without the engine).
 *   - `ownerSignal` comes from typed AX facts only (window-control subroles, a sheet's or dialog's default button).
 *   - Every helper call names this app's pid: the helper never falls back to "whatever app is in front".
 * The window image (marked or not) is drawn by the helper: the bundle loads no image library.
 */
import type { AxHelperRequest, AxHelperResponse } from './ax-helper-client.js';
import type {
  ActOutcome,
  ScreenshotOptions,
  Shot,
  Snapshot,
  SnapshotElement,
  Target,
  TargetAction,
} from '../target.js';
import { unsupportedOn } from '../target.js';

export interface AxCaller {
  call(request: AxHelperRequest, timeoutMs?: number): Promise<AxHelperResponse>;
}

/** The OCR helper's two calls (src/app/ocr-client.ts), for apps whose AX tree is thin (Electron, canvas apps). */
export interface OcrCaller {
  capture(target: { readonly pid: number }): Promise<{
    readonly path: string;
    readonly originX: number;
    readonly originY: number;
    readonly scale: number;
  }>;
  ocr(
    imagePath: string,
    opts?: { readonly cacheKey?: string },
  ): Promise<{
    readonly lines: readonly {
      readonly text: string;
      readonly x: number;
      readonly y: number;
      readonly w: number;
      readonly h: number;
      readonly confidence: number;
    }[];
  }>;
}

export interface AppIdentity {
  readonly pid: number;
  readonly bundleId: string;
  readonly name: string;
}

export interface AppTargetOptions {
  readonly app: AppIdentity;
  readonly ax: AxCaller;
  /** Optional OCR reader; used only when AX labels fewer than `ocrBelow` on-screen elements. */
  readonly ocr?: OcrCaller;
  readonly ocrBelow?: number;
  /** May the backend bring the app to the front and send real keyboard/mouse input? Default false. */
  readonly allowRealInput?: boolean;
  readonly sleep?: (ms: number) => Promise<void>;
}

interface HelperElement {
  readonly id: string;
  readonly role: string;
  readonly label: string;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly offscreen?: boolean;
  readonly enabled?: boolean;
  readonly editable?: boolean;
  readonly value?: string;
  readonly checked?: boolean;
  readonly subrole?: string;
  readonly secure?: boolean;
  readonly ownerSignal?: string;
  readonly where?: string;
}

interface Entry {
  readonly element: SnapshotElement;
  /** Screen-point frame, for marks and OCR clicks. */
  readonly frame: readonly [number, number, number, number];
  readonly ocr: boolean;
}

const ROLE_NAMES: Readonly<Record<string, string>> = {
  AXButton: 'button',
  AXCheckBox: 'checkbox',
  AXRadioButton: 'radio button',
  AXTextField: 'text field',
  AXSecureTextField: 'password field',
  AXTextArea: 'text area',
  AXSlider: 'slider',
  AXTabGroup: 'tab group',
  AXTab: 'tab',
  AXLink: 'link',
  AXMenuItem: 'menu item',
  AXMenuButton: 'menu button',
  AXPopUpButton: 'pop-up button',
  AXComboBox: 'combo box',
  AXCell: 'cell',
  AXRow: 'row',
  AXMenuBarItem: 'menu',
};

const TEXT_LIMIT = 6000;
const OCR_MIN_CONFIDENCE = 0.3;

export class AppTarget implements Target {
  readonly backend = 'app';
  readonly description: string;
  private readonly entries = new Map<string, Entry>();
  private closed = false;
  private lastText = '';

  constructor(private readonly options: AppTargetOptions) {
    this.description = `${options.app.name} (${options.app.bundleId}, pid ${String(options.app.pid)})`;
  }

  get app(): AppIdentity {
    return this.options.app;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  private async helper(request: AxHelperRequest, timeoutMs?: number): Promise<AxHelperResponse> {
    return this.options.ax.call({ ...request, pid: this.options.app.pid }, timeoutMs);
  }

  async snapshot(): Promise<Snapshot> {
    const allowReal = this.options.allowRealInput === true;
    const raw = await this.helper({ op: 'snapshot', menus: allowReal }, 15_000);
    if (!raw.ok) throw new Error(`APP_SNAPSHOT_FAILED: ${raw.error ?? 'unknown error'}`);
    const window = raw['window'] as {
      title: string;
      x: number;
      y: number;
      w: number;
      h: number;
    } | null;
    const helperElements = (
      Array.isArray(raw['elements']) ? raw['elements'] : []
    ) as HelperElement[];
    const origin = window ? { x: window.x, y: window.y } : { x: 0, y: 0 };
    this.entries.clear();
    const elements: SnapshotElement[] = [];
    for (const item of helperElements) {
      if (item.enabled === false) continue;
      const ref = `e${String(elements.length + 1)}`;
      const element = toElement(item, ref, origin);
      elements.push(element);
      this.entries.set(ref, { element, frame: [item.x, item.y, item.w, item.h], ocr: false });
    }
    let text = typeof raw['text'] === 'string' ? raw['text'] : '';
    if (this.options.ocr && window && this.labelled(elements) < (this.options.ocrBelow ?? 8)) {
      text = await this.addOcr(elements, text, origin, allowReal);
    }
    this.lastText = text.slice(0, TEXT_LIMIT);
    const title = window?.title || this.options.app.name;
    return {
      url: `app://${this.options.app.bundleId}/${encodeURIComponent(window?.title ?? '')}`,
      title,
      text: window ? this.lastText : `${this.options.app.name} has no open window.`,
      elements,
      canScrollDown: raw['canScrollDown'] === true,
      canScrollUp: raw['canScrollUp'] === true,
      viewport: { w: window?.w ?? 0, h: window?.h ?? 0 },
      omitted: raw['truncated'] === true ? 1 : 0,
    };
  }

  private labelled(elements: readonly SnapshotElement[]): number {
    return elements.filter(
      (element) => !element.offscreen && element.label.trim() && !element.ownerSignal,
    ).length;
  }

  /**
   * OCR lines not covered by an AX element: always added to the text the model reads; offered as click targets only
   * when real input is allowed (a point with no AX element behind it can only be clicked for real).
   */
  private async addOcr(
    elements: SnapshotElement[],
    text: string,
    origin: { x: number; y: number },
    allowReal: boolean,
  ): Promise<string> {
    const ocr = this.options.ocr;
    if (!ocr) return text;
    let lines;
    let capture;
    try {
      capture = await ocr.capture({ pid: this.options.app.pid });
      lines = (await ocr.ocr(capture.path, { cacheKey: `app:${this.options.app.bundleId}` })).lines;
    } catch {
      return text;
    }
    const scale = capture.scale > 0 ? capture.scale : 1;
    const extra: string[] = [];
    for (const line of lines) {
      if (line.text.trim().length < 2 || line.confidence < OCR_MIN_CONFIDENCE) continue;
      const frame: [number, number, number, number] = [
        capture.originX + line.x / scale,
        capture.originY + line.y / scale,
        line.w / scale,
        line.h / scale,
      ];
      if ([...this.entries.values()].some((entry) => overlaps(entry.frame, frame))) continue;
      extra.push(line.text);
      if (!allowReal) continue;
      const ref = `e${String(elements.length + 1)}`;
      const element: SnapshotElement = {
        ref,
        role: 'text (read from the screen)',
        label: line.text,
        tag: 'ocr',
        type: '',
        kind: 'click',
        box: [frame[0] - origin.x, frame[1] - origin.y, frame[2], frame[3]],
        node: `ocr:${ref}`,
      };
      elements.push(element);
      this.entries.set(ref, { element, frame, ocr: true });
    }
    return extra.length ? `${text}\n${extra.join('\n')}`.trim() : text;
  }

  async act(action: TargetAction): Promise<ActOutcome> {
    const allowRealInput = this.options.allowRealInput === true;
    switch (action.kind) {
      case 'click':
      case 'type':
      case 'submit': {
        const entry = this.entries.get(action.ref);
        if (!entry) return { ok: false, error: `unknown ref ${action.ref}: take a new snapshot` };
        if (entry.element.secret === true)
          return { ok: false, error: 'a password field is never touched' };
        if (entry.ocr) {
          if (action.kind !== 'click')
            return { ok: false, error: 'text read from the screen cannot be typed into' };
          const [x, y, w, h] = entry.frame;
          return outcomeOf(
            await this.helper({ op: 'clickAt', x: x + w / 2, y: y + h / 2, allowRealInput }),
          );
        }
        if (action.kind === 'type') {
          if (entry.element.kind !== 'fill')
            return { ok: false, error: `${action.ref} is not a text field` };
          return outcomeOf(
            await this.helper({
              op: 'setValue',
              nodeId: entry.element.node,
              text: action.text,
              allowRealInput,
            }),
          );
        }
        return outcomeOf(
          await this.helper({
            op: action.kind === 'submit' ? 'confirm' : 'press',
            nodeId: entry.element.node,
            allowRealInput,
          }),
        );
      }
      case 'scroll':
        return outcomeOf(
          await this.helper({ op: 'scroll', direction: action.direction, allowRealInput }),
        );
      case 'wait':
        await (this.options.sleep ?? defaultSleep)(Math.min(Math.max(action.ms, 0), 10_000));
        return { ok: true };
      case 'select':
        return {
          ok: false,
          error: 'an app has no select fields: click the pop-up button, then its item',
        };
      case 'navigate':
      case 'back':
        return { ok: false, error: 'an app has no address or history to navigate' };
      default:
        // forward, reload, hover, press, upload: no Accessibility verb does them without real input.
        return unsupportedOn('app', action.kind);
    }
  }

  async screenshot(options: ScreenshotOptions = {}): Promise<Shot> {
    const marks = (options.marks ?? []).flatMap((element) => {
      const entry = this.entries.get(element.ref);
      if (!entry) return [];
      const [x, y, w, h] = entry.frame;
      return [{ ref: element.ref, x, y, w, h }];
    });
    const response = await this.helper(
      {
        op: 'screenshot',
        format: options.format === 'jpeg' ? 'jpeg' : 'png',
        ...(options.width ? { width: options.width } : {}),
        ...(options.quality ? { quality: options.quality } : {}),
        marks,
      },
      15_000,
    );
    if (!response.ok || typeof response['data'] !== 'string')
      throw new Error(`APP_SCREENSHOT_FAILED: ${response.error ?? 'no image'}`);
    return {
      data: response['data'],
      mimeType: response['mimeType'] === 'image/jpeg' ? 'image/jpeg' : 'image/png',
    };
  }

  async fullText(): Promise<string> {
    if (!this.lastText) await this.snapshot();
    return this.lastText;
  }

  /** Forgets the target. Quitting an app this backend launched is the service's call, not the target's. */
  close(): Promise<void> {
    this.closed = true;
    this.entries.clear();
    return Promise.resolve();
  }
}

function toElement(
  item: HelperElement,
  ref: string,
  origin: { x: number; y: number },
): SnapshotElement {
  const secure = item.secure === true;
  return {
    ref,
    role: ROLE_NAMES[item.role] ?? humanize(item.role),
    label: item.label,
    tag: item.role,
    type: secure ? 'password' : (item.subrole ?? ''),
    kind: item.editable === true ? 'fill' : 'click',
    ...(!secure && typeof item.value === 'string' && item.editable === true
      ? { value: item.value }
      : {}),
    ...(typeof item.checked === 'boolean' ? { checked: String(item.checked) } : {}),
    ...(secure ? { secret: true } : {}),
    ...(item.offscreen ? { offscreen: true } : {}),
    ...(item.where ? { where: item.where } : {}),
    box: [item.x - origin.x, item.y - origin.y, item.w, item.h],
    node: item.id,
    ...(item.ownerSignal ? { ownerSignal: item.ownerSignal } : {}),
  };
}

function outcomeOf(response: AxHelperResponse): ActOutcome {
  if (response.ok)
    return { ok: true, ...(response['realInput'] === true ? { realInput: true } : {}) };
  return {
    ok: false,
    error: response.error ?? 'the app refused the action',
    ...(response['needsRealInput'] === true ? { needsRealInput: true } : {}),
  };
}

function humanize(role: string): string {
  return role
    .replace(/^AX/, '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase();
}

function overlaps(a: readonly number[], b: readonly number[]): boolean {
  const [ax, ay, aw, ah] = a as [number, number, number, number];
  const [bx, by, bw, bh] = b as [number, number, number, number];
  const ix = Math.max(0, Math.min(ax + aw, bx + bw) - Math.max(ax, bx));
  const iy = Math.max(0, Math.min(ay + ah, by + bh) - Math.max(ay, by));
  const smaller = Math.min(aw * ah, bw * bh);
  return smaller > 0 && (ix * iy) / smaller >= 0.5;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));
