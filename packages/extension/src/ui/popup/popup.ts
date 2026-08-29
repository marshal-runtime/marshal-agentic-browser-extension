/**
 * Popup entry point — renders extension name, version, connection status,
 * MCP server toggle, and active agent connections.
 *
 * Loaded by HtmlWebpackPlugin as the popup chunk.
 */

import './popup.css';

interface PopupState {
  mcpEnabled: boolean;
  connected: boolean;
  agents: string[];
}

function initialize(): void {
  const manifest = chrome.runtime.getManifest();

  const versionEl = document.getElementById('popup-version');
  if (versionEl) {
    versionEl.textContent = `v${manifest.version}`;
  }

  loadState().then((state) => {
    updateConnectionStatus(state.connected);
    updateToggle(state.mcpEnabled);
    updateAgentList(state.agents);
  });

  const toggleBtn = document.getElementById('mcp-toggle');
  if (toggleBtn) {
    toggleBtn.addEventListener('click', handleToggleClick);
  }

  console.debug('[popup] Initialized', { version: manifest.version });
}

async function loadState(): Promise<PopupState> {
  try {
    const result = await chrome.storage.local.get(['mcpEnabled', 'connected', 'agents']);
    return {
      mcpEnabled: result.mcpEnabled ?? false,
      connected: result.connected ?? false,
      agents: result.agents ?? [],
    };
  } catch {
    return { mcpEnabled: false, connected: false, agents: [] };
  }
}

function updateConnectionStatus(connected: boolean): void {
  const dot = document.getElementById('popup-status-dot');
  const label = document.getElementById('popup-status-label');

  if (dot) {
    dot.setAttribute('data-connected', String(connected));
  }
  if (label) {
    label.textContent = connected ? 'Connected' : 'Disconnected';
  }
}

function updateToggle(enabled: boolean): void {
  const toggleBtn = document.getElementById('mcp-toggle');
  if (toggleBtn) {
    toggleBtn.setAttribute('aria-checked', String(enabled));
    toggleBtn.classList.toggle('ab-toggle--active', enabled);
  }
}

function updateAgentList(agents: string[]): void {
  const listEl = document.getElementById('popup-agents');
  const emptyEl = document.getElementById('popup-no-agents');

  if (!listEl) return;

  if (agents.length === 0) {
    if (emptyEl) emptyEl.style.display = '';
    return;
  }

  if (emptyEl) emptyEl.style.display = 'none';

  for (const agent of agents) {
    const li = document.createElement('li');
    li.className = 'ab-agent-item';
    li.textContent = agent;
    listEl.appendChild(li);
  }
}

async function handleToggleClick(): Promise<void> {
  const state = await loadState();
  const newEnabled = !state.mcpEnabled;

  await chrome.storage.local.set({ mcpEnabled: newEnabled });
  updateToggle(newEnabled);

  chrome.runtime.sendMessage({ type: 'mcp-toggle', enabled: newEnabled });
  console.debug('[popup] MCP server toggled', { enabled: newEnabled });
}

document.addEventListener('DOMContentLoaded', initialize);
