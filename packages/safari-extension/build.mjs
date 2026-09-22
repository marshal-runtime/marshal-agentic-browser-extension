import { build } from 'esbuild';
import { copyFile, mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const outdir = join(root, 'build');

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });

await Promise.all([
  build({
    entryPoints: [join(root, 'src/background.ts')],
    outfile: join(outdir, 'background.js'),
    bundle: true,
    format: 'iife',
    target: 'es2020',
    sourcemap: true,
  }),
  build({
    entryPoints: [join(root, 'src/content.ts')],
    outfile: join(outdir, 'content.js'),
    bundle: true,
    format: 'iife',
    target: 'es2020',
    sourcemap: true,
  }),
  copyFile(join(root, 'src/manifest.json'), join(outdir, 'manifest.json')),
]);

console.log(`Built Safari Web Extension source at ${outdir}`);
