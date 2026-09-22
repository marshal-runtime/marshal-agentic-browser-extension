import { build } from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = path.dirname(fileURLToPath(import.meta.url));

await build({
  entryPoints: [path.join(packageRoot, 'src/runtime.ts')],
  outfile: path.join(packageRoot, 'dist/runtime.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['@agentic-browser/runtime-host'],
  legalComments: 'none',
});
