# @marshal/browser

One browser for every Marshal agent: a runtime extension that drives a real Chrome and answers a goal with data, text
or a screenshot. This is the first slice of the unified design. It has the `managed` backend (Chrome it starts itself),
the person's own Chrome (`user`, through the browser bridge) and native macOS apps (`app`, through Accessibility); the
live view and recording are seams, not code yet.

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

Each capability asks `marshal.tool.invoke:<name>`. `browser.task`, `browser.ask` and `browser.session.open` are medium;
their reason says the risk is high with `profile: "agent"` (the agent's lasting logins) or `on: "user"` (the person's
own Chrome). Marshal's permission is per capability, so the input does not change the prompt's level.

## Configuration

`chromePath`, `profileRoot`, `headed`, `artifactDir`, `minConfidence`, `maxSteps`, `wallMs`, `vision`,
`keepStepShots`, `userVision`, `axHelperPath`, `ocrHelperPath`, `ffmpegPath` (see `runtime-extension.json`).

## Build and test

```bash
npm install
npm run build      # tsc --noEmit + esbuild -> dist/runtime.cjs; on macOS also swift build + stage both helpers
npx vitest run     # engine (fake decide), app backend (fake helper process), units, manifest/bundle allow-list,
                   # real Chrome (skipped without Chrome), lifecycle/screencast/watch/recorder units, and a real
                   # Chrome + ffmpeg recording checked with ffprobe (skipped without ffmpeg)
node scripts/mutate-app-guards.mjs   # removes each app guard in turn; every removal must fail a test
# the user backend over the real bridge in a throwaway Chrome for Testing (skipped without both):
MB_BRIDGE_REPO=<marley-browser-extension checkout> MB_CHROME_FOR_TESTING=<binary> npx vitest run tests/user.real.test.ts
```
