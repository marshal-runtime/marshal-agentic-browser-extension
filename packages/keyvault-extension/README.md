# Marshal KeyVault runtime extension

Marshal KeyVault gives an agent one capability, `keyvault.write_to_input_box`.
The agent supplies only a vault key and exact CSS selectors. The extension
loads the credential internally, checks the entry's absolute `notBefore` /
`expiresAt` window, and sends the secret through a host-only browser sink. The
capability result contains only `{ success, key, filled }`—never username or
password.

Each entry also carries an explicit HTTP(S) URL allowlist. The allowlist is
checked again in the browser extension immediately before the DOM write, using
the active tab URL. The privileged `typeSecret` command is not in
`BROWSER_TOOLS`, so it is absent from normal browser discovery and cannot be
requested through the ordinary browser capability provider.

After a successful secret write, the shared browser host marks that browser
session as secret-tainted and blocks screenshots, accessibility/HTML extraction,
script execution, console execution, validation, network interception, storage
reads, and condition polling for the rest of that session. Clicks, navigation, waits, and ordinary typing remain
available so the agent can submit the form. This prevents the agent from using
`browser_execute_script` to read `input.value` back after filling.

## Host wiring

The Marshal host must provide two services under the exported stable symbols:

```ts
import {
  KEYVAULT_SECRET_INPUT_SERVICE,
  KEYVAULT_STORE_SERVICE,
  createAgenticBrowserSecretInputSink,
  type KeyVaultStore,
} from '@marshal/keyvault-runtime-extension';

await osKeychainBackedStore.put({
  key: 'Google-zyg',
  username: 'operator@example.com',
  password: operatorPassword,
  allowedUrlPatterns: ['https://accounts.google.com/*'],
  notBefore: '2026-09-15T09:00:00.000Z',
  expiresAt: '2026-09-15T17:00:00.000Z',
});

// Store credentials in the OS keychain (Keychain/Credential Manager/libsecret)
// or another host-controlled secret manager. Do not use the in-memory store in
// production.
await services.bind(KEYVAULT_STORE_SERVICE, {
  useValue: osKeychainBackedStore,
});

await services.bind(KEYVAULT_SECRET_INPUT_SERVICE, {
  useValue: createAgenticBrowserSecretInputSink(browserRuntimeHost),
});
```

`browserRuntimeHost` is the same host bridge used by the Agentic Browser
runtime extension. Its `invokeSecretType` method must route the request through
the host-only native command and must not emit lifecycle input, panel logs, or
agent-visible output containing the secret.

For real Safari, the Marshal host assigns `InvocationContext.browserInstanceId`
from the selected Safari profile/extension handshake. The agent does not supply
this value. The host forwards it to the Safari native bridge, which rejects
requests from a different profile or extension instance.

The extension intentionally has no agent-facing “read secret” capability and
no agent-facing credential-write capability. Provisioning is a host/UI action.
The exported `InMemoryKeyVaultStore` exists only for tests and local demos.

The destination website can still observe a value typed into its own page. URL
allowlists and isolated browser sessions are important, but they do not make an
untrusted website trusted.
