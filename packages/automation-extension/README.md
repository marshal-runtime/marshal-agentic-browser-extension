# @agentic-browser/automation-extension

Marshal Runtime extension for Jev-powered hierarchical automation, over a
browser tab or a native macOS app. A cheap planner agent decomposes a goal
into small subgoals; a code executor (no LLM in the loop) drives
[TypeSafe](https://typesafe.ai)'s Jev "System One" model through each
subgoal, one element-choice call at a time; code (or an optional Jev
judgement) verifies the result.

## Three tiers

1. **Planner** (cheap LLM, launched via `marshal.agent.launch` with
   `allowedTools: [runtimeInvoke, runtimeSearch, runtimeExecuteTypeScript]`;
   hosts that reject `allowedTools` get one retry without it, reported as
   `stats.allowlistApplied: false`) - writes the whole plan as one
   `runtimeExecuteTypeScript` block that runs the subgoals with checks,
   extracts the result via `*.observe { find }`, and calls `*.finish`,
   returning to the model only on failure. `*.run` stats include per-phase
   timing (`subgoalMs`, `checkMs`, `observeMs`, `startupMs`,
   `plannerThinkMs`) and `jevLatencyMs`.
2. **Executor** (`*.subgoal`, pure code, `src/executor.ts`) - the
   observe/decide/act loop, driven entirely through a `PerceptionAdapter`
   (below) so the same code runs against a browser tab or a native app.
3. **Verifier** (pure code postconditions, `src/checks.ts`) - `Check`s
   evaluated in code, plus an optional `jev_noul` model judgement for
   subjective conditions.

## The PerceptionAdapter seam

`src/adapter.ts` defines the single interface the executor talks to:
`snapshot()` (budgeted `PageSnapshot`, ≤6000 chars text, ≤250 onscreen +
≤60 offscreen actions), an optional cheap `marker()` fast path for
freshness checks, `act(action, text?)` (never throws, returns `{ ok,
error? }`), `fullText()`, `screenshot()`, optional `dispose()`. Three
adapters implement it; the executor and checks are otherwise unaware which
one is in play:

- **`DomAdapter`** (`src/dom-adapter.ts`) - a browser tab, driven through
  `browser_execute_script`/`browser_click`/`browser_type`.
- **`AxAdapter`** (`src/native/ax-adapter.ts`) - a native macOS app, driven
  through the `marshal-ax-helper` Swift binary over its Accessibility tree.
- **`HybridAdapter`** (`src/native/hybrid-adapter.ts`) - wraps an `AxAdapter`
  and merges in OCR (`marshal-ocr-helper`) for surfaces the AX tree can't
  see (canvas apps, terminals, custom-drawn Electron widgets, cross-origin
  iframes, PDF viewers). AX-sourced actions are always still driven through
  the wrapped adapter's own `act()`; only OCR-only candidates (`source:
'ocr'`) click at a point. An AX action that overlaps and text-matches an
  OCR line absorbs it (`source: 'ax+ocr'`, longer text wins as the label)
  instead of producing a duplicate.

## Capabilities

**Browser** (`src/capabilities.ts`): `browser.automation.run`, `.subgoal`,
`.check`, `.observe`, `.finish`, `.get`. `run` takes `{ goal, startUrl? }`.

**Native app** (`src/native/native-capabilities.ts`): the same six ops
under `computer.automation.*`, plus `computer.automation.apps` (lists
running GUI apps with Accessibility/Screen Recording permission status).
`computer.automation.run` takes `{ goal, app, ocrMode? }` - `app` is a
bundle id (e.g. `com.apple.TextEdit`) or name (matched exactly by bundle
id, then exact name, then substring); `ocrMode` (`'auto' | 'always' |
'never'`, defaults to the `ocrMode` config value, then `'auto'`) selects
whether `HybridAdapter` wraps the `AxAdapter` for that run - OCR is also
skipped whenever no `marshal-ocr-helper` binary is installed.

Both `run` capabilities focus/launch the target, run the planner through
the same subgoal/check/observe/finish loop, and block until it finishes,
returning `{ runId, status, result, evidence, plannerSessionId, stats }`.
On failure to start, `run` returns `status: 'blocked'` with `reason:
'jev-not-connected'` (call `jev.connect`) or, for `computer.automation.run`
only, `reason: 'accessibility-not-granted'` (see TCC below).

## Configuration

All keys are optional (`runtime-extension.json` → `configuration.schema`):

| Key                   | Default                                  | Notes                                                                                    |
| --------------------- | ---------------------------------------- | ---------------------------------------------------------------------------------------- |
| `defaultPlannerModel` | host default                             | Model for the planner agent.                                                             |
| `defaultJevModel`     | Jev connector default                    | Model passed to `jevClient.ask()`.                                                       |
| `maxStepsPerSubgoal`  | `15`                                     | Executor step budget per subgoal.                                                        |
| `minConfidence`       | `0.4`                                    | Confidence gate threshold (see below).                                                   |
| `axHelperPath`        | bundled `dist/native/marshal-ax-helper`  | Absolute path override.                                                                  |
| `ocrHelperPath`       | bundled `dist/native/marshal-ocr-helper` | Absolute path override; `computer.automation.run` only uses OCR when this binary exists. |
| `ocrMode`             | `'auto'`                                 | Default for `computer.automation.run` when the request omits `ocrMode`.                  |

## Confidence gate

Each executor step asks Jev to choose an operation and a target element,
each returned with a probability. When either confidence is below
`minConfidence`, the executor doesn't act blind: it re-checks the page for
freshness, retries once after a short wait, and if confidence still
doesn't clear the bar, returns subgoal status `'low_confidence'` with
`lowConfidence: { operation, confidence, topCandidates: [{ index, label,
probability }] }`, so the planner can see the runner-up candidates and
either retry with a more specific subgoal or ask the user.

## DOM snapshot fields

`DomAdapter`'s snapshot actions carry `where` (a 9-region compass label, or
`'above'`/`'below'` when offscreen), `box` (`[x, y, w, h]` in screen
points), `near` (nearby label text for ambiguous controls), and
`offscreen`; the focused field, if editable, is reported as `focused`. The
walk pierces open shadow roots and same-origin iframes (composed-tree walk,
depth-capped at 6): pierced element ids are paths, `sh:<hostId>/<id>` for a
shadow host and `if:<iframeId>/<id>` for an iframe (nesting allowed, e.g.
`if:2/sh:5/9`), carrying `source: 'dom'`; `DomAdapter.act()` resolves them
with an in-page script (`src/snapshot-walk.ts`) instead of
`browser_click`/`browser_type`. The walk itself has no cap - it always
covers the whole composed tree, so onscreen elements below a long scroll
position are never starved by offscreen elements earlier in DOM order -
then elements are bucketed onscreen/offscreen in walk order and each
bucket is capped (250 onscreen, 60 offscreen). The fast `marker()` path
and the full `snapshot()` path share one `__mjevFingerprint` projection
applied to the identical two-bucket construction, so an unchanged page
always produces a byte-identical marker - what the executor's freshness
check relies on.

## Native helpers

Two Swift packages under `native/`, each a long-lived process speaking
JSON-lines over stdin/stdout (one JSON object per line in, one per line
out). Build each with `swift build -c release` from its package directory;
`build.mjs` then copies `native/ax-helper/.build/release/marshal-ax-helper`
and `native/ocr-helper/.build/release/marshal-ocr-helper` into
`dist/native/` (mode `0o755`) as part of `npm run build`.

**`marshal-ax-helper`** drives the macOS Accessibility API: `permissions`,
`apps`, `focus`, `snapshot`, `press`, `setValue`, `click`, `type`, `key`,
`scroll`, `screenshot` - one op per request line, one response object per
reply line. `AxAdapter`/`AxHelperClient` speak this protocol and restart
the process on failure.

**`marshal-ocr-helper`** exposes Vision-backed OCR (`ocr`, with a tile-diff
cache keyed by `cacheKey` so unchanged regions of a repeatedly-captured
window are skipped) and frontmost-window capture (`capture`), plus a
`--selftest <png>` one-shot mode for manual verification outside the
JSON-lines protocol. `OcrClient` drives it and `HybridAdapter` consumes
its output.

**macOS TCC**: the Marshal process itself needs Accessibility permission
(for `marshal-ax-helper`) and, when OCR is in play, Screen Recording
permission (to capture window contents). `computer.automation.run` checks
Accessibility up front and returns `status: 'blocked', reason:
'accessibility-not-granted'` with a hint pointing at
`x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility`
rather than failing deep into a run.

**Chromium/Electron caveat**: apps like Slack/Notion/VS Code only build a
full-fidelity AX tree once an assistive client announces itself.
`marshal-ax-helper` sets `AXManualAccessibility`/`AXEnhancedUserInterface`
on first snapshot of each pid and retries the walk with backoff waiting for
the tree to populate (a no-op on native AppKit apps). Some Electron apps
still gate parts of their web-content tree regardless - `HybridAdapter`'s
OCR fallback is the practical way to see those surfaces.

## Bundle module allow-list

The extension ships as a single esbuild CJS bundle (`dist/runtime.cjs`,
built from `src/runtime.ts`, external `@agentic-browser/runtime-host` and
`@marshal/*`). The Marshal Runtime host's `@marshal/agent-runtime-extensions`
loader only allows a fixed set of Node builtins to be `require()`d from an
extension bundle (`DEFAULT_NODE_BUILTIN_MODULES` in its `loader.js`) - no
`node:fs`, no `readline`, etc. `tests/manifest.test.ts` scans
`dist/runtime.cjs` and asserts every `require()` is in that allow-list;
keep new dependencies within it, or behind the native-helper subprocess
boundary (JSON-lines over stdio needs no extra Node builtins in-bundle).

## Attribution

The snapshot script (`src/snapshot-script.ts`), the operation/target action
space (`src/action-space.ts`), the Jev question construction
(`src/decide.ts`, `src/questions.ts`), and the executor state machine
(`src/executor.ts`) are TypeScript ports of
[Browser Use's `jev-ultrafast`](https://github.com/browser-use/jev-ultrafast)
reference client (`jev_ultrafast/{agent.py,model.py,questions.py,snapshot.js}`),
licensed MIT, Copyright (c) 2026 Browser Use:

```
MIT License

Copyright (c) 2026 Browser Use

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

Notable, deliberate deviations from upstream (see each file's header comment
for details):

- The snapshot script stamps every interactive element with a
  `data-mjev-id` attribute and is written as a `return`-terminated script
  body (this host's `browser_execute_script` wraps the given script as an
  async function body), instead of upstream's IIFE-expression + CDP node-id
  cache.
- TYPE_TEXT values come from the planner-supplied `values` map (matched by
  field label), never a separate text-generation model call - this port has
  no text LLM at all.
- DONE is verified by an explicit code `Check` when the caller supplies one;
  otherwise it is reported as `claimed_done`, explicitly unverified, rather
  than upstream's screenshot-only trust of the model's DONE claim.
- The native (`computer.automation.*`) side - `AxAdapter`, `HybridAdapter`,
  the two Swift helpers - has no upstream equivalent in `jev-ultrafast`; it
  reuses the ported executor/checks/action-space pipeline unchanged against
  a different `PerceptionAdapter`.

## Dependency

Requires `@marshal/jev` (the Jev connector extension) to be installed and
its `@marshal/jev:client` service active - see `runtime-extension.json`.
