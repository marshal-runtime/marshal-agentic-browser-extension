import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, copyFile, mkdir } from 'node:fs/promises';
import { warn } from 'node:console';
import path from 'node:path';
import { env, platform } from 'node:process';
import { fileURLToPath } from 'node:url';

const packageRoot = path.dirname(fileURLToPath(import.meta.url));

await build({
  entryPoints: [path.join(packageRoot, 'src/runtime.ts')],
  outfile: path.join(packageRoot, 'dist/runtime.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['@marshal/*'],
  legalComments: 'none',
});

/**
 * The app backend's Swift helpers (native/ax-helper, native/ocr-helper) are copied into dist/native so an installed
 * extension carries them (src/app/*-client.ts look there first). On macOS they are built here when missing; set
 * MARSHAL_BROWSER_SKIP_SWIFT=1 to skip. Without them the app backend reports `helper_missing` in browser.status.
 */
for (const { folder, binary } of [
  { folder: 'ax-helper', binary: 'marshal-ax-helper' },
  { folder: 'ocr-helper', binary: 'marshal-ocr-helper' },
]) {
  const built = path.join(packageRoot, 'native', folder, '.build', 'release', binary);
  if (!existsSync(built) && platform === 'darwin' && env['MARSHAL_BROWSER_SKIP_SWIFT'] !== '1') {
    try {
      execFileSync('swift', ['build', '-c', 'release'], {
        cwd: path.join(packageRoot, 'native', folder),
        stdio: 'inherit',
      });
    } catch (error) {
      warn(`[build] swift build of ${folder} failed: ${String(error)}`);
    }
  }
  if (!existsSync(built)) {
    warn(`[build] ${binary} is not built; the app backend will report helper_missing`);
    continue;
  }
  const nativeDir = path.join(packageRoot, 'dist', 'native');
  await mkdir(nativeDir, { recursive: true });
  const dest = path.join(nativeDir, binary);
  await copyFile(built, dest);
  await chmod(dest, 0o755);
}
