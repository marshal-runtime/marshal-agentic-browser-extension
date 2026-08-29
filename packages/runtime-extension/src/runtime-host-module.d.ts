/* eslint-disable @typescript-eslint/consistent-type-imports */

declare module '@agentic-browser/runtime-host' {
  const host: import('./contracts.js').MarshalBrowserRuntimeHostModule;
  export default host;
}
