// A stand-in for native/ax-helper's marshal-ax-helper: the same JSON Lines protocol, scripted by the FAKE_AX
// environment variable (a JSON scenario), every request appended to FAKE_AX_LOG. It follows the Swift helper's
// rules: an element whose action needs real input ("real") is refused with needsRealInput unless the request says
// allowRealInput, and then it reports realInput. No macOS API is touched. Run with node --experimental-strip-types.
import { appendFileSync } from 'node:fs';
import process from 'node:process';

type Mode = 'ax' | 'real' | 'fail';

interface FakeElement {
  id: string;
  value?: string;
  press?: Mode;
  setValue?: Mode;
  confirm?: Mode;
  next?: string;
  [key: string]: unknown;
}

interface FakeWindow {
  window: unknown;
  text: string;
  elements: FakeElement[];
  canScrollDown?: boolean;
}

interface Scenario {
  permissions?: Record<string, boolean>;
  apps?: unknown[];
  launch?: Record<string, unknown>;
  start?: string;
  windows?: Record<string, FakeWindow>;
  scroll?: Mode;
}

interface Request {
  id: number;
  op: string;
  nodeId?: string;
  text?: string;
  format?: string;
  marks?: unknown[];
  allowRealInput?: boolean;
}

type Response = Record<string, unknown>;

const scenario = JSON.parse(process.env['FAKE_AX'] ?? '{}') as Scenario;
const logPath = process.env['FAKE_AX_LOG'];
const windows = scenario.windows ?? {};
let state = scenario.start ?? 'main';

const current = (): FakeWindow => windows[state] ?? { window: null, text: '', elements: [] };
const find = (nodeId: string | undefined): FakeElement | undefined =>
  current().elements.find((element) => element.id === nodeId);

function run(mode: Mode, request: Request, onSuccess: () => void): Response {
  if (mode === 'fail') return { ok: false, error: 'the app refused' };
  if (mode === 'real') {
    if (request.allowRealInput !== true)
      return { ok: false, needsRealInput: true, error: 'needs real input (fake)' };
    onSuccess();
    return { ok: true, realInput: true };
  }
  onSuccess();
  return { ok: true, realInput: false };
}

function publicElement(element: FakeElement): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...element };
  for (const key of ['press', 'setValue', 'confirm', 'next']) Reflect.deleteProperty(copy, key);
  return copy;
}

function handle(request: Request): Response {
  switch (request.op) {
    case 'permissions':
      return {
        ok: true,
        accessibility: true,
        screenRecording: true,
        screenLocked: false,
        ...scenario.permissions,
      };
    case 'apps':
      return { ok: true, apps: scenario.apps ?? [] };
    case 'launch':
      return { ok: true, ...(scenario.launch ?? { found: false }) };
    case 'quit':
      return { ok: true, exited: true };
    case 'snapshot': {
      const win = current();
      return {
        ok: true,
        window: win.window,
        text: win.text,
        canScrollDown: win.canScrollDown === true,
        canScrollUp: false,
        truncated: false,
        elements: win.elements.map(publicElement),
      };
    }
    case 'press':
    case 'confirm': {
      const element = find(request.nodeId);
      if (!element) return { ok: false, error: `unknown element ${request.nodeId ?? ''}` };
      const mode = (request.op === 'press' ? element.press : element.confirm) ?? 'ax';
      return run(mode, request, () => {
        if (element.next) state = element.next;
      });
    }
    case 'setValue': {
      const element = find(request.nodeId);
      if (!element) return { ok: false, error: `unknown element ${request.nodeId ?? ''}` };
      return run(element.setValue ?? 'ax', request, () => {
        element.value = request.text ?? '';
      });
    }
    case 'scroll':
      return run(scenario.scroll ?? 'ax', request, () => undefined);
    case 'clickAt':
      return run('real', request, () => undefined);
    case 'screenshot':
      return {
        ok: true,
        data: 'AAAA',
        mimeType: request.format === 'jpeg' ? 'image/jpeg' : 'image/png',
        drawn: (request.marks ?? []).length,
      };
    default:
      return { ok: false, error: `unknown op "${request.op}"` };
  }
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk: string) => {
  buffer += chunk;
  const lines = buffer.split('\n');
  buffer = lines.pop() ?? '';
  for (const line of lines) {
    if (!line.trim()) continue;
    const request = JSON.parse(line) as Request;
    if (logPath) appendFileSync(logPath, `${JSON.stringify(request)}\n`);
    process.stdout.write(`${JSON.stringify({ id: request.id, ...handle(request) })}\n`);
  }
});
