# Marshal Runtime Browser Panel

The Marshal Runtime Browser Panel is a self-contained workspace package and Chrome side-panel
surface for observing and controlling browser work owned by Marshal runtime sessions.

## Architecture

- `packages/runtime-panel` contains the portable protocol, session model, restoration planner,
  renderer, and `RuntimePanelClient`.
- `packages/extension/src/runtime-panel/chrome-transport.ts` adapts the runtime UI
  `UiProtocolTransport` contract to `chrome.runtime.sendMessage`.
- `packages/extension/src/background/runtime-panel-bridge.ts` persists panel state through the
  existing `SessionManager`, observes the existing `TabTracker`, and delegates browser operations
  to the existing `CommandRouter`.
- `packages/extension/src/ui/runtime-panel` is an independent webpack entry and Manifest V3
  `side_panel`. The popup and options entries are unchanged.
- `packages/runtime-extension` contributes `marshal.browser.panel.open-or-focus`; capability
  executions invoke the host controller after a successful result, once per
  `chatId`/`executionId`, so execution blocks can reveal an existing panel or open it without
  another model turn.

The panel does not implement a browser engine. Navigation, tab management, screenshots, and HTML
snapshots use the extension's registered browser tools and active adapter.

## Runtime bridge

Messages use the Marshal UI JSON-RPC 2.0 envelope:

```ts
interface UiProtocolMessage {
  jsonrpc: '2.0';
  id?: string | number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message: string; data?: unknown };
}
```

Chrome messages wrap that envelope with the `marshal-runtime-panel` channel. The native host can
send the same channel message to the service worker.

Runtime-to-panel notifications:

| Method                               | Payload                                                    |
| ------------------------------------ | ---------------------------------------------------------- |
| `marshal/browser-panel/session-sync` | Session identity, scope, chat, execution, and tracked tabs |
| `marshal/runtime/lifecycle`          | Marshal `RuntimeLifecycleEvent`                            |
| `marshal/ui/lifecycle`               | Session-scoped Marshal `UiLifecycleEvent`                  |
| `marshal/browser-panel/artifact`     | Runtime artifact, screenshot, or page snapshot             |
| `marshal/browser-panel/tool-log`     | Session-scoped tool/action journal entry                   |

Panel requests:

| Method                                  | Purpose                                                 |
| --------------------------------------- | ------------------------------------------------------- |
| `marshal/browser-panel/get-state`       | Restore persisted panel state                           |
| `marshal/browser-panel/select-session`  | Select one of several concurrent sessions               |
| `marshal/browser-panel/browser-command` | Route a supported command through `CommandRouter`       |
| `marshal/browser-panel/restore-session` | Restore baseline URLs and close session-created tabs    |
| `marshal/browser-panel/cleanup-session` | Optionally restore, then remove persisted session state |

Every runtime lifecycle event is scoped by `context.scope.sessionId`. UI lifecycle, artifacts, and
tool logs carry an explicit `sessionId`; events without a session identity are not merged into
another session.

## Build and test

```bash
npm run build:runtime-panel
npm test -- packages/runtime-panel/tests/runtime-panel.test.ts
npm run build:extension
```

After building, load `packages/extension/build` as an unpacked extension and choose **Agentic
Browser** from Chrome's side-panel picker.
