import { build } from 'esbuild';
import { existsSync } from 'node:fs';
import { copyFile, chmod, mkdir } from 'node:fs/promises';
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
  external: ['@agentic-browser/runtime-host', '@marshal/*'],
  legalComments: 'none',
});

/** Copies a locally-built native helper binary into dist/native/ so a staged install carries it (see ax-helper-client.ts / ocr-client.ts resolution order). */
async function stageNativeHelper(builtPath, stagedName) {
  if (!existsSync(builtPath)) return;
  const nativeDir = path.join(packageRoot, 'dist', 'native');
  await mkdir(nativeDir, { recursive: true });
  const dest = path.join(nativeDir, stagedName);
  await copyFile(builtPath, dest);
  await chmod(dest, 0o755);
}

await stageNativeHelper(
  path.join(packageRoot, 'native/ax-helper/.build/release/marshal-ax-helper'),
  'marshal-ax-helper',
);
await stageNativeHelper(
  path.join(packageRoot, 'native/ocr-helper/.build/release/marshal-ocr-helper'),
  'marshal-ocr-helper',
);
