# @marshal/browser

One browser for every Marshal agent: a runtime extension that drives a real Chrome and answers a goal with data, text
or a screenshot. This is the first slice of the unified design. It has the `managed` backend (Chrome it starts itself);
the person's own Chrome (`user`, through the browser bridge); native apps (`app`), the live view and recording are seams, not code yet.

## Capabilities

| Capability                                                   | What it does                                                                                                                                                                                      |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `browser.status`                                             | Backends and whether each is ready, the decide service, open sessions                                                                                                                             |
| `browser.task`                                               | `{goal, on?, profile?, startUrl?, values?, want: {data?, text?, screenshot?}, bounds?: {maxSteps?, wallMs?}, allowedSites?, vision?, sessionId?, keepOpen?}` runs the step engine to a typed stop |
| `browser.ask`                                                | `{url \| sessionId, questions}` answers named questions about one page in one decide call                                                                                                         |
| `browser.session.open / snapshot / act / screenshot / close` | Direct control: open a tab, read `eN` refs, act on a ref, take a (marked) screenshot                                                                                                              |

`browser.task` stops with one of `done`, `needs_input`, `needs_owner`, `blocked`, `low_confidence`, `budget` or
`decisions_unavailable`, with the trace (`{step, action, rung, ms, actMs, url, confidence, checks, note}`), stats and
screenshot artifacts.

## How a step works

1. **Rung 0 (code):** open `startUrl`, snapshot the page (elements get refs `e1..eN`), build the offered actions, take
   a JPEG with a numbered box on each offered element.
2. **Rung 1 (one decide call):** `marshal.models.decide` gets the page, the history, the value _names_ and the marked
   screenshot, and answers four questions at once: `next_action` (a choice over the offers), `goal_met`, `needs_owner`
   and `page_ready` (yes/no predicates).
3. **Gates in code:** below `minConfidence` the engine re-decides once on a fresh snapshot and acts only if the retry
   picks the same page action; a secret field is never offered; typed text comes only from `values`; a link that leaves
   the site, or whose path is an OAuth, consent, checkout, payment, billing or install page, stops with `needs_owner`;
   the same action on an unchanged page three times, three failed actions, the step bound and the wall clock all stop.
4. **Rung 2:** when the goal is met and `want.data` is a JSON schema, one decide call with that schema (and the
   screenshot) extracts the data.

Models are reached only through the host's `marshal.models.decide` (marshal-sdk, or Marshal desktop when it offers
it): the extension holds no provider URL, key or model name, and has no Jev dependency.

## The managed backend

Chrome is driven over `--remote-debugging-pipe`, so no debugging port is opened, and nothing attaches to the person's
Chrome. At most two processes start, on first use:

- `agent`: a lasting profile (`~/.marshal/browser/profiles/agent`, or `profileRoot`), so logins persist. Headless
  unless `headed` is set or, on Linux, a `DISPLAY` exists.
- `visitor` (the default) and `offline`: one throwaway, headless process. Each session gets its own fresh browser
  context (no cookies, no storage). `visitor` never intercepts a request (no Fetch domain, zygstinct rule SB21).
  `offline` sends every request, loopback included, to a dead proxy, so only `data:` and pages already in memory
  render.

## The user backend

The person's own signed-in Chrome, behind the same `Target` (`src/user/`). The transport is the installed
`@zygstinct/browser-bridge` extension's `browserbridge.*` capabilities, reached through the host's `execute` with the
caller's invocation context. No second socket is opened, and only the non-evaluate verbs are used.

- `on: "user"` on `browser.session.open`, `browser.ask` and `browser.task` opens a **background** tab
  (`active: false`) in the bridge's "Marley" tab group, at the given url. It never adopts a tab the person already has,
  never focuses Chrome, and closes only the tab it opened.
- `on: "auto"` (the task default) asks one decide predicate whether the goal needs the person's own login
  (`needsLogin` skips it). Such a goal runs in the person's Chrome when it is paired; otherwise the task stops with
  `needs_owner` / `connect your browser` and the pairing reason. It never falls back to the managed Chrome. Other goals
  go to the managed Chrome without touching the bridge.
- `browser.status` reports `user` as `paired` or, when it is not ready, one of these reasons:

  - `extension_missing`: the bridge is not in Marshal;
  - `no_socket`: the bridge is not listening;
  - `control_off`: the person switched control off;
  - `not_connected`: no Chrome attached;
  - `denied`: Marshal's policy refuses the bridge.

  `control_off` needs zyg-edge/marley-browser-extension#4; older Chrome extensions report `not_connected`.

- **Snapshot:** the same `eN` shape. The bridge's own refs become `node`. A field is secret when it is a password,
  the bridge masked its value, or the bridge flags it `secret` (#4 flags empty code fields too).
  - Secret fields are never typed into or clicked, even by a direct `browser.session.act`.
  - `select` is refused: the bridge reports no options yet.
- **Decisions are text-only** on this backend unless the `userVision` config is true (a per-call `vision` cannot turn
  it on). Pictures of the person's pages do not go to the model provider by default.
- **Screenshots:** marked screenshots are still made for the caller. The bridge's PNG is decoded, boxed and labelled in
  plain JS (zlib, bundled jpeg-js); nothing is drawn in the person's page. The bridge's file is removed after reading.
- **`screencast()`:** forwarded `Page.screencastFrame` frames when the bridge offers `browserbridge.screencast.*` (#4).
  Otherwise one polled screenshot per second.

## Configuration

`chromePath`, `profileRoot`, `headed`, `artifactDir`, `minConfidence`, `maxSteps`, `wallMs`, `vision`,
`keepStepShots`, `userVision` (see `runtime-extension.json`).

## Build and test

```bash
npm install
npm run build      # tsc --noEmit + esbuild -> dist/runtime.cjs
npx vitest run     # engine (fake decide), units, manifest/bundle allow-list, real Chrome (skipped without Chrome)
# the user backend over the real bridge in a throwaway Chrome for Testing (skipped without both):
MB_BRIDGE_REPO=<marley-browser-extension checkout> MB_CHROME_FOR_TESTING=<binary> npx vitest run tests/user.real.test.ts
```
