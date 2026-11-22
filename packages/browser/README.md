# @marshal/browser

One browser for every Marshal agent: a runtime extension that drives a real Chrome and answers a goal with data, text
or a screenshot. This is the first slice of the unified design. It has the `managed` backend (Chrome it starts itself),
the person's own Chrome (`user`, through the browser bridge) and native macOS apps (`app`, through Accessibility); the
live view and recording are seams, not code yet.

## Capabilities

| Capability                                                         | What it does                                                                                                                                                                                      |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `browser.status`                                                   | Backends and whether each is ready, the decide service, open sessions                                                                                                                             |
| `browser.task`                                                     | `{goal, on?, profile?, startUrl?, values?, want: {data?, text?, screenshot?}, bounds?: {maxSteps?, wallMs?}, allowedSites?, vision?, sessionId?, keepOpen?}` runs the step engine to a typed stop |
| `browser.ask`                                                      | `{url \| sessionId, questions}` answers named questions about one page in one decide call                                                                                                         |
| `browser.session.open / snapshot / act / screenshot / close`       | Direct control: open a tab, read `eN` refs, act on a ref, take a (marked) screenshot                                                                                                              |
| `browser.session.wait / read / evaluate / log / dialog / viewport` | Step-by-step driving: wait for text or an address, read text or HTML, run a script, console and network log, answer a dialog, set the device size (see below)                                     |

### Step-by-step operations

`browser.session.act` kinds: `click`, `submit`, `hover`, `type`, `select`, `scroll`, `navigate`, `back`, `forward`,
`reload`, `wait`, `press` (named keys only: Enter, Tab, Escape, Backspace, Delete, Space, arrows, Home/End, PageUp/Down,
with Alt/Control/Meta/Shift; text goes through `type`) and `upload` (absolute paths of regular files, at most 10 of
100 MB each; `ref` is the button that opens the file chooser, which is intercepted, or none for the page's only file
input). A kind or operation a backend cannot do answers `status: "unsupported_on_backend"`, never a substitute.

| Operation                                                                          | managed                                                                                                        | user (person's Chrome)                                                              | app         |
| ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ----------- |
| `press`                                                                            | yes; Backspace/Delete/Space refused while a secret field has focus                                             | yes (`browserbridge.key`); those keys refused while the page shows any secret field | unsupported |
| `hover`, `upload`                                                                  | yes                                                                                                            | unsupported                                                                         | unsupported |
| `forward`, `reload`                                                                | yes                                                                                                            | yes (`tabs.navigate`)                                                               | unsupported |
| `wait {text, textGone, urlIncludes, timeoutMs}`                                    | yes                                                                                                            | yes                                                                                 | yes         |
| `read {format: text}` / `{format: html}`                                           | both                                                                                                           | text only                                                                           | text only   |
| `evaluate {expression, timeoutMs}`                                                 | yes, own high-risk permission, result at most 500,000 characters                                               | never                                                                               | never       |
| `log {kinds, clear}`                                                               | console and network, observe only, no headers, bodies or cookies; off until `open {observe}` or the first call | unsupported                                                                         | unsupported |
| `dialog {accept?, promptText?}`                                                    | yes; an action that opens one returns it, page reads refuse until answered                                     | unsupported                                                                         | unsupported |
| `viewport {width, height, deviceScaleFactor?, mobile?, touch?}`, `open {viewport}` | yes                                                                                                            | never resized                                                                       | unsupported |
| `screenshot {format, quality, clip, fullPage}`                                     | all; full page or clip up to 30,000 CSS px high                                                                | format and quality; no clip                                                         | PNG         |

`browser.task` stops with one of `done`, `needs_input`, `needs_owner`, `blocked`, `low_confidence`, `budget` or
`decisions_unavailable`, with the trace (`{step, action, rung, ms, actMs, url, confidence, checks, note}`), stats and
screenshot artifacts.

## Background tasks, live view and recording

Built and tested on the managed backend. A user-backend tab has the same `screencast` (from the user backend), so watch
and record run there too, but that path is not exercised by these tests.

- `browser.task` with `wait: false` returns `{taskId, status: "running"}` at once. `browser.task.get` reports its state,
  phase and newest trace step (and the full result once finished), `browser.task.list` lists running and recent tasks
  (kept 30 minutes), `browser.task.cancel` stops it before its next action (an in-flight decision is abandoned, an
  action already sent runs to its end), closes the tab it opened (even with `keepOpen`) and ends it as `cancelled`.
- `browser.watch({taskId | sessionId})` opens the extension's `watch` application in the side panel: the page live
  (the tab's `Page.startScreencast`, running only while the panel polls `browser.watch.frame`), the step the engine is
  on (action, rung, ms) and a Stop button that calls `browser.task.cancel`. `open: false` returns the
  `ui.application.open` input instead; `browser.watch.close` ends a watch.
- The panel reads like a browser: an address bar (title, URL with the host emphasized, a live dot that blips on each
  new frame), the picture fitted to both sides of the panel and centered (the panel never scrolls), and a status line
  that ticks each second ("Live · page idle, last change 12 s ago", the task's step, "Session closed"). Each poll of
  `browser.watch.frame` carries the picture's size in device pixels (`view`), and the screencast is asked for exactly
  that size (at most 1920×1200; quality 80, lowered in steps of 10 down to 50 while a frame is over 400 KB), so the
  browser downsamples once and the panel draws 1:1. Only the frames are resized; the page's own viewport never changes.
  Chrome never upscales a screencast, so a panel larger than the page (a wide dock on a Retina screen) shows the page's
  own pixels scaled up. The poll answer also carries `url`, `title`, `lastFrameAt`, `frameBytes`, `quality`,
  `interactive` and `viewOnly`.
- `browser.watch.input({watchId, event})` is how the person uses the page from the panel: `click` and `wheel` (points
  as fractions `nx`, `ny` of the frame, mapped to the page's CSS pixels by the extension), `key` (the same named keys
  as `press`), `text` (1 to 64 printable characters; pasted text is sent in such pieces) and `back` / `forward` /
  `reload`. Only for a session on the managed backend that no task drives: a task's watch, a session a task is running
  in, the person's own Chrome (`user`) and an app (`app`) are view only (`status: "view_only"`, and the panel says
  why); text and editing keys are refused while a password, one-time-code or card field has focus
  (`status: "secret_field"`); more than 20 inputs a second are refused (`rate_limited`). The typed text is never logged
  or returned by the extension. Called from the panel, the host allows it as the application's declared action; an
  agent calling it directly gets the usual approval (risk medium, like `browser.session.act`).
- `want.video` on `browser.task`, or `browser.session.record.start / stop`, records the tab to an H.264 MP4 (at most
  10 fps, 15 minutes) with an ffmpeg found through `ffmpegPath`, `MARSHAL_BROWSER_FFMPEG`, the system's, or the one
  @marshal/hyperframes pins. Without one the call returns status `recorder_unavailable` before anything runs; a video
  is never silently missing. `browser.status` reports `recorder`.

## How a step works

1. **Rung 0 (code):** open `startUrl`, snapshot the page (elements get refs `e1..eN`), build the offered actions, take
   a JPEG with a numbered box on each offered element.
2. **Rung 1 (one decide call):** `marshal.models.decide` gets the page, the history, the value _names_ and the marked
   screenshot, and answers four questions at once: `next_action` (a choice over the offers), `goal_met`, `needs_owner`
   and `page_ready` (yes/no predicates). Wherever the page text, a label or the goal shows one of the caller's values
   (3 characters or more), the model reads `⟨value <name>⟩` instead; extracted data gets the value back. The
   screenshot still shows the page as it is.
3. **Gates in code:**
   - A page action below `minConfidence` (0.15), or `need_value` / `blocked` below 0.4, is re-decided once on a fresh
     snapshot; the retry acts only when it picks one of the first decision's two most likely page actions. `done` is
     taken when `goal_met` agrees (0.75, or 0.4 when the model itself picked `done`), or when it is picked twice at
     0.75 or more. A high `goal_met` alone ends the task only when the pick is `done`, `wait` or below the gate.
     A missing `next_action` is asked once more.
   - The task's home site is `startUrl`'s (or the first page's). Typing, choosing, sending a form and returning data
     happen only there (subdomains and `allowedSites` count); otherwise `needs_owner` / `left_site`. A public task
     that the page moves to a loopback, private, link-local or metadata address stops with `private_address`.
   - A form is checked by where it sends (the snapshot reports each control's `formAction`) before Enter in one of
     its fields or a click on its submit button: another site, or an OAuth / checkout / payment / install path, stops
     with `form_leaves_site`. The user backend cannot see form targets, so there a submit stops with
     `form_target_unknown` once a caller value is on the page.
   - A link that leaves the site, uses a non-page scheme (`mailto:`, `tel:`, an app link), or whose host or path is an
     OAuth, consent, checkout, payment, billing or install step, stops with `needs_owner`.
   - A secret field is never offered, and no backend types into one, `browser.session.act` included; typed text comes
     only from `values`; the same action on an unchanged page three times, three failed actions, the step bound and
     the wall clock all stop.
   - `browser.task` and `browser.ask` check the decide capability before they open anything.
4. **Rung 2:** when the goal is met and `want.data` is a JSON schema, one decide call with that schema (and the
   screenshot) extracts the data.

Fewer and overlapping calls (`src/engine/plan.ts`, `values.ts`, `speculate.ts`, `triage.ts`):

- **Plans.** The same decide request also asks, for each element action X, "if the history now ended with X, which
  action comes right after it?" (`after_N`; on a page with more than 30 element actions only after its fields). Code
  chains the answers from `next_action` and takes the chained actions without a decision each, stopping at `look`, an
  answer below 0.6, an action it already has, or when the model says the rest may need the person
  (`plan_needs_owner`). Before every planned action it takes a fresh snapshot and re-decides instead when the address,
  the element structure or the planned element changed, or the fresh page no longer offers the action; each planned
  action runs through exactly the guards above, and a cancel stops a plan between its actions. `planLength` (1-6,
  default 6; 1 turns plans off).
- **Values read in code.** For a flat `want.data` schema (at most 6 string or number fields) the page text is sent with
  numbered lines and the request asks which line holds each field (`value_N`); when the decision confirms the goal,
  code reads the fields from those lines and no extract is made. A field that is unsure, missing or not a number by
  its grammar falls back to the extract. `valuePointers` (default true).
- **Extract beside the decision.** When this look is likely the last one (the goal triage says the start page answers
  the goal, or the previous plan expected the goal met), the extract starts beside the decision on an unmarked capture
  and is used only if the decision confirms the goal on that same page. An unused one is counted in
  `stats.unusedCalls`. `speculativeExtract` (default true).
- **Parallel awaits.** `on: "auto"` starts the managed Chrome process while the routing question is asked (no tab before
  the route is known); that routing question and the start-page triage are one request; `browser.ask` reads the
  snapshot, screenshot and text together; step screenshots are saved beside the decision. Two actions never run at once.
- `stats.modelCalls` counts every model request of the task, the unused ones included; `stats.plannedActions` the
  actions taken from a plan.

Models are reached only through the host's `marshal.models.decide` (marshal-sdk, or Marshal desktop when it offers
it): the extension holds no provider URL, key or model name, and has no Jev dependency.

## The managed backend

Chrome is driven over `--remote-debugging-pipe`, so no debugging port is opened, and nothing attaches to the person's
Chrome. At most two processes start, on first use:

- `agent`: a lasting profile (`~/.marshal/browser/profiles/agent`, or `profileRoot`), so logins persist. Headless
  unless `headed` is set or, on Linux, a `DISPLAY` exists. The folder is 0700. On macOS its cookies are encrypted with
  the login keychain ("Chrome Safe Storage"), not the mock keychain's fixed key; logins saved by an earlier version
  (mock key) cannot be read after this change, so the agent signs in again once. Linux keeps the basic store.
- `visitor` (the default) and `offline`: one throwaway, headless process. Each session gets its own fresh browser
  context (no cookies, no storage). `visitor` never intercepts a request (no Fetch domain, zygstinct rule SB21).
  `offline` sends every request, loopback included, to a dead proxy, so only `data:` and pages already in memory
  render. Its profile sets `webrtc.ip_handling_policy` to `disable_non_proxied_udp`, so a page cannot reach a STUN
  server from `offline` or learn the machine's public address from `visitor`; component updates and background
  networking are off. The temporary folder is removed on close, on process exit, and by the next start when a host
  died before either.

## The user backend

The person's own signed-in Chrome, behind the same `Target` (`src/user/`). This package carries both halves, so
installing `@marshal/browser` alone is enough (no `@zygstinct/browser-bridge`):

- **The Chrome extension:** `chrome-extension/` of zyg-edge/marley-browser-extension at a pinned commit of `main`
  (developer channel: `SITE_INSTALL = false`, no `update_url`), vendored unchanged in `vendor/chrome-extension` with
  per-file sha256 and a tree hash in `vendor/chrome-extension.lock.json`, and copied by the build to
  `dist/chrome-extension` (no links; the build checks it against the lock). It runs no model; it only exposes browser
  controls. Re-pin with
  `node scripts/sync-chrome-extension.mjs --repo <checkout> --commit <sha on main>` (an unmerged branch is refused);
  `--check [--dir <folder>]` verifies a folder.
- **A stable folder for it:** Marshal installs each version of an extension in a new folder, so at activation the
  carried files are copied (checked against the lock, unchanged files not rewritten, links refused) to
  `chromeExtensionDir` (default `~/.marshal/browser/chrome-extension`). That folder is the one setup names for
  Load unpacked; a new pin replaces it in one rename, and Chrome picks it up on its next start or Reload.
- **The bridge socket** (`src/user/local-bridge.ts`, ported from that repo's `marshal-extension`): `ws://127.0.0.1:17373/bridge`
  (`bridgePort` to change it), loopback only, only the carried extension's own origin
  (`chrome-extension://<id>`, the id fixed by its manifest `key` and recorded in the lock; another installed extension is
  refused), masked client frames only (RFC 6455; an unmasked frame closes with 1002), the newest browser wins, a browser
  silent for 65 s is dropped. It offers the user backend the `browserbridge.*` verbs it uses and no `evaluate`;
  `tabs.open`/`tabs.navigate` take only http(s) (or back/forward/reload). Screenshots go to private 0600 files.
  `/health` answers `{"service":"marshal-browser"}`.
- **When the port is taken** (by the old `@zygstinct/browser-bridge`, another Marshal with this package, or anything
  else), nothing is routed through the holder: `browser.status` says `port_in_use`, names the holder (from its
  `/health`) and gives the steps for it, and the bridge binds again on the next status once the port is free.

- `on: "user"` on `browser.session.open`, `browser.ask` and `browser.task` opens a **background** tab
  (`active: false`) in the bridge's "Marley" tab group, at the given url. It never adopts a tab the person already has,
  never focuses Chrome, and closes only the tab it opened.
- `on: "auto"` (the task default) asks one decide predicate whether the goal needs the person's own login
  (`needsLogin` skips it). Such a goal runs in the person's Chrome when it is paired; otherwise the task stops with
  `needs_owner` / `connect your browser` and the pairing reason. It never falls back to the managed Chrome. Other goals
  go to the managed Chrome without touching the bridge.
- `browser.status` reports `user` as `paired` or, when it is not ready, one of these reasons:

  - `port_in_use`: another program holds the bridge port (see above);
  - `no_socket`: the bridge could not listen;
  - `control_off`: the person switched control off;
  - `not_connected`: no Chrome attached;
  - `error`: the bridge did not answer its status.

  `control_off` needs zyg-edge/marley-browser-extension#4; the carried main build reports `not_connected`.

  When it is not ready, the status, a refused `on: "user"` session or `browser.ask` (`status: "needs_owner"`,
  `reason: "user_browser_not_paired"`) and a task stopped with `connect your browser` carry `setup`: the reason, a
  summary and the steps for that reason. For `not_connected`: in Chrome, chrome://extensions, Developer mode, Load
  unpacked with the absolute folder in `setup.chromeExtension.folder` (remove a Marley extension from the Marley website
  first: same extension id), then enter `setup.chromeExtension.bridgeAddress` in the popup's "Developer: Marshal
  bridge" and keep "Let Marley use this browser" on. `setup.otherInstalls` and `setup.websiteInstall` say that the
  website download and a Chrome Web Store copy pair only with Marley's cloud relay and never connect Marshal. There is
  no Chrome Web Store listing (`storeListing: null`).

- **Snapshot:** the same `eN` shape. The bridge's own refs become `node`. A field is secret when it is a password,
  the bridge masked its value, or the bridge flags it `secret`. The carried main build masks only a field that holds
  a value, so an empty one-time-code field is not seen as secret until #4 (which flags it) is merged and re-pinned.
  - Secret fields are never typed into or clicked, even by a direct `browser.session.act`.
  - `select` is refused: the bridge reports no options yet.
- **Decisions are text-only** on this backend unless the `userVision` config is true (a per-call `vision` cannot turn
  it on). Pictures of the person's pages do not go to the model provider by default.
- **Screenshots:** marked screenshots are still made for the caller. The bridge's PNG is decoded, boxed and labelled in
  plain JS (zlib, bundled jpeg-js); nothing is drawn in the person's page. The bridge's file is removed after reading.
- **`screencast()`:** one polled screenshot per second. Forwarded frames need #4 and the bridge verbs for them.
- **Forms:** the carried build reports no form targets, so `browser.task` stops with `needs_owner` /
  `form_target_unknown` before submitting a form that holds a supplied value.

## The app backend (macOS)

`on: "app"` with `app` (a bundle id such as `com.apple.calculator`, or an app name) runs the same step engine on one app
window. The Swift helper `native/ax-helper` (a long-lived JSON Lines process, staged into `dist/native` by the build)
reads the window's Accessibility tree into the same `eN` snapshot and draws the marked window screenshot itself (the
bundle loads no image library); every decision carries it, as on the managed backend.

- An app that is not running is opened in the background (never activated) and quit when the task or session ends; an
  app that was already running is driven but never quit. `launch: false` stops with `app_not_running` instead.
- Actions are Accessibility only: AXPress (or selection), setting a field's value, AXConfirm for `submit`, paging the
  scroll bar. None moves the pointer or brings the app to the front, and menus (which open on screen) are not read. A
  step that only real keyboard/mouse input could do stops with `needs_input` / `real_input_required`, unless the caller
  sets `allowRealInput: true`; then it may activate the app and click or type for real, and the trace says so.
- Password fields (AXSecureTextField) are never offered and their value is never read. Typed text comes only from
  `values`.
- A control stops with `needs_owner` on a typed Accessibility signal, never on its label: window controls
  (close/minimize/zoom/full screen subroles), the default button of a sheet or dialog, and Enter in a field of such a
  sheet. Accessibility has no standard "destructive" attribute, so sending, deleting or paying through an ordinary
  button is the model's `ask_owner` / `needs_owner` answer.
- `browser.status` reports Accessibility and Screen Recording (each with the reason and the System Settings link when
  missing), whether the screen is locked (macOS then shows Accessibility clients no windows) and the running apps.
- With few labelled controls (Electron, canvas apps), the OCR helper `native/ocr-helper` adds the window's text; its
  lines become click targets only with `allowRealInput`, since a point with no element behind it needs a real click.

## Permissions

Each capability asks `marshal.tool.invoke:<name>`. `browser.session.evaluate` is high (any script in a managed page,
including the `agent` profile's sites). `browser.task`, `browser.ask` and `browser.session.open` are medium;
their reason says the risk is high with `profile: "agent"` (the agent's lasting logins) or `on: "user"` (the person's
own Chrome). Marshal's permission is per capability, so the input does not change the prompt's level.

## Configuration

`chromePath`, `profileRoot`, `headed`, `artifactDir`, `minConfidence`, `maxSteps`, `wallMs`, `vision`,
`keepStepShots`, `planLength`, `valuePointers`, `speculativeExtract`, `userVision`, `axHelperPath`, `ocrHelperPath`, `ffmpegPath`,
`bridgePort`, `chromeExtensionDir` (see `runtime-extension.json`).
Without `chromePath`, Chrome comes from `MARSHAL_BROWSER_CHROME`, then `MARSHAL_SDK_CHROME` (the Chrome a marshal-sdk host
found), then the usual install paths. On Linux, Chrome gets `--disable-dev-shm-usage` (containers give /dev/shm 64 MB),
and `--no-sandbox` only when the process runs as root (Chrome refuses to start as root otherwise).

## Build and test

```bash
npm install
npm run build      # tsc --noEmit + esbuild -> dist/runtime.cjs; on macOS also swift build + stage both helpers
                   # (run it first: the bundle, dist/chrome-extension and org-archive tests check the build output)
npx vitest run     # engine (fake decide), app backend (fake helper process), units, manifest/bundle allow-list,
                   # real Chrome (skipped without Chrome), lifecycle/screencast/watch/recorder units, and a real
                   # Chrome + ffmpeg recording checked with ffprobe (skipped without ffmpeg)
node scripts/mutate-app-guards.mjs   # removes each app guard in turn; every removal must fail a test
node scripts/mutate-session-guards.mjs   # the same for the session operations, the Chrome setup, the carried bridge
                                         # and the carried Chrome extension (needs Chrome; --only <name prefix>)
# tests/user.real.test.ts: the carried extension in a throwaway Chrome for Testing profile and the carried bridge
# (MB_CHROME_FOR_TESTING, else Playwright's cached Chrome for Testing; skipped without one; never the person's Chrome)
# the same through a clean marshal-sdk host with only this package (stage it without links first):
node scripts/prove-user-carried.mjs --sdk <marshal-sdk dist/src/index.js> --package <copy> --out <dir> [--port-in-use 17373]
npm run pack:org -- --out <dir>   # the org catalog archive: browser-<version>.tgz (helpers 0755, no links), .sha256, index.json
```

Marshal's own extension packer writes every file 0644 and would strip `+x` from `dist/native/*`, so the org catalog
takes the archive `pack:org` builds (tests/pack-org.test.ts extracts it and runs the helpers). One archive per version:
bump `version` in both `package.json` and `runtime-extension.json` (the script refuses a mismatch).
