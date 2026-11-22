// Removes each app-backend guard in turn and checks that tests/app.test.ts (or engine.test.ts) then FAILS, so no guard
// is covered only by luck. Every file is restored afterwards. Run: node scripts/mutate-app-guards.mjs
import { execFileSync } from 'node:child_process';
import { log } from 'node:console';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MUTATIONS = [
  {
    name: 'secret fields offered (offers.ts isSecret skip removed)',
    file: 'src/engine/offers.ts',
    from: '    if (isSecret(element)) continue;\n',
    to: '',
  },
  {
    name: 'app target stops marking AXSecureTextField as secret',
    file: 'src/app/app-target.ts',
    from: '    ...(secure ? { secret: true } : {}),\n',
    to: '',
  },
  {
    name: 'app target act() no longer refuses a password field',
    file: 'src/app/app-target.ts',
    from: "        if (entry.element.secret === true)\n          return { ok: false, error: 'a password field is never touched' };\n",
    to: '',
  },
  {
    name: 'typed owner signal guard removed from the engine',
    file: 'src/engine/task.ts',
    from: 'if (offer.element && signalNeedsOwner(offer.element, offer.kind)) {',
    to: 'if (false) {',
  },
  {
    name: 'app target drops the ownerSignal field',
    file: 'src/app/app-target.ts',
    from: '    ...(item.ownerSignal ? { ownerSignal: item.ownerSignal } : {}),\n',
    to: '',
  },
  {
    name: 'needs_input stop on needsRealInput removed (falls back to a retried failure)',
    file: 'src/engine/task.ts',
    from: 'if (!outcome.ok && outcome.needsRealInput) {',
    to: 'if (false) {',
  },
  {
    name: 'allowRealInput forced on',
    file: 'src/app/app-target.ts',
    from: '    const allowRealInput = this.options.allowRealInput === true;\n',
    to: '    const allowRealInput = true;\n',
  },
  {
    name: 'menus read without permission to take focus',
    file: 'src/app/app-target.ts',
    from: "{ op: 'snapshot', menus: allowReal }",
    to: "{ op: 'snapshot', menus: true }",
  },
  {
    name: 'helper requests no longer carry the pid',
    file: 'src/app/app-target.ts',
    from: 'return this.options.ax.call({ ...request, pid: this.options.app.pid }, timeoutMs);',
    to: 'return this.options.ax.call({ ...request }, timeoutMs);',
  },
  {
    name: 'an already-running app is quit too',
    file: 'src/app/service.ts',
    from: '    if (running) return { app: running, launched: false };',
    to: '    if (running) return { app: running, launched: true };',
  },
  {
    name: 'typed text read from the model instead of values (actionOf)',
    file: 'src/engine/offers.ts',
    from: '      const text = values[offer.valueName];',
    to: '      const text = offer.valueName;',
  },
  {
    name: 'a locked screen counts as ready',
    file: 'src/app/service.ts',
    from: "      : screenLocked\n        ? 'screen_locked'\n        : undefined;",
    to: '      : undefined;',
  },
  {
    name: 'missing Accessibility counts as ready',
    file: 'src/app/service.ts',
    from: "    const reason = !accessibility.granted\n      ? 'accessibility_not_granted'",
    to: "    const reason = false\n      ? 'accessibility_not_granted'",
  },
  {
    name: 'decision sent without the marked screenshot (app task)',
    file: 'src/app/service.ts',
    from: "typeof args['vision'] === 'boolean' ? args['vision'] : (configuration.vision ?? true),",
    to: 'false,',
  },
];

const results = [];
for (const mutation of MUTATIONS) {
  const file = path.join(root, mutation.file);
  const original = readFileSync(file, 'utf8');
  if (!original.includes(mutation.from)) {
    results.push({ name: mutation.name, result: 'MUTATION DID NOT APPLY' });
    continue;
  }
  writeFileSync(file, original.replace(mutation.from, mutation.to));
  let failed = false;
  try {
    execFileSync('npx', ['vitest', 'run', 'tests/app.test.ts', 'tests/engine.test.ts'], {
      cwd: root,
      stdio: 'pipe',
      env: { ...process.env, VITEST_MAX_WORKERS: '', VITEST_MAX_THREADS: '', VITEST_MAX_FORKS: '' },
    });
  } catch {
    failed = true;
  } finally {
    writeFileSync(file, original);
  }
  results.push({ name: mutation.name, result: failed ? 'caught (tests fail)' : 'NOT CAUGHT' });
}
for (const r of results) log(`${r.result.padEnd(24)} ${r.name}`);
if (results.some((r) => r.result !== 'caught (tests fail)')) process.exit(1);
