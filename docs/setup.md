# Development Setup

Step-by-step guide to set up a local development environment for Agentic Browser.

## Prerequisites

| Tool           | Required Version | Check Command    |
| -------------- | ---------------- | ---------------- |
| Node.js        | 22+ (LTS)        | `node --version` |
| npm            | 10+              | `npm --version`  |
| Git            | 2+               | `git --version`  |
| Chrome or Edge | Latest stable    | —                |

Install Node.js 22 via [nvm](https://github.com/nvm-sh/nvm) or [nvm-windows](https://github.com/coreybutler/nvm-windows):

```bash
nvm install 22
nvm use 22
```

The repo includes an `.nvmrc` file, so `nvm use` without arguments also works.

## Clone and Install

```bash
git clone <repository-url>
cd agentic-browser
npm install
```

This installs all workspace dependencies across `packages/shared`, `packages/extension`, and `packages/mcp-server`.

## Build

```bash
# Build all packages
npm run build

# Build individual packages
npm run build:shared
npm run build:extension
npm run build:server
```

## Run Tests

```bash
# Run all tests
npm test

# Watch mode
npm run test:watch

# With coverage
npm run test:coverage
```

## Lint and Format

```bash
# Lint
npm run lint
npm run lint:fix

# Format
npm run format
npm run format:check
```

## Type Check

```bash
npm run typecheck
```

## Load the Extension (Development)

1. Run `npm run build:extension`
2. Open `chrome://extensions` (or `edge://extensions`)
3. Enable **Developer mode** (toggle in top-right)
4. Click **Load unpacked**
5. Select the `packages/extension/build` directory
6. The Agentic Browser icon appears in the toolbar

For live reloading during development:

```bash
npm run dev
```

This watches for file changes and rebuilds the extension. Reload the extension in `chrome://extensions` after each rebuild.

## Register Native Messaging

After loading the extension, register the canonical Native Messaging host with its extension ID:

```bash
npx tsx scripts/setup-native-messaging.ts --extension-id <your-extension-id>
```

The setup script, extension, and MCP server all default to
`com.agentic_browser.mcp_host`. Set `AGENTIC_BROWSER_NM_HOST_PATH` or pass an
explicit transport constructor value only when intentionally overriding that
host executable/identifier.

Marshal-scoped local browser sessions require **Allow in Incognito** on the
extension details page. Chrome and Edge expose one shared incognito storage
context to an extension, so only one local Marshal browser session can be
active at a time; a second session fails instead of sharing cookies or web
storage.

## Connect the Marshal Extension Manager

Build this package and the Marshal runtime checkout, then materialize the packed
`@agentic-browser/marshal-runtime-extension` package beneath a host-approved
extension root:

```bash
npm run build:runtime-extension
npm pack packages/runtime-extension
```

At manager construction, call
`createMarshalBrowserExtensionLifecycle(...)` from
`@agentic-browser/marshal-runtime-extension/host` with Marshal's actual
`computeRuntimeExtensionIntegrity`, `LocalRuntimeExtensionPackageLoader`, and
`RuntimeExtensionManager` exports. Supply the live kernel, activation context,
durable state store, lifecycle coordinator, and panel controller. Call `start()`
once during startup; it is safe if startup paths converge and call it
concurrently. On shutdown, call `dispose()`.

Register the adapter's three `panelTools.toolIds` in the host's tool registry and
delegate each call to `panelTools.invoke(toolId, input, invocationContext)`.
Forward the complete Marshal `InvocationContext`, including `executionId`; the
adapter rejects unscoped panel calls.

The state store is a small host-owned persistence port with `read()` and
`write(state)` methods. Store the value in the same durable manager transaction
used for enabled extensions. Do not recompute integrity during restore: the
adapter deliberately loads with the previously persisted digest so changed
package contents fail closed.

The public Marshal runtime currently does not own a persisted extension registry
or a generic host-tool registration API. Those two calls remain explicit host
wiring; package loading, activation, restart verification, duplicate suppression,
bridge injection, and panel context adaptation are implemented here.

## Project Layout

The project uses npm workspaces with three packages:

- `packages/shared` — Shared types, Zod schemas, constants
- `packages/extension` — MV3 browser extension (Webpack build)
- `packages/mcp-server` — MCP server (TypeScript compiled)

See [architecture.md](architecture.md) for the full architecture overview.
