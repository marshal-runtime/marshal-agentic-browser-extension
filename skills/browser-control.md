# Browser Control Skills

> **Load this file when you need to interact with a web browser.**
> All commands are executed via terminal using the `agentic-browser` CLI.
> Every command returns JSON to stdout. Diagnostic messages go to stderr.

---

## Quick Start

Before using any browser commands, run setup **once** per session:

```bash
npx agentic-browser setup
```

This automatically:

- Finds Chrome or Edge on the user's machine
- Launches it with the user's existing profile (cookies, logins, extensions)
- Enables remote debugging on port 9222
- Saves the configuration

If the browser is already running with debugging enabled, it connects to it instead.

### Connect to Existing / Remote Browser

```bash
# Connect to a browser already running with debugging (local or remote)
npx agentic-browser connect --host 192.168.1.50 --port 9222
```

After `connect`, all subsequent commands target that browser — no `--host`/`--port` needed each time.

### Check Status

```bash
npx agentic-browser status
```

### Verify Profile & Auth

```bash
npx agentic-browser profile-info
```

Shows total cookies, domains with auth cookies, and detected logged-in services (Google, GitHub, Microsoft, etc.).

### Shutdown

```bash
npx agentic-browser shutdown
```

---

## Command Reference

### Navigation

| Command           | Description                               |
| ----------------- | ----------------------------------------- |
| `navigate <url>`  | Navigate to a URL and wait for load       |
| `go-back`         | Go back in history                        |
| `go-forward`      | Go forward in history                     |
| `reload [--hard]` | Reload the page (`--hard` bypasses cache) |

```bash
npx agentic-browser navigate "https://github.com"
npx agentic-browser go-back
npx agentic-browser reload --hard
```

### DOM Interaction

| Command                  | Description                      |
| ------------------------ | -------------------------------- |
| `click <selector>`       | Click an element by CSS selector |
| `type <selector> <text>` | Type text into an input/textarea |
| `select <selector>`      | Select a dropdown option         |
| `hover <selector>`       | Hover over an element            |
| `scroll [--x N] [--y N]` | Scroll the page or element       |

```bash
npx agentic-browser click "#submit-button"
npx agentic-browser type "#email" "user@example.com"
npx agentic-browser type "#password" "secret" --clear
npx agentic-browser select "#country" --value "US"
npx agentic-browser select "#country" --label "United States"
npx agentic-browser hover ".menu-trigger"
npx agentic-browser scroll --y 500
npx agentic-browser scroll --y 300 --selector ".scrollable-panel"
```

### Content Extraction

| Command                 | Description                     |
| ----------------------- | ------------------------------- |
| `screenshot`            | Capture a screenshot            |
| `html [--selector sel]` | Get page or element HTML        |
| `accessibility-tree`    | Get the page accessibility tree |
| `extract-data <type>`   | Extract structured data         |
| `metadata`              | Get page metadata               |

```bash
# Save screenshot to file
npx agentic-browser screenshot --output page.png

# Full page screenshot
npx agentic-browser screenshot --full-page --output full.png

# Screenshot of specific element
npx agentic-browser screenshot --selector ".hero" --output hero.png

# Get HTML of a specific element
npx agentic-browser html --selector "article.main"

# Get structured page data (headings, links, images, meta)
npx agentic-browser extract-data structured

# Get table data as JSON
npx agentic-browser extract-data table --selector "#results-table"

# Get page metadata (title, OG tags, etc.)
npx agentic-browser metadata
```

### Script Execution

| Command             | Description                          |
| ------------------- | ------------------------------------ |
| `execute <script>`  | Execute JavaScript and return result |
| `console <command>` | Run a console command                |

```bash
# Get the page title
npx agentic-browser execute "document.title"

# Count elements
npx agentic-browser execute "document.querySelectorAll('a').length"

# Complex script (use single quotes to wrap)
npx agentic-browser execute "Array.from(document.querySelectorAll('h2')).map(h => h.textContent)"
```

### Wait Operations

| Command                     | Description                         |
| --------------------------- | ----------------------------------- |
| `wait-for-selector <sel>`   | Wait for element to appear          |
| `wait-for-navigation`       | Wait for navigation to complete     |
| `wait-for-network-idle`     | Wait for network to settle          |
| `wait-for-condition <expr>` | Wait for JS expression to be truthy |

```bash
# Wait for element to be visible (default)
npx agentic-browser wait-for-selector ".results-loaded"

# Wait for element to disappear
npx agentic-browser wait-for-selector ".loading-spinner" --condition hidden

# Wait with custom timeout
npx agentic-browser wait-for-selector "#data" --timeout 60000

# Wait for a JS condition
npx agentic-browser wait-for-condition "window.appReady === true"
```

### Tab Management

| Command                    | Description        |
| -------------------------- | ------------------ |
| `list-tabs`                | List all open tabs |
| `create-tab [--url <url>]` | Open a new tab     |
| `switch-tab <target-id>`   | Switch to a tab    |
| `close-tab <target-id>`    | Close a tab        |

```bash
# List tabs to get target IDs
npx agentic-browser list-tabs

# Open a new tab
npx agentic-browser create-tab --url "https://docs.example.com"

# Switch to a specific tab (use id from list-tabs)
npx agentic-browser switch-tab "ABC123DEF456"

# Close a tab
npx agentic-browser close-tab "ABC123DEF456"
```

### Device Emulation

```bash
# Emulate iPhone 14
npx agentic-browser emulate-device --preset "iphone-14"

# Emulate iPad in landscape
npx agentic-browser emulate-device --preset "ipad-pro" --orientation landscape

# Custom dimensions
npx agentic-browser emulate-device --width 375 --height 812 --mobile

# Reset to desktop
npx agentic-browser reset-emulation
```

Available presets: `iphone-14`, `iphone-14-pro-max`, `pixel-7`, `ipad-pro`, `galaxy-s23`

### Dialog Handling

The `handle-dialog` command requires a `--trigger` expression — the JavaScript that
triggers the dialog. The trigger and dialog are handled within the same CDP session.

```bash
npx agentic-browser handle-dialog accept --trigger "alert('Hello')"
npx agentic-browser handle-dialog dismiss --trigger "confirm('Delete?')"
npx agentic-browser handle-dialog accept --trigger "prompt('Name?')" --prompt-text "Agent"
# Trigger via button click:
npx agentic-browser handle-dialog accept --trigger "document.querySelector('#myBtn').click()"
```

### File Operations

| Command                            | Description                         |
| ---------------------------------- | ----------------------------------- |
| `upload-file <selector> <file...>` | Set file(s) on a file input element |
| `download <url>`                   | Download a file to disk             |

```bash
# Upload a single file
npx agentic-browser upload-file "input[type=file]" "/path/to/document.pdf"

# Upload multiple files
npx agentic-browser upload-file "#file-input" "/path/to/photo1.jpg" "/path/to/photo2.jpg"

# Download a file (saves with filename from URL)
npx agentic-browser download "https://example.com/report.pdf"

# Download to a specific path
npx agentic-browser download "https://example.com/data.csv" --output ./downloads/data.csv

# Download with extended timeout (default 60s)
npx agentic-browser download "https://example.com/large-file.zip" --output file.zip --timeout 120000
```

**Note:** The download command uses the browser's `fetch()` API, so it respects the page's cookies and authentication. It works for same-origin and CORS-enabled URLs. For cross-origin downloads that require clicking a link, use `click` on the download link instead.

### Network Monitoring

| Command       | Description                                      |
| ------------- | ------------------------------------------------ |
| `network-log` | Capture network traffic for a specified duration |

```bash
# Capture network traffic for 5 seconds (default)
npx agentic-browser network-log

# Capture for 10 seconds
npx agentic-browser network-log --duration 10000

# Typical workflow: navigate then immediately capture API calls
npx agentic-browser navigate "https://example.com/dashboard"
npx agentic-browser network-log --duration 3000
```

Returns an array of network requests with URL, method, status, MIME type, and size.

### Cookie Management

| Command                    | Description                         |
| -------------------------- | ----------------------------------- |
| `get-cookies [--domain X]` | Get all cookies or filter by domain |
| `set-cookie`               | Set a cookie                        |
| `delete-cookie`            | Delete a cookie                     |

```bash
# Get all cookies
npx agentic-browser get-cookies

# Get cookies for a specific domain
npx agentic-browser get-cookies --domain ".github.com"

# Set a cookie
npx agentic-browser set-cookie --name "session" --value "abc123" --domain ".example.com"

# Set a cookie with all options
npx agentic-browser set-cookie --name "token" --value "xyz" --domain ".example.com" \
  --path "/" --secure --http-only --same-site "Lax" --expires 1735689600

# Delete a cookie
npx agentic-browser delete-cookie --name "session" --domain ".example.com"
```

### DOM Modification

| Command                               | Description                        |
| ------------------------------------- | ---------------------------------- |
| `inject-css <css>`                    | Inject a stylesheet into the page  |
| `modify-attribute <sel> <attr> [val]` | Set or remove an element attribute |
| `insert-html <sel> <html>`            | Insert HTML adjacent to an element |
| `remove-element <sel>`                | Remove an element from the DOM     |

```bash
# Inject CSS to hide an element
npx agentic-browser inject-css ".cookie-banner { display: none !important; }"

# Inject CSS to highlight elements
npx agentic-browser inject-css ".target { outline: 3px solid red; }"

# Set an attribute
npx agentic-browser modify-attribute "#myInput" "placeholder" "Enter your name"

# Remove an attribute (omit value)
npx agentic-browser modify-attribute "#myInput" "disabled"

# Add an element before the end of a container
npx agentic-browser insert-html "#container" "<p>New paragraph</p>"

# Add an element at a specific position
npx agentic-browser insert-html "#list" "<li>First item</li>" --position afterbegin

# Remove an element
npx agentic-browser remove-element ".annoying-popup"
```

Positions for `insert-html`: `beforebegin` (before element), `afterbegin` (first child), `beforeend` (last child, default), `afterend` (after element).

---

## How Remote Communication Works

### The Protocol

Browser control uses the **Chrome DevTools Protocol (CDP)**:

- **Discovery:** HTTP requests to `http://<host>:<port>/json` list open tabs
- **Control:** A WebSocket connection to each tab's `ws://<host>:<port>/devtools/page/<id>` sends commands (navigate, click, type, etc.) and receives events

### How the Port is Opened

By **default**, `setup` launches Chrome with `--remote-debugging-port=9222` bound to **localhost only** (`127.0.0.1`). Nothing is accessible from the network.

When `--expose` is used, Chrome binds to `0.0.0.0` (all interfaces), making the port reachable from other machines on the network.

### ⚠️ Security: CDP Has No Built-in Authentication

**CDP is an unauthenticated, unencrypted protocol.** Anyone who can reach the port gets:

- Full browser control (navigate, click, type, read any page)
- Access to all cookies and login sessions
- Ability to execute arbitrary JavaScript
- Access to saved passwords via the browser API

**Never expose the CDP port to the public internet.**

### Recommended: SSH Tunneling (Encrypted + Authenticated)

SSH tunneling is the secure way to do remote browser control. The CDP port stays on localhost; SSH encrypts and authenticates the connection.

```
┌────────────────────┐          SSH tunnel (encrypted)          ┌──────────────────┐
│  Agent Machine     │ ═══════════════════════════════════════> │  User's PC       │
│                    │                                          │                  │
│  CLI talks to      │     port 9222 forwarded over SSH         │  Chrome listening │
│  127.0.0.1:9222 ───┼──────────────────────────────────────────┼─> 127.0.0.1:9222 │
└────────────────────┘                                          └──────────────────┘
```

---

## Deployment Scenarios

### Scenario 1: Agent on Same Machine (Visible Browser)

The agent launches a browser the user can see and watch. Best for demos and supervised automation. **No network exposure — fully secure.**

```bash
# Launch visible browser with user's profile (localhost only)
npx agentic-browser setup

# Agent works — user watches tabs open, pages load, forms fill
npx agentic-browser navigate "https://github.com"
npx agentic-browser click "#login-button"
```

### Scenario 2: Agent on Same Machine (Headless)

No visible window. Best for background automation, scripts. **No network exposure.**

```bash
npx agentic-browser setup --headless
npx agentic-browser navigate "https://example.com"
npx agentic-browser screenshot --output result.png
```

### Scenario 3: Remote Agent → User's Browser (via SSH Tunnel) ✅ Recommended

The agent runs on a remote server but controls the user's local browser. Secure, encrypted, authenticated via SSH.

**Step 1 — On the user's PC:**

```bash
# Launch browser (localhost only, nothing exposed to network)
npx agentic-browser setup
```

**Step 2 — On the agent machine, open SSH tunnel:**

```bash
# Forward local port 9222 → user's PC port 9222 through SSH
ssh -L 9222:127.0.0.1:9222 user@users-pc.example.com

# Or as a background tunnel (no interactive shell):
ssh -fN -L 9222:127.0.0.1:9222 user@users-pc.example.com
```

On Windows (user's PC), use OpenSSH server (built into Windows 10+):

```powershell
# Enable OpenSSH server (one-time, as admin)
Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0
Start-Service sshd
Set-Service -Name sshd -StartupType Automatic
```

**Step 3 — Agent uses the tunnel (talks to localhost):**

```bash
# Connect via the tunnel — traffic goes through SSH
npx agentic-browser connect --host 127.0.0.1 --port 9222

# Now all commands work as if local
npx agentic-browser navigate "https://github.com"
npx agentic-browser profile-info
```

**Why this is secure:**

- CDP port never leaves localhost on either machine
- All traffic is encrypted by SSH
- SSH requires authentication (key or password)
- No firewall changes needed on the user's PC

### Scenario 4: Browser-Hosted Agent (User Watches in Real Time, via SSH Tunnel)

The agent and user share the same browser session. User has one tab with the AI interface; the agent creates and controls other tabs.

Same SSH tunnel setup as Scenario 3, then:

```bash
npx agentic-browser connect --host 127.0.0.1 --port 9222
npx agentic-browser create-tab --url "https://github.com"
npx agentic-browser list-tabs  # See all tabs including the user's
npx agentic-browser switch-tab <agent-tab-id>
# Agent works in its tab — user watches in real time
npx agentic-browser navigate "https://github.com/search?q=something"
npx agentic-browser screenshot --output result.png
```

### Scenario 5: Trusted Private Network (--expose)

⚠️ Only use on networks you fully trust (e.g., home lab, private VPN, air-gapped environment).

**On the user's PC:**

```bash
# Expose to network — prints security warning
npx agentic-browser setup --expose
```

**On the agent machine:**

```bash
npx agentic-browser connect --host 192.168.1.50 --port 9222
npx agentic-browser navigate "https://example.com"
```

### Scenario 6: Docker / CI (Headless Remote)

```bash
# Docker container (isolated network, no auth needed)
docker run -p 9222:9222 chromium/headless-shell \
  --remote-debugging-address=0.0.0.0 \
  --remote-debugging-port=9222

# Agent connects (localhost because Docker maps the port)
npx agentic-browser connect --host localhost --port 9222
npx agentic-browser navigate "https://example.com"
```

---

## Setup Options

```bash
# Use Edge instead of Chrome
npx agentic-browser setup --browser edge

# Use a different port
npx agentic-browser setup --port 9333

# Use a specific Chrome profile (e.g., "Profile 1", "Profile 2")
npx agentic-browser setup --profile "Profile 1"

# Launch headless (no visible window)
npx agentic-browser setup --headless

# ⚠️ Expose to network (ONLY on trusted private networks)
npx agentic-browser setup --expose

# Connect to an already-running browser (local or via SSH tunnel)
npx agentic-browser connect --host 127.0.0.1 --port 9222

# Connect to a remote browser on a trusted network
npx agentic-browser connect --host 192.168.1.50 --port 9222
```

### User Profiles & Authentication

The `setup` command automatically loads your Chrome/Edge profile, giving you:

- **Logged-in sessions** — No need to re-authenticate
- **Cookies** — All saved cookies are available
- **Extensions** — Your browser extensions stay active
- **Saved passwords** — Autofill works as normal
- **Bookmarks & history** — All accessible

**Verifying profile is loaded:**

```bash
npx agentic-browser profile-info
```

Returns:

```json
{
  "success": true,
  "totalCookies": 847,
  "uniqueDomains": 132,
  "topDomains": [{ "domain": ".github.com", "cookies": 15 }, ...],
  "domainsWithAuth": [".github.com", ".google.com", ".microsoft.com"],
  "loggedInServices": ["Google", "GitHub", "Microsoft"]
}
```

**Profile fallback behavior:**

1. **Primary browser** — Tries to load your Chrome/Edge profile directly
2. **Alternate browser** — If Chrome is locked (already running), tries Edge, or vice versa
3. **Temp profile + cookies** — Copies cookies/auth from your profile into a temp directory. You get logged-in sessions without locking the real profile

**If the user's profile is on a different machine** (e.g., agent runs remotely):

- Option A: User launches their own browser with `setup --expose` → Agent connects remotely via `connect --host`
- Option B: Sync the profile directory to the remote machine, then `setup --profile`

Profile locations (auto-detected):
| OS | Chrome | Edge |
|----|----|-----|
| Windows | `%LOCALAPPDATA%\Google\Chrome\User Data` | `%LOCALAPPDATA%\Microsoft\Edge\User Data` |
| macOS | `~/Library/Application Support/Google/Chrome` | `~/Library/Application Support/Microsoft Edge` |
| Linux | `~/.config/google-chrome` | `~/.config/microsoft-edge` |

---

## Common Workflows

### Login to a Website

```bash
npx agentic-browser navigate "https://example.com/login"
npx agentic-browser type "#email" "user@example.com"
npx agentic-browser type "#password" "password123"
npx agentic-browser click "button[type=submit]"
npx agentic-browser wait-for-navigation
```

### Scrape a Table

```bash
npx agentic-browser navigate "https://example.com/data"
npx agentic-browser wait-for-selector "table"
npx agentic-browser extract-data table --selector "#data-table"
```

### Fill a Multi-Step Form

```bash
npx agentic-browser navigate "https://example.com/form"
npx agentic-browser type "#name" "John Doe"
npx agentic-browser select "#country" --label "United States"
npx agentic-browser click "#next-step"
npx agentic-browser wait-for-selector "#step-2"
npx agentic-browser type "#address" "123 Main St"
npx agentic-browser click "#submit"
npx agentic-browser wait-for-navigation
npx agentic-browser screenshot --output confirmation.png
```

### Research Across Multiple Tabs

```bash
npx agentic-browser create-tab --url "https://docs.example.com"
npx agentic-browser create-tab --url "https://api.example.com"
npx agentic-browser list-tabs
# Switch between tabs using IDs from list-tabs
npx agentic-browser switch-tab "<id-from-list>"
npx agentic-browser html --selector "article"
```

### Mobile Responsive Testing

```bash
npx agentic-browser emulate-device --preset "iphone-14"
npx agentic-browser navigate "https://example.com"
npx agentic-browser screenshot --output mobile.png
npx agentic-browser reset-emulation
npx agentic-browser screenshot --output desktop.png
```

### Upload a File

```bash
npx agentic-browser navigate "https://example.com/upload"
npx agentic-browser wait-for-selector "input[type=file]"
npx agentic-browser upload-file "input[type=file]" "/path/to/document.pdf"
npx agentic-browser click "#submit-upload"
npx agentic-browser wait-for-navigation
```

### Download and Verify

```bash
npx agentic-browser navigate "https://example.com/reports"
npx agentic-browser download "https://example.com/reports/q4.pdf" --output report.pdf
# Verify the file was saved
npx agentic-browser execute "true"  # confirms browser is still responsive
```

### Monitor API Calls

```bash
npx agentic-browser navigate "https://app.example.com"
# Capture 5 seconds of network traffic to see what APIs the page calls
npx agentic-browser network-log --duration 5000
```

### Manage Authentication Cookies

```bash
# Check what auth cookies exist
npx agentic-browser get-cookies --domain ".example.com"

# Set an auth token
npx agentic-browser set-cookie --name "auth_token" --value "bearer_xyz" --domain ".example.com" --secure --http-only

# Clear cookies to log out
npx agentic-browser delete-cookie --name "session_id" --domain ".example.com"
```

### Clean Up Page for Scraping

```bash
# Remove distracting elements before extracting content
npx agentic-browser inject-css ".ads, .cookie-banner, .popup-overlay { display: none !important; }"
npx agentic-browser remove-element ".cookie-consent-modal"
npx agentic-browser remove-element "#newsletter-popup"
# Now extract clean content
npx agentic-browser html --selector "article.main-content"
```

### Check if an Element Exists

```bash
npx agentic-browser execute "!!document.querySelector('.error-message')"
```

### Get All Links on a Page

```bash
npx agentic-browser execute "Array.from(document.querySelectorAll('a')).map(a => ({text: a.textContent.trim(), href: a.href})).filter(a => a.href)"
```

---

## Output Format

All commands return JSON with a `success` field:

```json
// Success
{ "success": true, "url": "https://example.com", "title": "Example" }

// Error
{ "success": false, "error": "Element not found: #nonexistent" }
```

Check `success` to determine if the command worked. If `false`, read the `error` field for details.

---

## Error Recovery

| Error                                    | Solution                                                                                               |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| "No browser on port 9222"                | Run `npx agentic-browser setup` first                                                                  |
| "Cannot connect to browser at host:port" | Check host/port, ensure browser has `--remote-debugging-port` and `--remote-debugging-address=0.0.0.0` |
| "Element not found"                      | Use `wait-for-selector` before interacting with dynamic content                                        |
| "WebSocket closed"                       | The browser tab was closed; run `list-tabs` and `switch-tab`                                           |
| "Target has no WebSocket URL"            | Another DevTools client is attached; close other DevTools windows                                      |
| "Browser did not start"                  | Close existing browser instances using the same profile, then retry                                    |
| "Timed out"                              | Increase `--timeout` or use `wait-for-network-idle` after navigation                                   |

---

## Global Options

These flags work with any command:

| Flag               | Description                  | Default     |
| ------------------ | ---------------------------- | ----------- |
| `--port <number>`  | CDP debugging port           | `9222`      |
| `--host <address>` | CDP host for remote browsers | `127.0.0.1` |
| `--help`           | Show help                    | —           |

Setup-only flags:

| Flag                       | Description                                         |
| -------------------------- | --------------------------------------------------- |
| `--browser <chrome\|edge>` | Preferred browser                                   |
| `--headless`               | Launch without visible window                       |
| `--expose`                 | Bind to `0.0.0.0` so remote agents can connect      |
| `--profile <name>`         | Chrome/Edge profile directory (e.g., `"Profile 1"`) |
