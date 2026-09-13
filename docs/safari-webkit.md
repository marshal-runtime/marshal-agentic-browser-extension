# Safari / WebKit engine

`agentic-browser setup --browser webkit` (alias: `--browser safari`) runs pages on
**Playwright WebKit** — the same browser engine Safari uses.

## What it is (and is not)

- **It IS** a real WebKit engine: WebKit-specific rendering, JS behavior, and
  `AppleWebKit … Safari` user agent. Use it to test how a site behaves on Safari.
- **It is NOT** your installed Safari.app. It launches Playwright's WebKit build
  with a **fresh, ephemeral profile**: no Safari cookies, logins, extensions, or
  keychain access. `profile-info` reports the profile as ephemeral.

## Architecture

The CDP engine works because Chrome outlives each CLI invocation and any process
can re-attach over the DevTools port. Playwright has no equivalent re-attach
model (a client's browser contexts die with its connection), so the webkit
engine runs a small daemon:

```
agentic-browser <cmd>  ──HTTP JSON (127.0.0.1:<port>)──▶  webkit-daemon
                                                            └─ owns one Playwright
                                                               WebKit browser+context
```

- `setup --browser webkit` spawns `packages/cli/dist/webkit-daemon.js` (detached,
  log at `~/.agentic-browser/webkit-daemon.log`) and waits for readiness.
- Every other command POSTs `{command, values, positionals, cwd}` to
  `127.0.0.1:<port>/command`; the daemon executes it with Playwright APIs and
  returns the same JSON shapes as the CDP engine.
- The daemon binds to 127.0.0.1 **only** and has no auth — same local trust
  model as CDP, which is why `--expose` and `--host` are rejected on webkit.
- Engine routing is saved in `~/.agentic-browser/config.json` (`engine` field);
  the last `setup` wins. `AGENTIC_BROWSER_CONFIG_DIR` overrides the state dir
  (used by tests to avoid touching real user state).

## Per-command support matrix (webkit engine)

| Support                        | Commands                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ✅ Full                        | `setup`, `status`, `shutdown`, `navigate`, `go-back`, `go-forward`, `click`, `type` (incl. `--text`), `select`, `hover`, `scroll`, `keyboard`, `drag`, `screenshot` (incl. `--full-page`, `--selector`, jpeg/quality), `html`, `accessibility-tree`, `extract-data`, `metadata`, `execute`, `console`, `wait-for-selector`, `wait-for-navigation`, `wait-for-network-idle`, `wait-for-condition`, `list-tabs`, `create-tab`, `switch-tab`, `close-tab`, `handle-dialog`, `upload-file`, `download`, `network-log`, `get-cookies`, `set-cookie`, `delete-cookie`, `inject-css`, `modify-attribute`, `insert-html`, `remove-element`, `reset-emulation` |
| ⚠️ Partial                     | `reload` — works, but `--hard` (cache bypass) is unavailable; performs a normal reload and says so in the result. `emulate-device` — viewport size/orientation only; user-agent, deviceScaleFactor, and touch emulation require context creation in Playwright and return a clear error/note instead of silently doing nothing. `profile-info` — works but always reports the ephemeral profile (no logged-in services by definition).                                                                                                                                                                                                                |
| ❌ Rejected with a clear error | `connect` (remote CDP attach), `list-targets` (raw CDP targets), the global `--target` flag on any command (CDP target IDs; iframes/workers are CDP-only), `--expose`, `--host`, `--profile`, `emulate-device --user-agent`                                                                                                                                                                                                                                                                                                                                                                                                                           |

Tab IDs on webkit are `wk1`, `wk2`, … (prefix matching supported by
`switch-tab`/`close-tab`) rather than CDP target hex IDs.

## Requirements

- The Playwright WebKit build (~80 MB). `setup --browser webkit` auto-installs
  it on first use (`npx playwright install webkit`).
- `playwright` is a dependency of `@agentic-browser/cli`. It is imported lazily,
  so chrome/edge (CDP) users pay no startup cost.

## Why real-Safari automation (safaridriver) is a non-goal

macOS ships `safaridriver` (W3C WebDriver for Safari.app). We assessed it and
decided **not** to implement it:

1. **It doesn't deliver the thing you'd want it for.** Safari runs WebDriver
   sessions in isolated "Automation Windows" with a clean, ephemeral browsing
   session — your real Safari cookies/logins are NOT available. So versus
   Playwright WebKit it adds no profile access, only constraints.
2. **Strictly weaker command surface.** WebDriver has no equivalents for a large
   part of this CLI: network capture (`network-log`), cursor-position typing
   (`type --text`), dialog trigger+handle in one shot, CSS/UA overrides, device
   metrics, `wait-for-network-idle`, or download-with-cookies. The support
   matrix would be mostly ❌.
3. **Operationally fragile.** One session at a time system-wide, requires
   `safaridriver --enable` + "Allow Remote Automation" in Safari's Develop menu,
   and the session locks if the user interacts with the automation window.
4. **Architecture distortion.** It would be a third protocol backend (CDP,
   Playwright, WebDriver) for a worse result.

If a future need is specifically "drive the user's logged-in Safari", that's a
different product decision (and Apple intentionally restricts it); revisit then.
