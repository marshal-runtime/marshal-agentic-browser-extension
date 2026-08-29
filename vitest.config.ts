import { defineConfig } from 'vitest/config';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['packages/*/tests/**/*.test.ts', 'packages/**/src/tests/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/build/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['packages/*/src/**/*.ts'],
      exclude: ['**/*.test.ts', '**/*.spec.ts', '**/tests/**', '**/index.ts', '**/*.d.ts'],
      thresholds: {
        statements: 80,
        branches: 70,
        functions: 80,
        lines: 80,
      },
    },
  },
  resolve: {
    alias: {
      '@shared': fileURLToPath(new URL('packages/shared/src', import.meta.url)),
      '@agentic-browser/shared': fileURLToPath(
        new URL('packages/shared/src/index.ts', import.meta.url),
      ),
      '@agentic-browser/mcp-server/browser-tools': fileURLToPath(
        new URL('packages/mcp-server/src/browser-tools-api.ts', import.meta.url),
      ),
      '@agentic-browser/mcp-server/runtime-api': fileURLToPath(
        new URL('packages/mcp-server/src/runtime-api.ts', import.meta.url),
      ),
      '@marshal/runtime-browser-panel': fileURLToPath(
        new URL('packages/runtime-panel/src/index.ts', import.meta.url),
      ),
    },
  },
});
