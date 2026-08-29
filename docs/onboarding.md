# Onboarding Guide

Welcome to **Agentic Browser** — a Manifest V3 browser extension that exposes browser control as [MCP](https://modelcontextprotocol.io/) tools for AI agents. It runs inside your existing browser, inheriting your authenticated sessions, cookies, and extensions. A companion MCP server bridges AI agents to the extension via Native Messaging.

## Table of Contents

- [Architecture Overview](#architecture-overview)
- [Quick Start](#quick-start)
- [Connecting an AI Agent](#connecting-an-ai-agent)
- [Using with Chrome (Local)](#using-with-chrome-local)
- [Using with Edge (Local)](#using-with-edge-local)
- [Using with a Remote/Headless Browser](#using-with-a-remoteheadless-browser)
- [Mobile Device Emulation](#mobile-device-emulation)
- [Tool Reference](#tool-reference)
- [Common Workflows](#common-workflows)
- [Configuration Reference](#configuration-reference)
- [Troubleshooting](#troubleshooting)

---

## Architecture Overview

```
AI Agent ──(stdio)──▶ MCP Server ──(Native Messaging)──▶ Extension Service Worker
                                                              │
                                                     Command Router
                                                              │
                                                      Tool Handlers
                                                              │
                                                    IBrowserAdapter
                                                    ┌────┬────┬───────┐
                                                 Chrome  Edge  Remote
```

| Component      | Location               | Role                                                                                |
| -------------- | ---------------------- | ----------------------------------------------------------------------------------- |
| **Extension**  | `packages/extension/`  | MV3 extension with service worker, content scripts, and browser adapters            |
| **MCP Server** | `packages/mcp-server/` | Node.js process that speaks MCP over stdio and relays commands via Native Messaging |
| **Shared**     | `packages/shared/`     | TypeScript types, Zod schemas, constants shared between packages                    |

The extension supports three browser backends:

| Backend              | Detection                            | Transport                 | Use Case                               |
| -------------------- | ------------------------------------ | ------------------------- | -------------------------------------- |
| **Chrome** (default) | Auto-detected                        | `chrome.debugger` (CDP)   | Local desktop browsing                 |
| **Edge**             | Auto-detected from `Edg/` user-agent | `chrome.debugger` (CDP)   | Local desktop browsing on Edge         |
| **Remote**           | Manual connection                    | WebSocket to CDP endpoint | Headless browsers, CI, cloud instances |

---

## Quick Start

### Prerequisites

| Tool           | Version       | Check            |
| -------------- | ------------- | ---------------- |
| Node.js        | 22+ (LTS)     | `node --version` |
| npm            | 10+           | `npm --version`  |
| Git            | 2+            | `git --version`  |
| Chrome or Edge | Latest stable | —                |

Install Node.js 22 via [nvm](https://github.com/nvm-sh/nvm) or [nvm-windows](https://github.com/coreybutler/nvm-windows):

```bash
nvm install 22
nvm use 22
```

### 1. Clone and Install

```bash
git clone <repository-url>
cd agentic-browser
npm install
```

### 2. Build

```bash
npm run build
```

This builds all three packages (`shared` → `extension` → `mcp-server`).

### 3. Load the Extension

1. Open `chrome://extensions` (or `edge://extensions` for Edge)
2. Enable **Developer mode** (toggle in top-right)
3. Click **Load unpacked**
4. Select the `packages/extension/build` directory
5. Copy the **Extension ID** shown on the card (you'll need it next)

### 4. Set Up Native Messaging

Run the setup script with your extension ID:

```bash
npx tsx scripts/setup-native-messaging.ts --extension-id <your-extension-id>
```

This script:

- Creates a batch wrapper that launches the MCP server via Node.js
- Writes a Native Messaging host manifest (`com.agentic_browser.mcp_host.json`)
- Registers the host in the Windows registry for both Chrome and Edge

### 5. Verify

Open the extension popup from the browser toolbar. If the connection status shows connected, you're ready to go.

---

## Connecting an AI Agent

Agentic Browser uses **stdio** transport. Any MCP-compatible client can connect by launching the MCP server as a subprocess.

### MCP Client Configuration

Add to your MCP client's configuration (e.g., `claude_desktop_config.json`, Roo Code settings, etc.):

```json
{
  "mcpServers": {
    "agentic-browser": {
      "command": "node",
      "args": ["<absolute-path-to>/packages/mcp-server/dist/index.js"],
      "env": {
        "AGENTIC_BROWSER_LOG_LEVEL": "info"
      }
    }
  }
}
```

Replace `<absolute-path-to>` with the actual absolute path to your `agentic-browser` directory.

### Environment Variables

| Variable                       | Default                        | Description                                                |
| ------------------------------ | ------------------------------ | ---------------------------------------------------------- |
| `AGENTIC_BROWSER_LOG_LEVEL`    | `info`                         | Log level: `debug`, `info`, `warn`, `error`                |
| `AGENTIC_BROWSER_TIMEOUT`      | `30000`                        | Default tool timeout in milliseconds                       |
| `AGENTIC_BROWSER_EXTENSION_ID` | —                              | Extension ID override                                      |
| `AGENTIC_BROWSER_SERVER_NAME`  | `agentic-browser`              | Server name for MCP handshake                              |
| `AGENTIC_BROWSER_NM_HOST_PATH` | `com.agentic_browser.mcp_host` | Native Messaging host executable/identifier                |
| `AGENTIC_BROWSER_CONFIG`       | —                              | Path to a JSON config file (env vars override file values) |

### Verifying the Connection

Once your agent is connected, try calling:

```json
{ "tool": "browser_list_tools" }
```

This returns all available tools for the current backend, confirming the full chain (agent → MCP server → extension) is working.

---

## Using with Chrome (Local)

Chrome is the **default backend**. No additional configuration is needed.

### What You Get

- Full access to all 48 MCP tools
- Tab management (`browser_create_tab`, `browser_close_tab`, `browser_switch_tab`, `browser_list_tabs`)
- Storage access (cookies, localStorage, sessionStorage)
- File upload/download
- Bookmarks, history, and downloads APIs
- Device emulation for mobile testing
- Network interception

### How It Works

The Chrome adapter uses `chrome.debugger` to attach the Chrome DevTools Protocol (CDP) to browser tabs. This gives the extension programmatic control over navigation, DOM interaction, script execution, and more — all within your existing browser session.
For local CDP-backed tools, open the extension options and select **Enable browser debugging**.
This optional permission is requested only from that user gesture; denying it does not prevent the
extension or a configured remote backend from starting.

Marshal-scoped calls are stricter than direct MCP/CLI calls. They require **Allow in Incognito**
for the extension and run in an owned private window so cookies and web storage are separated from
the normal profile. Chrome and Edge expose only one incognito storage context to an extension, so
existing private windows must be closed and only one local Marshal browser session can be active.
Additional sessions fail explicitly instead of sharing that context.

### Typical Flow

1. Your AI agent sends a tool call (e.g., `browser_navigate`)
2. The MCP server receives it via stdio and relays it through Native Messaging
3. The extension's service worker routes the command to the appropriate tool handler
4. The tool handler uses the Chrome adapter (CDP) to execute the action
5. The result flows back through the same chain

---

## Using with Edge (Local)

Edge support is **automatic**. The extension detects Edge from the `Edg/` token in the user-agent string and uses the Edge adapter.

### Setup

The setup is identical to Chrome:

1. Open `edge://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked** → select `packages/extension/build`
4. Copy the Extension ID
5. Run native messaging setup (the script registers for both Chrome and Edge automatically)

### Capabilities

Edge has the **same capabilities as Chrome** — all 48 tools are available. The Edge adapter uses the same `chrome.debugger` CDP interface since Edge is Chromium-based.

### Switching Between Chrome and Edge

You can switch backends at runtime without restarting:

```json
{
  "tool": "browser_switch_backend",
  "arguments": { "backend": "edge" }
}
```

Or switch back:

```json
{
  "tool": "browser_switch_backend",
  "arguments": { "backend": "chrome" }
}
```

---

## Using with a Remote/Headless Browser

The remote backend connects to any browser exposing a Chrome DevTools Protocol (CDP) WebSocket endpoint. This is ideal for:

- **Headless Chrome** in CI/CD pipelines
- **Cloud browser instances** (e.g., Browserless, Browserbase)
- **Docker containers** running headless browsers
- **Testing environments** isolated from your desktop

### Launching a Headless Browser

Start Chrome with remote debugging enabled:

```bash
# Linux/macOS
google-chrome --headless --remote-debugging-port=9222

# Windows
"C:\Program Files\Google\Chrome\Application\chrome.exe" --headless --remote-debugging-port=9222

# Docker
docker run -p 9222:9222 chromium/headless-shell --remote-debugging-address=0.0.0.0 --remote-debugging-port=9222
```

### Connecting

Use the `browser_connect_remote` tool:

```json
{
  "tool": "browser_connect_remote",
  "arguments": {
    "wsUrl": "ws://localhost:9222",
    "timeout": 10000
  }
}
```

For authenticated endpoints (cloud services):

```json
{
  "tool": "browser_connect_remote",
  "arguments": {
    "wsUrl": "wss://cloud-browser.example.com",
    "bearerToken": "your-api-key"
  }
}
```

> **Security**: WSS (WebSocket Secure) is enforced for production connections. Use `ws://` only for local development.

### Disconnecting

```json
{ "tool": "browser_disconnect_remote" }
```

### Tool Availability

Remote backends support most tools but **not** browser-native APIs that require the extension context:

| Available on Remote             | NOT Available on Remote                       |
| ------------------------------- | --------------------------------------------- |
| Navigation, DOM interaction     | Tab management (`browser_create_tab`, etc.)   |
| Screenshots, accessibility tree | Storage (`browser_get_storage`, etc.)         |
| Script execution, validation    | File operations (`browser_file_upload`, etc.) |
| Wait operations, dialogs        | Browser APIs (`browser_bookmarks`, etc.)      |
| HTML/CSS modification           | `browser_history`, `browser_downloads`        |
| Network interception            |                                               |
| Device emulation                |                                               |
| Session management              |                                               |

Use `browser_list_tools` with a backend filter to see exactly which tools are available:

```json
{
  "tool": "browser_list_tools",
  "arguments": { "backend": "remote" }
}
```

### Switching to Remote at Runtime

You can also switch to remote via `browser_switch_backend`:

```json
{
  "tool": "browser_switch_backend",
  "arguments": {
    "backend": "remote",
    "wsUrl": "ws://localhost:9222"
  }
}
```

---

## Mobile Device Emulation

Agentic Browser can emulate mobile devices using the CDP `Emulation` domain. This changes the viewport size, user agent, device scale factor, and enables touch events — all without needing a physical device.

### Using a Device Preset

Built-in presets for popular devices:

| Preset              | Screen      | Scale  | Type   |
| ------------------- | ----------- | ------ | ------ |
| `iPhone 14`         | 390 × 844   | 3x     | Phone  |
| `iPhone 14 Pro Max` | 430 × 932   | 3x     | Phone  |
| `Pixel 7`           | 412 × 915   | 2.625x | Phone  |
| `iPad Pro`          | 1024 × 1366 | 2x     | Tablet |
| `Galaxy S23`        | 360 × 780   | 3x     | Phone  |

```json
{
  "tool": "browser_emulate_device",
  "arguments": {
    "action": "emulate",
    "preset": "iPhone 14"
  }
}
```

### Custom Device Configuration

Specify exact dimensions, scale, user agent, and orientation:

```json
{
  "tool": "browser_emulate_device",
  "arguments": {
    "action": "emulate",
    "width": 375,
    "height": 812,
    "deviceScaleFactor": 3,
    "mobile": true,
    "userAgent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)...",
    "orientation": "portrait",
    "touchEnabled": true
  }
}
```

### Switching Orientation

```json
{
  "tool": "browser_emulate_device",
  "arguments": {
    "action": "emulate",
    "preset": "iPad Pro",
    "orientation": "landscape"
  }
}
```

### Resetting to Desktop

```json
{
  "tool": "browser_emulate_device",
  "arguments": { "action": "reset" }
}
```

### Touch Interactions

When touch emulation is enabled, `browser_click` dispatches touch events. The page receives `touchstart` / `touchend` instead of mouse events, matching real mobile behavior.

---

## Tool Reference

All tools use the `browser_` prefix. The **Backend** column indicates availability:

- **All** = Chrome, Edge, and Remote
- **Local** = Chrome and Edge only

### Navigation (4 tools)

| Tool                 | Description                                        | Required Params | Backend |
| -------------------- | -------------------------------------------------- | --------------- | ------- |
| `browser_navigate`   | Navigate to a URL                                  | `url`           | All     |
| `browser_go_back`    | Go back in history                                 | —               | All     |
| `browser_go_forward` | Go forward in history                              | —               | All     |
| `browser_reload`     | Reload the page (optional `hard` for cache bypass) | —               | All     |

### DOM Interaction (5 tools)

| Tool             | Description                      | Required Params    | Backend |
| ---------------- | -------------------------------- | ------------------ | ------- |
| `browser_click`  | Click an element by CSS selector | `selector`         | All     |
| `browser_type`   | Type text into an input          | `selector`, `text` | All     |
| `browser_select` | Select an option in a `<select>` | `selector`         | All     |
| `browser_hover`  | Hover over an element            | `selector`         | All     |
| `browser_scroll` | Scroll the page or an element    | —                  | All     |

### Tab Management (4 tools)

| Tool                 | Description        | Required Params | Backend |
| -------------------- | ------------------ | --------------- | ------- |
| `browser_create_tab` | Create a new tab   | —               | Local   |
| `browser_close_tab`  | Close a tab        | `tabId`         | Local   |
| `browser_switch_tab` | Switch to a tab    | `tabId`         | Local   |
| `browser_list_tabs`  | List all open tabs | —               | Local   |

### Content Extraction (4 tools)

| Tool                         | Description                                              | Required Params | Backend |
| ---------------------------- | -------------------------------------------------------- | --------------- | ------- |
| `browser_screenshot`         | Capture screenshot (png/jpeg/webp, full page or element) | —               | All     |
| `browser_accessibility_tree` | Get accessibility tree                                   | —               | All     |
| `browser_get_html`           | Get HTML of page or element                              | —               | All     |
| `browser_extract_data`       | Extract structured data (table, attributes, structured)  | `type`          | All     |

### Script Execution (4 tools)

| Tool                          | Description                                    | Required Params | Backend |
| ----------------------------- | ---------------------------------------------- | --------------- | ------- |
| `browser_execute_script`      | Execute JavaScript in page context             | `script`        | All     |
| `browser_execute_script_file` | Load and execute JS from a URL                 | `file`          | All     |
| `browser_validate`            | Run validation script with assert/skip helpers | `script`        | All     |
| `browser_console`             | Execute console command and capture output     | `command`       | All     |

### Dialog Handling (2 tools)

| Tool                      | Description                                        | Required Params | Backend |
| ------------------------- | -------------------------------------------------- | --------------- | ------- |
| `browser_handle_dialog`   | Accept/dismiss JS dialogs (alert, confirm, prompt) | `action`        | All     |
| `browser_get_dialog_info` | Get info about the current dialog                  | —               | All     |

### Wait Operations (4 tools)

| Tool                            | Description                               | Required Params | Backend |
| ------------------------------- | ----------------------------------------- | --------------- | ------- |
| `browser_wait_for_selector`     | Wait for element (visible/hidden/present) | `selector`      | All     |
| `browser_wait_for_navigation`   | Wait for navigation to complete           | —               | All     |
| `browser_wait_for_network_idle` | Wait for network idle                     | —               | All     |
| `browser_wait_for_condition`    | Wait for JS expression to be true         | `expression`    | All     |

### UI Modification (4 tools)

| Tool                        | Description                                      | Required Params      | Backend |
| --------------------------- | ------------------------------------------------ | -------------------- | ------- |
| `browser_modify_html`       | Modify HTML (text, elements, attributes)         | `action`, `selector` | All     |
| `browser_modify_css`        | Modify CSS (inline styles, classes, stylesheets) | `action`             | All     |
| `browser_undo_modification` | Undo last HTML/CSS modification                  | `action`             | All     |
| `browser_revert_all`        | Revert all modifications                         | `action`             | All     |

### Storage (3 tools)

| Tool                    | Description                             | Required Params | Backend |
| ----------------------- | --------------------------------------- | --------------- | ------- |
| `browser_get_storage`   | Get cookies/localStorage/sessionStorage | `action`        | Local   |
| `browser_set_storage`   | Set storage data                        | `action`        | Local   |
| `browser_clear_storage` | Clear storage or delete cookies         | `action`        | Local   |

### File Operations (2 tools)

| Tool                  | Description                     | Required Params         | Backend |
| --------------------- | ------------------------------- | ----------------------- | ------- |
| `browser_file_upload` | Set files on `input[type=file]` | `selector`, `filePaths` | Local   |
| `browser_download`    | Start or check download status  | `action`                | Local   |

### Network (1 tool)

| Tool                        | Description                                  | Required Params | Backend |
| --------------------------- | -------------------------------------------- | --------------- | ------- |
| `browser_intercept_network` | Intercept, modify, or block network requests | `action`        | All     |

### Browser APIs (3 tools)

| Tool                | Description                     | Required Params | Backend |
| ------------------- | ------------------------------- | --------------- | ------- |
| `browser_bookmarks` | List/create/search bookmarks    | `action`        | Local   |
| `browser_history`   | Search/retrieve browser history | `action`        | Local   |
| `browser_downloads` | Get/monitor downloads           | `action`        | Local   |

### Metadata (1 tool)

| Tool                   | Description                                           | Required Params | Backend |
| ---------------------- | ----------------------------------------------------- | --------------- | ------- |
| `browser_get_metadata` | Extract page metadata (title, OG data, favicon, etc.) | —               | All     |

### Remote Connection (2 tools)

| Tool                        | Description                                 | Required Params | Backend |
| --------------------------- | ------------------------------------------- | --------------- | ------- |
| `browser_connect_remote`    | Connect to remote browser via WebSocket CDP | `wsUrl`         | All     |
| `browser_disconnect_remote` | Disconnect from remote browser              | —               | All     |

### Backend Management (2 tools)

| Tool                     | Description                                    | Required Params | Backend |
| ------------------------ | ---------------------------------------------- | --------------- | ------- |
| `browser_switch_backend` | Switch adapter (chrome/edge/remote) at runtime | `backend`       | All     |
| `browser_list_tools`     | List available tools, filtered by backend      | —               | All     |

### Device Emulation (1 tool)

| Tool                     | Description                               | Required Params | Backend |
| ------------------------ | ----------------------------------------- | --------------- | ------- |
| `browser_emulate_device` | Emulate mobile device or reset to desktop | `action`        | All     |

### Session Management (2 tools)

| Tool                     | Description                    | Required Params | Backend |
| ------------------------ | ------------------------------ | --------------- | ------- |
| `browser_export_session` | Export session state to JSON   | —               | All     |
| `browser_import_session` | Import session state from JSON | `data`          | All     |

---

## Common Workflows

### Web Scraping

```
1. browser_navigate        → { url: "https://example.com/products" }
2. browser_wait_for_selector → { selector: ".product-list" }
3. browser_extract_data    → { type: "table", selector: ".product-list table" }
```

### Form Filling

```
1. browser_navigate        → { url: "https://example.com/login" }
2. browser_type            → { selector: "#email", text: "user@example.com" }
3. browser_type            → { selector: "#password", text: "..." }
4. browser_click           → { selector: "button[type=submit]" }
5. browser_wait_for_navigation → { waitUntil: "networkidle" }
```

### Screenshot and Visual Inspection

```
1. browser_navigate        → { url: "https://example.com" }
2. browser_screenshot      → { fullPage: true, format: "png" }
3. browser_screenshot      → { selector: ".hero-section", format: "jpeg", quality: 90 }
```

### Mobile Responsive Testing

```
1. browser_emulate_device  → { action: "emulate", preset: "iPhone 14" }
2. browser_navigate        → { url: "https://example.com" }
3. browser_screenshot      → { fullPage: true }
4. browser_emulate_device  → { action: "emulate", preset: "iPad Pro", orientation: "landscape" }
5. browser_screenshot      → { fullPage: true }
6. browser_emulate_device  → { action: "reset" }
```

### Multi-Tab Research

```
1. browser_create_tab      → { url: "https://docs.example.com" }
2. browser_create_tab      → { url: "https://api.example.com/reference" }
3. browser_list_tabs       → {}
4. browser_switch_tab      → { tabId: <first-tab-id> }
5. browser_get_html        → { selector: "article" }
6. browser_switch_tab      → { tabId: <second-tab-id> }
7. browser_extract_data    → { type: "structured" }
```

### Network Request Interception

```
1. browser_intercept_network → { action: "enableInterception", patterns: ["*.api.example.com*"] }
2. browser_navigate          → { url: "https://example.com" }
3. browser_intercept_network → { action: "getInterceptedRequests" }
4. browser_intercept_network → { action: "disableInterception" }
```

### Session Persistence

```
1. browser_export_session  → {}          # Save current state
   # ... (agent stores the JSON response)
2. browser_import_session  → { data: "<previously exported JSON>" }  # Restore later
```

### Page Modification and Validation

```
1. browser_navigate        → { url: "https://example.com" }
2. browser_modify_html     → { action: "modifyText", selector: "h1", text: "New Title" }
3. browser_modify_css      → { action: "setStyle", selector: "h1", styles: { "color": "red" } }
4. browser_validate        → { script: "assert('title changed', document.querySelector('h1').textContent === 'New Title')" }
5. browser_revert_all      → { action: "revertAllHTML" }
```

---

## Configuration Reference

### MCP Server Configuration

Configuration is loaded from environment variables (prefix `AGENTIC_BROWSER_`) and an optional JSON config file. Environment variables take precedence over file values.

| Variable                         | Config Key                | Default                        | Description                         |
| -------------------------------- | ------------------------- | ------------------------------ | ----------------------------------- |
| `AGENTIC_BROWSER_SERVER_NAME`    | `serverName`              | `agentic-browser`              | MCP server display name             |
| `AGENTIC_BROWSER_SERVER_VERSION` | `serverVersion`           | `0.1.0`                        | Server version                      |
| `AGENTIC_BROWSER_NM_HOST_PATH`   | `nativeMessagingHostPath` | `com.agentic_browser.mcp_host` | Native Messaging host ID            |
| `AGENTIC_BROWSER_LOG_LEVEL`      | `logLevel`                | `info`                         | `debug` / `info` / `warn` / `error` |
| `AGENTIC_BROWSER_TIMEOUT`        | `timeout`                 | `30000`                        | Default timeout (ms)                |
| `AGENTIC_BROWSER_EXTENSION_ID`   | `extensionId`             | —                              | Chrome extension ID                 |
| `AGENTIC_BROWSER_CONFIG`         | —                         | —                              | Path to JSON config file            |

### Default Timeouts

| Operation            | Default | Constant                     |
| -------------------- | ------- | ---------------------------- |
| General tool timeout | 30 s    | `DEFAULT_TIMEOUT`            |
| Navigation           | 30 s    | `DEFAULT_NAVIGATION_TIMEOUT` |
| Wait operations      | 30 s    | `DEFAULT_WAIT_TIMEOUT`       |
| CDP commands         | 10 s    | `DEFAULT_CDP_TIMEOUT`        |
| Script execution     | 10 s    | `DEFAULT_SCRIPT_TIMEOUT`     |
| Connection timeout   | 10 s    | `DEFAULT_CONNECT_TIMEOUT`    |
| Polling interval     | 250 ms  | `DEFAULT_POLLING_INTERVAL`   |

All timeouts can be overridden per-tool-call via the `timeout` parameter.

---

## Troubleshooting

### Extension Not Connecting to MCP Server

**Symptom**: Extension popup shows disconnected status.

1. Verify the extension is loaded in `chrome://extensions` and enabled
2. Check that native messaging was set up with the correct extension ID:
   ```bash
   npx tsx scripts/setup-native-messaging.ts --extension-id <your-extension-id>
   ```
3. Verify the registry entry exists:
   ```cmd
   reg query "HKCU\SOFTWARE\Google\Chrome\NativeMessagingHosts\com.agentic_browser.mcp_host"
   ```
4. Check that the manifest JSON path in the registry points to a valid file
5. Ensure `npm run build` completed successfully (the batch wrapper points to `packages/mcp-server/dist/index.js`)

### MCP Server Not Starting

**Symptom**: AI agent reports connection failure.

1. Test the server manually:
   ```bash
   node packages/mcp-server/dist/index.js
   ```
2. Set `AGENTIC_BROWSER_LOG_LEVEL=debug` for verbose output
3. Verify Node.js version is 22+: `node --version`
4. Rebuild if needed: `npm run build:server`

### Tools Return Errors

**Symptom**: Tool calls return error responses.

- **"No active tab"**: Navigate to a page first with `browser_navigate`
- **"Selector not found"**: Use `browser_wait_for_selector` before interacting with dynamic content
- **"Timeout"**: Increase the `timeout` parameter or use `browser_wait_for_network_idle` after navigation
- **"Tool not available"**: The tool may not be supported on the current backend; use `browser_list_tools` to check

### Remote Connection Fails

**Symptom**: `browser_connect_remote` returns an error.

1. Verify the remote browser is running with `--remote-debugging-port`:
   ```bash
   curl http://localhost:9222/json/version
   ```
2. Check that the WebSocket URL is correct (use the `webSocketDebuggerUrl` from the response above)
3. For cloud services, verify the bearer token and that WSS is used (not WS)
4. Check firewall/network rules if connecting to a remote host

### Extension Reloads / Service Worker Restarts

Manifest V3 service workers are ephemeral — Chrome may terminate and restart them. Agentic Browser handles this via:

- State persistence in `chrome.storage.session` and `chrome.storage.local`
- Automatic CDP re-attachment on restart
- Tab tracking recovery

If you experience intermittent disconnections, this is normal MV3 behavior. The extension recovers automatically.

### Build Failures

```bash
# Clean and rebuild
npm run build

# Check TypeScript errors
npm run typecheck

# Run linter
npm run lint
```

### Getting Help

- Check existing [documentation](../docs/) for architecture details
- Use `browser_list_tools` to discover available tools and their parameters
- Set `AGENTIC_BROWSER_LOG_LEVEL=debug` for detailed server logs
- Inspect the browser extension's service worker console via `chrome://extensions` → **Inspect views: service worker**
