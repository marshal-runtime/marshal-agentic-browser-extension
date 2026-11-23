/** Bundle entrypoint (build.mjs; runtime-extension.json "entrypoint": "dist/runtime.cjs"). */
export { activate, activateEmbedded, type EmbeddedBrowserOptions } from './extension.js';
/** For an embedding host's transport: the typed error its relay throws (see BridgeErrorCode). */
export { BridgeError, type BridgeClient, type BridgeErrorCode } from './user/bridge.js';
export { VERSION } from './capabilities.js';
