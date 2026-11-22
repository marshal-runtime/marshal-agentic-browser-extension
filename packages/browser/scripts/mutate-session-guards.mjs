// Removes each session-operation guard in turn (browser.session.* kinds and operations, the person's Chrome setup,
// viewport and capture limits) and checks that a test then FAILS. Real-Chrome cases need Chrome; without it they are
// skipped, so a mutation they cover shows NOT CAUGHT. Every file is restored. Run: node scripts/mutate-session-guards.mjs
import { execFileSync } from 'node:child_process';
import { log } from 'node:console';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const UNIT = 'tests/session-ops.test.ts';
const REAL = 'tests/session-ops.real.test.ts';
const MUTATIONS = [
  {
    name: 'managed press: no secret-focus check',
    file: 'src/chrome/tab.ts',
    from: 'if (EDITING_KEYS.has(key) && (await this.evaluate(FOCUSED_SECRET_SCRIPT)) === true)',
    to: 'if (false as boolean)',
    tests: [REAL],
  },
  {
    name: 'user press: no secret-field check',
    file: 'src/user/tab.ts',
    from: 'if (EDITING_KEYS.has(action.key) && (this.last?.elements ?? []).some(isSecret))',
    to: 'if (false as boolean)',
    tests: [UNIT],
  },
  {
    name: 'evaluate: any backend',
    file: 'src/session-ops.ts',
    from: "if (target.backend !== 'managed' || !target.evaluateExpression)",
    to: 'if (!target.evaluateExpression)',
    tests: [UNIT],
  },
  {
    name: 'parseAction: any key',
    file: 'src/capabilities.ts',
    from: "if (typeof key !== 'string' || !(PRESS_KEYS as readonly string[]).includes(key)) break;",
    to: "if (typeof key !== 'string') break;",
    tests: [UNIT],
  },
  {
    name: 'parseAction: any modifier',
    file: 'src/capabilities.ts',
    from: '!modifiers.every((modifier) => (MODIFIERS as readonly unknown[]).includes(modifier))',
    to: 'false',
    tests: [UNIT],
  },
  {
    name: 'upload: relative paths',
    file: 'src/chrome/tab.ts',
    from: 'if (!path.isAbsolute(file)) return',
    to: 'if (false as boolean) return',
    tests: [UNIT, REAL],
  },
  {
    name: 'upload: file count limit',
    file: 'src/chrome/tab.ts',
    from: 'if (paths.length > UPLOAD_MAX_FILES)',
    to: 'if (false as boolean)',
    tests: [UNIT],
  },
  {
    name: 'upload: single-file input',
    file: 'src/chrome/tab.ts',
    from: "if (opened.params['mode'] === 'selectSingle' && files.length > 1)",
    to: 'if (false as boolean)',
    tests: [REAL],
  },
  {
    name: 'user: upload/hover substituted by a click',
    file: 'src/user/tab.ts',
    from: "        return unsupportedOn('user', action.kind);",
    to: "        await this.call('browserbridge.click', { tabId: this.tabId, ref: action.ref });\n        return { ok: true };",
    tests: [UNIT],
  },
  {
    name: 'log: observing on by default',
    file: 'src/capabilities.ts',
    from: "const observe = args['observe'] === undefined ? [] : sessionOps.logKinds(args['observe']);",
    to: "const observe = args['observe'] === undefined ? sessionOps.logKinds(undefined) : sessionOps.logKinds(args['observe']);",
    tests: [REAL],
  },
  {
    name: 'log: request headers recorded',
    file: 'src/chrome/tab.ts',
    from: "          ...(typeof params['type'] === 'string' ? { resourceType: params['type'] } : {}),\n          outcome,",
    to: "          ...(typeof params['type'] === 'string' ? { resourceType: params['type'] } : {}),\n          headers: (params['request'] as { headers?: unknown } | undefined)?.headers,\n          outcome,",
    tests: [REAL],
  },
  {
    name: 'act: no dialog race',
    file: 'src/chrome/tab.ts',
    from: 'const raced = await this.raceDialog(() => this.perform(action));',
    to: 'const raced = { value: await this.perform(action) } as { value: ActOutcome } | { dialog: PageDialog };',
    tests: [REAL],
  },
  {
    name: 'routing stop: no setup',
    file: 'src/user/routing.ts',
    from: '      ...(status.setup ? { setup: status.setup } : {}),',
    to: '',
    tests: [UNIT],
  },
  {
    name: 'session.open on user: generic error',
    file: 'src/capabilities.ts',
    from: 'if (!status.ready || !bridge) throw new UserNotPaired(status);',
    to: "if (!status.ready || !bridge) throw new Error('BROWSER_USER_NOT_PAIRED: ' + status.reason);",
    tests: [UNIT],
  },
  {
    name: 'status: no setup when not ready',
    file: 'src/user/status.ts',
    from: '    setup: setupFor(reason),\n',
    to: '',
    tests: [UNIT],
  },
  {
    name: 'open on:user with viewport: no refusal',
    file: 'src/capabilities.ts',
    from: "if (args['viewport'] !== undefined) return sessionOps.unsupported('user', 'viewport');",
    to: '',
    tests: [UNIT],
  },
  {
    name: 'screenshot clip on user: no refusal',
    file: 'src/capabilities.ts',
    from: "if (options.clip && session.tab.backend !== 'managed')",
    to: 'if (false as boolean)',
    tests: [UNIT],
  },
  {
    name: 'clip: no height cap',
    file: 'src/session-ops.ts',
    from: 'if (width > VIEWPORT_LIMITS.maxWidth || height > CAPTURE_MAX_CSS)',
    to: 'if (false as boolean)',
    tests: [UNIT],
  },
  {
    name: 'viewport: no range check',
    file: 'src/session-ops.ts',
    from: 'number < minSide || number > max',
    to: 'false',
    tests: [UNIT, REAL],
  },
  {
    name: 'viewport: scale unchecked',
    file: 'src/session-ops.ts',
    from: '(!finite(scale) || scale <= 0 || scale > maxScale)',
    to: '(false as boolean)',
    tests: [UNIT],
  },
  {
    name: 'full page: old 12,000 cap',
    file: 'src/target.ts',
    from: 'export const CAPTURE_MAX_CSS = 30_000;',
    to: 'export const CAPTURE_MAX_CSS = 12_000;',
    tests: [REAL],
  },
  {
    name: 'viewport: touch not emulated',
    file: 'src/chrome/tab.ts',
    from: "await this.send('Emulation.setTouchEmulationEnabled', {",
    to: 'void ({',
    tests: [REAL],
  },
  {
    name: 'SDK host Chrome env not read',
    file: 'src/chrome/launcher.ts',
    from: "['MARSHAL_BROWSER_CHROME', 'MARSHAL_SDK_CHROME']",
    to: "['MARSHAL_BROWSER_CHROME']",
    tests: [UNIT],
  },
];

MUTATIONS.push({
  name: 'captures past 16,384 device px: GPU compositing back on',
  file: 'src/chrome/launcher.ts',
  from: "'--mute-audio', '--disable-gpu-compositing']",
  to: "'--mute-audio']",
  tests: [REAL],
});

const results = [];
for (const mutation of MUTATIONS) {
  const file = path.join(root, mutation.file);
  const original = readFileSync(file, 'utf8');
  if (!original.includes(mutation.from)) {
    results.push({ name: mutation.name, result: 'MUTATION DID NOT APPLY' });
    continue;
  }
  writeFileSync(file, original.replace(mutation.from, mutation.to));
  let result = 'NOT CAUGHT';
  try {
    execFileSync('npx', ['vitest', 'run', ...mutation.tests], {
      cwd: root,
      stdio: 'pipe',
      env: { ...process.env, VITEST_MAX_WORKERS: '', VITEST_MAX_THREADS: '', VITEST_MAX_FORKS: '' },
    });
  } catch (error) {
    const text = String(error.stdout ?? '') + String(error.stderr ?? '');
    // A compile or transform error is not evidence that a test covers the guard.
    result = /\d+ failed/.test(text) ? 'caught (tests fail)' : 'INVALID (did not compile)';
  } finally {
    writeFileSync(file, original);
  }
  results.push({ name: mutation.name, result });
}
for (const r of results) log(`${r.result.padEnd(26)} ${r.name}`);
if (results.some((r) => r.result !== 'caught (tests fail)')) process.exit(1);
