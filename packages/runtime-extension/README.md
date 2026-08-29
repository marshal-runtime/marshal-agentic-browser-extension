# Marshal Runtime Extension

This package exposes the native-routable Agentic Browser MCP commands as a Marshal capability provider. Browser calls continue through `ToolExecutor` and `NativeMessagingClient` to the extension command router and browser adapter.

Commands without a production extension router handler are omitted from Marshal discovery:
`browser_keyboard`, `browser_list_targets`, `browser_connect_remote`,
`browser_disconnect_remote`, `browser_switch_backend`, `browser_list_tools`,
`browser_export_session`, and `browser_import_session`.

## Build

```bash
npm run build:runtime-extension
```

The build emits:

- `dist/runtime.cjs` — portable `commonjs-bundle-v1` Marshal runtime entrypoint
- `dist/host.cjs` — Node host bridge for Native Messaging, durable lifecycle events, and panel host tools

## Manager lifecycle integration

The host adapter constructs the real `LocalRuntimeExtensionPackageLoader` and
`RuntimeExtensionManager`, injects one browser host bridge as
`@agentic-browser/runtime-host`, and persists the manager-authoritative integrity
record. The state store remains host-owned so Marshal can place it in its existing
durable configuration transaction.

```ts
import {
  computeRuntimeExtensionIntegrity,
  LocalRuntimeExtensionPackageLoader,
  RuntimeExtensionManager,
} from '@marshal/agent-runtime-extensions';
import { createMarshalBrowserExtensionLifecycle } from '@agentic-browser/marshal-runtime-extension/host';

const browserExtension = createMarshalBrowserExtensionLifecycle({
  marshal: {
    computeRuntimeExtensionIntegrity,
    LocalRuntimeExtensionPackageLoader,
    RuntimeExtensionManager,
  },
  kernel,
  activationContext,
  packageRoot: installedBrowserExtensionRoot,
  allowedRoots: [extensionPackageRoot],
  stateStore: marshalBrowserExtensionStateStore,
  host: {
    nativeMessagingHostPath: process.env.AGENTIC_BROWSER_NM_HOST_PATH,
    lifecycle: durableLifecycleCoordinator,
    panel: {
      open: (request) => marshalPanel.open(request.context),
      focus: (request) => marshalPanel.focus(request.context),
      openOrFocus: (request) => marshalPanel.openOrFocus(request.context),
    },
  },
});

await browserExtension.start();
```

`start()` installs and records the real domain-separated package-tree integrity on
first use. On restart it reuses the persisted digest and asks the real loader to
verify the package before activation. Repeated or concurrent `start()` calls do
not activate twice. Invalid persisted state, a moved package root, manifest
errors, integrity changes, and loader allowed-root failures all reject without
activating the package.

Register every ID in `browserExtension.panelTools.toolIds` with the Marshal host.
The host-tool callback must pass its real `InvocationContext`:

```ts
marshalHostTools.register(browserExtension.panelTools.toolIds, {
  invoke: (toolId, input, invocationContext) =>
    browserExtension.panelTools.invoke(toolId, input, invocationContext),
});
```

The exported IDs are `marshal.browser.panel.open`,
`marshal.browser.panel.focus`, and `marshal.browser.panel.open-or-focus`.
The adapter requires `executionId` for these panel host tools and resolves the
same logical browser session used by capability execution from chat, execution,
harness identity, and workspace/project scope. Each `chatId` + `executionId`
therefore receives a distinct logical browser-session ID. The extension command
router allocates owned tabs for that identity, serializes active-tab operations,
and disposes only that session's isolation resource when the runtime panel
session is cleaned up.

The production Chrome/Edge MV3 adapter uses one owned incognito profile because all extension incognito windows share one cookie and web-storage store. It rejects a second concurrent local session with `SESSION_ISOLATION_UNAVAILABLE`; it never falls back to a normal or shared window.

Concurrent isolation is supported by the remote CDP backend. Before the service worker starts, provision this `browserBackend` object in `chrome.storage.managed` through enterprise extension policy, or in `chrome.storage.local` during extension setup. Managed policy takes precedence:

```json
{
  "browserBackend": {
    "type": "remote",
    "wsUrl": "wss://browser-host.example/devtools/browser/<id>",
    "bearerToken": "<optional>",
    "timeout": 10000
  }
}
```

`wsUrl` must be a browser-level CDP WebSocket endpoint whose browser implements `Target.createBrowserContext`, `Target.createTarget`, flattened `Target.attachToTarget`, and `Target.disposeBrowserContext`. Each Marshal session then receives a distinct `browserContextId`; page, runtime, cookie, and storage operations are routed through that context's attached target session. Invalid configuration or connection failure stops browser bootstrap and does not silently select the local adapter. A browser host exposing that endpoint is the remaining deployment requirement; the MV3 extension cannot create multiple local Chrome profiles itself.

Successful browser capability executions automatically call the open-or-focus controller once per execution. Older completions and selections cannot override the newest execution or explicit host-tool selection. Browser lifecycle and tool status are delivered through the runtime-panel protocol, including screenshot, accessibility snapshot, and HTML artifacts. No browser action or UI implementation is duplicated by this package.

The contract test can be run against a built Marshal checkout:

```powershell
$env:MARSHAL_RUNTIME_ROOT = 'C:\path\to\marshal-agent-runtime'
npx vitest run packages/runtime-extension/tests/manager-lifecycle.contract.test.ts
```

It imports the checkout's built `@marshal/agent-runtime-extensions` and
`@marshal/agent-runtime-core` implementations and exercises install, duplicate
startup suppression, persisted restart restoration, capability registration,
panel invocation context, and fail-closed integrity/manifest/allowed-root cases.
When enabled, the test builds this package first if its local `dist` bundles are
absent, so the command works from a clean checkout without another test preparing
the package.
Live Chrome/Edge/native execution is still host release evidence and is not
claimed by this repository.
