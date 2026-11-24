/**
 * Live proof that the app backend drives an app in the background: opens an on:"app" session (TextEdit, or a Chrome
 * by pid), runs click / type / Enter / scroll steps with allowRealInput, and logs the frontmost app (bundle:pid) and
 * the pointer before and after each step. The target app must never become frontmost; the pointer only moves when
 * the person moves it. Usage: npx esbuild bench/prove-app-background.ts --bundle --platform=node --format=esm --outfile=<out>.mjs, then
 * MARSHAL_BROWSER_ROOT=<packages/browser> node <out>.mjs <app> [pid] [textedit|chrome]
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AppService } from '../src/app/service.js';
import type { TargetAction } from '../src/target.js';

const packageRoot =
  process.env['MARSHAL_BROWSER_ROOT'] ??
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [app = 'TextEdit', pidArg, plan = 'textedit'] = process.argv.slice(2);
const front = (): string =>
  execFileSync(
    'osascript',
    [
      '-e',
      'tell application "System Events" to tell (first process whose frontmost is true) to get (bundle identifier as text) & ":" & (unix id as text)',
    ],
    { encoding: 'utf8' },
  ).trim();
const pointer = (): string =>
  execFileSync(
    'osascript',
    [
      '-l',
      'JavaScript',
      '-e',
      "ObjC.import('AppKit'); var p=$.NSEvent.mouseLocation; Math.round(p.x)+','+Math.round(p.y)",
    ],
    { encoding: 'utf8' },
  ).trim();

const service = new AppService({ packageRoot, save: () => Promise.resolve(''), ocr: null });
const opened = await service.open({
  app,
  ...(pidArg ? { pid: Number(pidArg) } : {}),
  allowRealInput: true,
  launch: false,
});
if (opened['ok'] !== true) throw new Error(JSON.stringify(opened));
const sessionId = opened['sessionId'];
const targetPid = String(opened['app']).match(/pid (\d+)/)?.[1] ?? '';
console.log(JSON.stringify({ opened: opened['app'], title: opened['title'] }));

type Snap = {
  elements: { ref: string; role: string; label: string; value?: string }[];
  text: string;
  title: string;
};
const snap = async (): Promise<Snap> =>
  (await service.targetOf(sessionId).snapshot()) as unknown as Snap;
const find = (s: Snap, pred: (e: Snap['elements'][number]) => boolean): string => {
  const hit = s.elements.find(pred);
  if (!hit)
    throw new Error(
      `no element: ${JSON.stringify(s.elements.map((e) => [e.ref, e.role, e.label]).slice(0, 40))}`,
    );
  return hit.ref;
};
let frontmostTarget = false;
const step = async (
  name: string,
  action: (s: Snap) => TargetAction,
  check: (s: Snap) => string,
): Promise<void> => {
  const before = await snap();
  const fb = front();
  const pb = pointer();
  const startedAt = Date.now();
  const result = await service.act({ sessionId }, action(before));
  const endedAt = Date.now();
  await new Promise((r) => setTimeout(r, 600));
  const fa = front();
  const after = await snap();
  if (fb.endsWith(`:${targetPid}`) || fa.endsWith(`:${targetPid}`)) frontmostTarget = true;
  console.log(
    JSON.stringify({
      startedAt,
      endedAt,
      targetPid,
      step: name,
      ok: result['ok'],
      realInput: result['realInput'] ?? false,
      error: result['error'],
      frontBefore: fb,
      frontAfter: fa,
      pointerBefore: pb,
      pointerAfter: pointer(),
      check: check(after),
    }),
  );
};

if (plan === 'textedit') {
  const area = (s: Snap): string => find(s, (e) => e.role === 'text area');
  await step(
    'type into the document',
    (s) => ({ kind: 'type', ref: area(s), text: 'typed in the background 1' }),
    (s) => s.elements.find((e) => e.role === 'text area')?.value?.slice(0, 60) ?? '',
  );
  await step(
    'scroll down',
    () => ({ kind: 'scroll', direction: 'down' }),
    (s) => s.title,
  );
} else {
  const field = (s: Snap): string =>
    find(
      s,
      (e) =>
        e.role === 'text field' &&
        e.value !== undefined &&
        !e.value.startsWith('/') &&
        !e.label.includes('Address'),
    );
  const heading = (s: Snap): string => s.text.split('\n')[0] ?? '';
  await step(
    'scroll up (back to the top)',
    () => ({ kind: 'scroll', direction: 'up' }),
    (s) => s.title,
  );
  await step(
    'type into the page field',
    (s) => ({ kind: 'type', ref: field(s), text: 'héllo wörld 42' }),
    (s) =>
      `field=${s.elements.find((e) => e.role === 'text field' && !e.label.includes('Address'))?.value ?? ''}`,
  );
  await step('submit the field (Enter)', (s) => ({ kind: 'submit', ref: field(s) }), heading);
  await step(
    'click the plain div',
    (s) => ({ kind: 'click', ref: find(s, (e) => e.label === 'plain div') }),
    heading,
  );
  await step(
    'scroll down',
    () => ({ kind: 'scroll', direction: 'down' }),
    (s) => s.title,
  );
}
console.log(JSON.stringify({ targetPid, targetEverFrontmost: frontmostTarget }));
await service.close({ sessionId });
process.exit(0);
