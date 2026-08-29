import { execSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NATIVE_MESSAGING_HOST_ID } from '@agentic-browser/shared';

const DESCRIPTION = 'Agentic Browser MCP Server';
const DEFAULT_EXTENSION_ID = 'YOUR_EXTENSION_ID_HERE';

const CHROME_REGISTRY_KEY = `HKCU\\SOFTWARE\\Google\\Chrome\\NativeMessagingHosts\\${NATIVE_MESSAGING_HOST_ID}`;
const EDGE_REGISTRY_KEY = `HKCU\\SOFTWARE\\Microsoft\\Edge\\NativeMessagingHosts\\${NATIVE_MESSAGING_HOST_ID}`;

interface HostManifest {
  name: string;
  description: string;
  path: string;
  type: 'stdio';
  allowed_origins: string[];
}

function parseExtensionId(args: string[]): string {
  const idFlag = args.indexOf('--extension-id');
  if (idFlag !== -1) {
    const value = args[idFlag + 1];
    if (value) return value;
  }
  return DEFAULT_EXTENSION_ID;
}

function getProjectRoot(): string {
  const scriptDir = resolve(fileURLToPath(import.meta.url), '..');
  return resolve(scriptDir, '..');
}

function createBatchWrapper(projectRoot: string): string {
  const binaryPath = resolve(projectRoot, 'packages', 'mcp-server', 'dist', 'index.js');
  const batchPath = join(projectRoot, `${NATIVE_MESSAGING_HOST_ID}.bat`);
  const batchContent = `@echo off\r\nnode "${binaryPath}" %*\r\n`;
  writeFileSync(batchPath, batchContent, 'utf-8');
  console.log(`Batch wrapper written to: ${batchPath}`);
  return batchPath;
}

function buildManifest(batchPath: string, extensionId: string): HostManifest {
  return {
    name: NATIVE_MESSAGING_HOST_ID,
    description: DESCRIPTION,
    path: batchPath,
    type: 'stdio',
    allowed_origins: [`chrome-extension://${extensionId}/`],
  };
}

function writeManifestFile(manifest: HostManifest, outputPath: string): void {
  const content = JSON.stringify(manifest, null, 2);
  writeFileSync(outputPath, content, 'utf-8');
  console.log(`Manifest written to: ${outputPath}`);
}

function registerInRegistry(registryKey: string, manifestPath: string): void {
  const command = `reg add "${registryKey}" /ve /t REG_SZ /d "${manifestPath}" /f`;
  try {
    execSync(command, { stdio: 'pipe' });
    console.log(`Registered: ${registryKey}`);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Failed to register ${registryKey}: ${message}`);
    process.exitCode = 1;
  }
}

function main(): void {
  const args = process.argv.slice(2);
  const extensionId = parseExtensionId(args);
  const projectRoot = getProjectRoot();

  const batchPath = createBatchWrapper(projectRoot);
  const manifest = buildManifest(batchPath, extensionId);
  const manifestPath = join(projectRoot, `${NATIVE_MESSAGING_HOST_ID}.json`);

  writeManifestFile(manifest, manifestPath);

  console.log('\nRegistering Native Messaging host for Chrome...');
  registerInRegistry(CHROME_REGISTRY_KEY, manifestPath);

  console.log('Registering Native Messaging host for Edge...');
  registerInRegistry(EDGE_REGISTRY_KEY, manifestPath);

  console.log('\nSetup complete.');
  console.log(`Extension ID: ${extensionId}`);
  if (extensionId === DEFAULT_EXTENSION_ID) {
    console.log(
      'NOTE: Using placeholder extension ID. Re-run with --extension-id <id> after loading the extension.',
    );
  }
}

main();
