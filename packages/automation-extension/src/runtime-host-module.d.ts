/**
 * Ambient declaration for the host-injected `@agentic-browser/runtime-host`
 * module (see electron/marshal-runtime/host.ts's createNodeBuiltinModuleMap /
 * injectedModules wiring) - it is not a real npm package on disk, so it has
 * no shipped types. This lets extension.ts use a normal `import` instead of
 * `require()`: build.mjs marks this module `external` and the bundle's
 * output format is `cjs`, so esbuild compiles the import down to the same
 * `require("@agentic-browser/runtime-host")` call either way - no behavior
 * change.
 *
 * Declared as `unknown` (not the real `AgenticBrowserRuntimeHost` shape)
 * deliberately: referencing that type here via any import form (a hoisted
 * `import type` or an inline `import('./contracts.js').Type` query) trips a
 * typescript-eslint project-service resolution quirk that makes the
 * imported value show up as an "error" type at every call site in
 * extension.ts, even though `tsc` itself compiles clean. Matches the
 * original code's own pattern of casting the untyped `require(...)` result
 * with `as AgenticBrowserRuntimeHost` at the single use site instead.
 */
declare module '@agentic-browser/runtime-host' {
  const host: unknown;
  export default host;
}
