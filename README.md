# Agentic Browser

Agentic Browser provides browser automation through:

- a standalone Chrome/Edge CLI;
- an MV3 browser extension and MCP server; and
- `@agentic-browser/marshal-runtime-extension`, which contributes 42
  native-routable browser capabilities and Marshal panel catalog entries.

Operations cover navigation, DOM interaction, extraction, screenshots, tabs,
storage, browser APIs, emulation, and remote CDP.

## Requirements

- Node.js 22.13 or newer for the Marshal Runtime extension
- npm 10 or newer
- Chrome or Edge
- Chrome 120 or newer for the MV3 extension

## Build and install in Marshal

For a Marshal Runtime source checkout, place the whole repository at:

```text
<marshal-agent-runtime>\extensions\<repository>
```

Build the nested Runtime extension:

```powershell
npm ci
npm run build:runtime-extension
```

The Runtime's workspace discovery finds
`packages\runtime-extension\runtime-extension.json` and the built
`dist\runtime.cjs`. Open **Marshal > Plugins**, refresh the Runtime catalog,
find `@agentic-browser/marshal-runtime-extension`, then explicitly **Install**
and **Enable** it.

Discovery only publishes a catalog candidate. It does not install, enable,
activate, or execute code. Packaged Marshal installations use the extension
location managed by the Plugins host.

The host must also supply `@agentic-browser/runtime-host`, panel wiring, and a
working native transport to the loaded MV3 extension. Installing the Runtime
package alone does not establish that transport.

To create an npm archive instead:

```powershell
npm pack .\packages\runtime-extension
```

The package's `prepack` script rebuilds it.

## Standalone workflow

The CLI is the currently self-contained path:

```powershell
npm ci
npm run build:cli
npm run cli -- setup --browser edge --profile "Default"
npm run cli -- navigate "https://example.com"
npm run cli -- wait-for-selector "h1"
npm run cli -- screenshot --full-page --output page.png
npm run cli -- shutdown
```

`setup` can launch Chrome or Edge, run headless, or connect to an existing CDP
endpoint.

## Build and load the MV3 extension

```powershell
npm ci
npm run build:extension
```

1. Open `chrome://extensions` or `edge://extensions`.
2. Enable **Developer mode**.
3. Select **Load unpacked** and choose `packages\extension\build`.
4. If needed, open Options and select **Enable browser debugging**.
5. For Marshal's local isolated browser session, enable **Allow in Incognito**.

The backend defaults to local Chrome/Edge. Managed policy or extension storage
can set `browserBackend.type` to `remote` with a browser-level CDP `wsUrl`,
optional bearer token, and timeout. Non-local endpoints require `wss://`;
invalid remote configuration fails instead of silently falling back.

## MCP and Native Messaging

```powershell
npm ci
npm run build
node .\packages\mcp-server\dist\index.js
```

Effective MCP variables include:

| Variable | Purpose |
| --- | --- |
| `AGENTIC_BROWSER_SERVER_NAME` | MCP server name |
| `AGENTIC_BROWSER_SERVER_VERSION` | Reported server version |
| `AGENTIC_BROWSER_NM_HOST_PATH` | Native host executable path |
| `AGENTIC_BROWSER_TIMEOUT` | Operation timeout |

The checked-in Native Messaging registration helper is Windows-only and is not
a complete bidirectional MCP-to-extension relay. It also invokes undeclared
`tsx`, so treat this path as development integration rather than a turnkey
installation.

## Current limitations

- Live Marshal-to-browser Native Messaging integration remains unverified and
  the repository helper does not provide the complete relay.
- The `mcpEnabled` setting can reconnect after a service-worker restart even
  when persisted as disabled.
- Local Marshal isolation supports one session; concurrent isolated sessions
  require an external remote-CDP service.
- Eight MCP descriptors are intentionally omitted from Marshal because they
  lack production native routing.
- Bookmarks, history, downloads, and cookies have no user-facing optional
  permission grant flow.
- `AGENTIC_BROWSER_LOG_LEVEL` and `AGENTIC_BROWSER_EXTENSION_ID` are parsed by
  MCP configuration but are not currently applied.

Additional integration details are in
[the Runtime extension README](packages/runtime-extension/README.md) and
[the Runtime panel guide](docs/runtime-panel.md).

## License

No repository-level license file or license grant is currently declared.
