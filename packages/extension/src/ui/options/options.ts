/**
 * Options page entry point — renders extension configuration settings
 * including connection, security, logging, and MCP server toggle.
 *
 * Loaded by HtmlWebpackPlugin as the options chunk.
 */

import './options.css';

interface OptionsState {
  autoConnect: boolean;
  allowedDomains: string;
  logLevel: string;
  mcpEnabled: boolean;
  connected: boolean;
}

const DEFAULTS: OptionsState = {
  autoConnect: false,
  allowedDomains: '',
  logLevel: 'info',
  mcpEnabled: false,
  connected: false,
};

function initialize(): void {
  const manifest = chrome.runtime.getManifest();

  const versionEl = document.getElementById('options-version');
  if (versionEl) {
    versionEl.textContent = `v${manifest.version}`;
  }

  loadOptions().then(applyState);

  const saveBtn = document.getElementById('opt-save');
  if (saveBtn) {
    saveBtn.addEventListener('click', handleSave);
  }

  const resetBtn = document.getElementById('opt-reset');
  if (resetBtn) {
    resetBtn.addEventListener('click', handleReset);
  }

  const debuggerBtn = document.getElementById('opt-enable-debugger');
  if (debuggerBtn) {
    debuggerBtn.addEventListener('click', () => void handleEnableDebugger());
  }

  console.debug('[options] Initialized', { version: manifest.version });
}

async function loadOptions(): Promise<OptionsState> {
  try {
    const result = await chrome.storage.local.get([
      'autoConnect',
      'allowedDomains',
      'logLevel',
      'mcpEnabled',
      'connected',
    ]);
    return {
      autoConnect: result.autoConnect ?? DEFAULTS.autoConnect,
      allowedDomains: result.allowedDomains ?? DEFAULTS.allowedDomains,
      logLevel: result.logLevel ?? DEFAULTS.logLevel,
      mcpEnabled: result.mcpEnabled ?? DEFAULTS.mcpEnabled,
      connected: result.connected ?? DEFAULTS.connected,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

function applyState(state: OptionsState): void {
  const dot = document.getElementById('options-status-dot');
  const label = document.getElementById('options-status-label');
  if (dot) dot.setAttribute('data-connected', String(state.connected));
  if (label) label.textContent = state.connected ? 'Connected' : 'Disconnected';

  const autoConnect = document.getElementById('opt-auto-connect') as HTMLInputElement | null;
  if (autoConnect) autoConnect.checked = state.autoConnect;

  const allowedDomains = document.getElementById('opt-allowed-domains') as HTMLTextAreaElement | null;
  if (allowedDomains) allowedDomains.value = state.allowedDomains;

  const logLevel = document.getElementById('opt-log-level') as HTMLSelectElement | null;
  if (logLevel) logLevel.value = state.logLevel;

  const mcpToggle = document.getElementById('opt-mcp-toggle') as HTMLInputElement | null;
  if (mcpToggle) mcpToggle.checked = state.mcpEnabled;
}

function readFormState(): Omit<OptionsState, 'connected'> {
  const autoConnect = document.getElementById('opt-auto-connect') as HTMLInputElement | null;
  const allowedDomains = document.getElementById('opt-allowed-domains') as HTMLTextAreaElement | null;
  const logLevel = document.getElementById('opt-log-level') as HTMLSelectElement | null;
  const mcpToggle = document.getElementById('opt-mcp-toggle') as HTMLInputElement | null;

  return {
    autoConnect: autoConnect?.checked ?? false,
    allowedDomains: allowedDomains?.value ?? '',
    logLevel: logLevel?.value ?? 'info',
    mcpEnabled: mcpToggle?.checked ?? false,
  };
}

async function handleSave(): Promise<void> {
  const formState = readFormState();
  await chrome.storage.local.set(formState);

  chrome.runtime.sendMessage({ type: 'mcp-toggle', enabled: formState.mcpEnabled });

  const statusEl = document.getElementById('opt-save-status');
  if (statusEl) {
    statusEl.textContent = 'Settings saved.';
    setTimeout(() => {
      statusEl.textContent = '';
    }, 2000);
  }

  console.debug('[options] Settings saved', formState);
}

async function handleReset(): Promise<void> {
  await chrome.storage.local.set({
    autoConnect: DEFAULTS.autoConnect,
    allowedDomains: DEFAULTS.allowedDomains,
    logLevel: DEFAULTS.logLevel,
    mcpEnabled: DEFAULTS.mcpEnabled,
  });

  const state = await loadOptions();
  applyState(state);

  const statusEl = document.getElementById('opt-save-status');
  if (statusEl) {
    statusEl.textContent = 'Settings reset to defaults.';
    setTimeout(() => {
      statusEl.textContent = '';
    }, 2000);
  }

  console.debug('[options] Settings reset to defaults');
}

async function handleEnableDebugger(): Promise<void> {
  const granted = await chrome.permissions.request({ permissions: ['debugger'] });
  const statusEl = document.getElementById('opt-debugger-status');
  if (statusEl) {
    statusEl.textContent = granted
      ? 'Browser debugging enabled.'
      : 'Browser debugging permission was not granted.';
  }
}

document.addEventListener('DOMContentLoaded', initialize);
