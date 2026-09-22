import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const repositoryRoot = resolve(import.meta.dirname, '..');
const extensionSource = resolve(repositoryRoot, 'packages/safari-extension/build');
const projectLocation = resolve(repositoryRoot, 'native/safari-xcode');

try {
  execFileSync('xcrun', ['--find', 'safari-web-extension-converter'], {
    cwd: repositoryRoot,
    stdio: 'inherit',
  });
} catch {
  throw new Error(
    'Real Safari packaging requires the full Xcode installation. Install Xcode, select it with xcode-select, and retry.',
  );
}

if (!existsSync(resolve(extensionSource, 'manifest.json'))) {
  execFileSync('npm', ['run', 'build:safari-extension'], {
    cwd: repositoryRoot,
    stdio: 'inherit',
  });
}

execFileSync('xcrun', [
  'safari-web-extension-converter',
  extensionSource,
  '--project-location',
  projectLocation,
  '--app-name',
  'Marshal Safari Bridge',
], {
  cwd: repositoryRoot,
  stdio: 'inherit',
});
