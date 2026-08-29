import { execFileSync, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const cliEntry = path.join(repositoryRoot, 'packages', 'cli', 'dist', 'index.js');

describe('agentic-browser CLI compatibility', () => {
  beforeAll(() => {
    const npmExecPath = process.env['npm_execpath'];
    if (!npmExecPath) {
      throw new Error('npm_execpath is required for the CLI compatibility test');
    }
    execFileSync(process.execPath, [npmExecPath, 'run', 'build:cli'], {
      cwd: repositoryRoot,
      stdio: 'pipe',
    });
  });

  it('keeps the existing CLI entrypoint and help surface operational', () => {
    const result = spawnSync(process.execPath, [cliEntry, '--help'], {
      cwd: repositoryRoot,
      encoding: 'utf8',
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('Agentic Browser CLI');
    expect(result.stderr).toContain('navigate <url>');
    expect(result.stderr).toContain('list-targets');
  });
});
