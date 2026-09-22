# Real Safari integration

This package is the Safari Web Extension side of the Marshal browser bridge. It targets the installed Safari application, not Playwright WebKit.

## Security boundary

The agent-facing KeyVault capability sends a key and selectors to the Marshal host. The host resolves the credential, checks the time window, and sends the secret only to the Safari native port. The Safari background script checks the instance binding and active-tab URL, then sends the value to the content script. The content script checks the URL again and requires a visible input; password writes require `input[type=password]`.

No secret is returned in a port response, browser tool result, log message, screenshot, HTML result, or agent-visible output.

## Build and package

```sh
npm run build:safari-extension
xcrun safari-web-extension-converter packages/safari-extension/build \
  --project-location native/safari-xcode \
  --app-name "Marshal Safari Bridge"
```

The converter command requires the full Xcode installation. The generated macOS containing app must include the native extension handler from `native/safari/` and the `nativeMessaging` permission. Enable the extension in Safari before starting Marshal.

## Instance binding

The extension creates a stable per-Safari-profile `browserInstanceId` in extension storage and sends it in its handshake. Marshal must attach that value to the browser request context; requests without a matching instance are rejected. The extension ID is also included for diagnostics, but it is not treated as a secret or as the routing authority.

## Current scope

This is the real-Safari transport and KeyVault path. The existing Chromium adapter still uses Chrome DevTools Protocol, which Safari does not expose through the same extension API. Full parity for screenshots, accessibility, tabs, and arbitrary script execution therefore requires additional Safari-specific implementations.
