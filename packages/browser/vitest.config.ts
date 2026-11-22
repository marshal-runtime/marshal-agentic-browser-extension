import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    globals: false,
    testTimeout: 30_000,
    // VITEST_MAX_* in the environment would otherwise conflict with the default minimum (CPUs - 1).
    poolOptions: { forks: { minForks: 1 }, threads: { minThreads: 1 } },
  },
});
