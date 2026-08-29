import type {
  RuntimePanelSession,
  RuntimePanelState,
  RuntimePanelTimelineEntry,
  RuntimePanelToolLog,
} from './protocol.js';

export interface RuntimePanelRenderOptions {
  readonly clientError?: string;
}

export function renderRuntimePanel(
  state: RuntimePanelState,
  options: RuntimePanelRenderOptions = {},
): string {
  const sessions = Object.values(state.sessions).sort((left, right) =>
    right.updatedAt.localeCompare(left.updatedAt),
  );
  const selected =
    (state.selectedSessionId ? state.sessions[state.selectedSessionId] : undefined) ?? sessions[0];

  return `
    <div class="runtime-panel">
      <header class="panel-header">
        <div>
          <p class="eyebrow">Marshal Runtime Extension</p>
          <h1>Browser sessions</h1>
        </div>
        <span class="session-count">${String(sessions.length)} session${sessions.length === 1 ? '' : 's'}</span>
      </header>
      ${renderSessionSelector(sessions, selected?.sessionId)}
      ${options.clientError ? `<div class="alert alert-error">${escapeHtml(options.clientError)}</div>` : ''}
      ${selected ? renderSelectedSession(selected) : renderEmptyState()}
    </div>
  `;
}

export function renderTimelineEntry(entry: RuntimePanelTimelineEntry): string {
  return `
    <li class="timeline-entry timeline-${entry.status}">
      <span class="timeline-dot" aria-hidden="true"></span>
      <div>
        <div class="timeline-heading">
          <strong>${escapeHtml(entry.label)}</strong>
          <time datetime="${escapeAttribute(entry.occurredAt)}">${escapeHtml(formatTime(entry.occurredAt))}</time>
        </div>
        <span class="timeline-type">${escapeHtml(entry.type)}</span>
        ${entry.details === undefined ? '' : renderDetails(entry.details)}
      </div>
    </li>
  `;
}

export function renderToolLog(log: RuntimePanelToolLog): string {
  const detail = log.error ?? log.result ?? log.input;
  return `
    <li class="tool-log tool-${log.status}">
      <div class="tool-log-heading">
        <strong>${escapeHtml(log.name)}</strong>
        <span class="status-pill">${escapeHtml(log.status)}</span>
      </div>
      <time datetime="${escapeAttribute(log.occurredAt)}">${escapeHtml(formatTime(log.occurredAt))}</time>
      ${detail === undefined ? '' : renderDetails(detail)}
    </li>
  `;
}

function renderSessionSelector(
  sessions: readonly RuntimePanelSession[],
  selectedSessionId?: string,
): string {
  if (sessions.length === 0) {
    return '';
  }
  return `
    <nav class="session-selector" aria-label="Runtime sessions">
      ${sessions
        .map(
          (session) => `
            <button
              type="button"
              class="session-chip${session.sessionId === selectedSessionId ? ' selected' : ''}"
              data-action="select-session"
              data-session-id="${escapeAttribute(session.sessionId)}"
            >
              <span>${escapeHtml(session.title)}</span>
              <small>${escapeHtml(session.execution.status)}</small>
            </button>
          `,
        )
        .join('')}
    </nav>
  `;
}

function renderSelectedSession(session: RuntimePanelSession): string {
  return `
    <main class="session-surface" data-session-id="${escapeAttribute(session.sessionId)}">
      ${renderSessionSummary(session)}
      ${session.error ? `<div class="alert alert-error"><strong>${escapeHtml(session.error.code ?? 'Error')}</strong> ${escapeHtml(session.error.message)}</div>` : ''}
      ${session.loading ? '<div class="loading-bar" role="progressbar" aria-label="Browser action in progress"></div>' : ''}
      ${renderBrowserSurface(session)}
      <section class="activity-grid">
        ${renderChat(session)}
        ${renderTimeline(session)}
        ${renderToolLogs(session)}
      </section>
      ${renderSessionControls(session)}
    </main>
  `;
}

function renderSessionSummary(session: RuntimePanelSession): string {
  const identity = session.identity;
  const execution = session.execution;
  return `
    <section class="session-summary">
      <div>
        <span class="status-dot status-${escapeAttribute(statusTone(execution.status))}" aria-hidden="true"></span>
        <strong>${escapeHtml(session.title)}</strong>
        <span class="status-pill">${escapeHtml(execution.status)}</span>
      </div>
      <dl>
        <div><dt>Session</dt><dd>${escapeHtml(session.sessionId)}</dd></div>
        <div><dt>Execution</dt><dd>${escapeHtml(execution.executionId ?? 'Waiting')}</dd></div>
        <div><dt>Agent</dt><dd>${escapeHtml(identity?.agentId ?? identity?.harnessId ?? 'Unknown')}</dd></div>
        <div><dt>Target</dt><dd>${escapeHtml(execution.target ?? 'Not started')}</dd></div>
      </dl>
    </section>
  `;
}

function renderBrowserSurface(session: RuntimePanelSession): string {
  const activeTab =
    session.tabs.find((tab) => tab.tabId === session.activeTabId) ??
    session.tabs.find((tab) => tab.active) ??
    session.tabs[0];
  return `
    <section class="browser-card">
      <form class="browser-toolbar" data-action="navigate">
        <button type="button" data-action="browser-command" data-command="goBack" title="Back">Back</button>
        <button type="button" data-action="browser-command" data-command="goForward" title="Forward">Forward</button>
        <button type="button" data-action="browser-command" data-command="reload" title="Reload">Reload</button>
        <input
          name="url"
          type="url"
          aria-label="Browser URL"
          placeholder="https://example.com"
          value="${escapeAttribute(activeTab?.url ?? '')}"
          ${session.loading ? 'disabled' : ''}
        />
        <button type="submit" class="primary" ${session.loading ? 'disabled' : ''}>Go</button>
      </form>
      <div class="browser-tabs" role="tablist" aria-label="Session tabs">
        ${session.tabs
          .map(
            (tab) => `
              <button
                type="button"
                role="tab"
                aria-selected="${String(tab.tabId === activeTab?.tabId)}"
                class="browser-tab${tab.tabId === activeTab?.tabId ? ' active' : ''}"
                data-action="switch-tab"
                data-tab-id="${String(tab.tabId)}"
              >
                <span>${escapeHtml(tab.title || tab.url || 'Untitled')}</span>
                <small>${escapeHtml(tab.status)}</small>
              </button>
            `,
          )
          .join('')}
        <button type="button" class="new-tab" data-action="new-tab" title="New tab">New</button>
      </div>
      <div class="viewport-header">
        <div>
          <strong>Page snapshot</strong>
          <span>${escapeHtml(activeTab?.url ?? 'No active browser tab')}</span>
        </div>
        <div>
          <button type="button" data-action="capture-screenshot">Screenshot</button>
          <button type="button" data-action="capture-html">HTML snapshot</button>
        </div>
      </div>
      ${renderSnapshot(session)}
    </section>
  `;
}

function renderSnapshot(session: RuntimePanelSession): string {
  const artifact = [...session.artifacts]
    .reverse()
    .find((candidate) => candidate.kind === 'screenshot' || candidate.kind === 'page-snapshot');
  if (!artifact) {
    return `
      <div class="viewport-empty">
        <strong>No snapshot captured</strong>
        <p>Capture a screenshot or HTML snapshot from the selected browser tab.</p>
      </div>
    `;
  }
  if (artifact.kind === 'screenshot' && artifact.data && artifact.mediaType) {
    return `
      <figure class="viewport-image">
        <img
          src="data:${escapeAttribute(artifact.mediaType)};base64,${escapeAttribute(artifact.data)}"
          alt="Captured browser viewport"
        />
        <figcaption>${escapeHtml(metadataString(artifact, 'url') ?? 'Latest screenshot')}</figcaption>
      </figure>
    `;
  }
  return `
    <div class="viewport-source">
      <div class="snapshot-meta">${escapeHtml(metadataString(artifact, 'url') ?? 'HTML snapshot')}</div>
      <pre>${escapeHtml(artifact.text ?? '')}</pre>
    </div>
  `;
}

function renderChat(session: RuntimePanelSession): string {
  return `
    <section class="activity-card">
      <h2>Chat</h2>
      <ol class="chat-list">
        ${
          session.chat.length === 0
            ? '<li class="empty-list">No chat messages yet.</li>'
            : session.chat
                .map(
                  (message) => `
                    <li class="chat-message chat-${message.role}">
                      <div><strong>${escapeHtml(message.role)}</strong><time>${escapeHtml(formatTime(message.createdAt))}</time></div>
                      <p>${escapeHtml(message.content)}</p>
                    </li>
                  `,
                )
                .join('')
        }
      </ol>
    </section>
  `;
}

function renderTimeline(session: RuntimePanelSession): string {
  return `
    <section class="activity-card">
      <h2>Live timeline</h2>
      <ol class="timeline-list">
        ${
          session.timeline.length === 0
            ? '<li class="empty-list">Waiting for runtime lifecycle events.</li>'
            : [...session.timeline].reverse().map(renderTimelineEntry).join('')
        }
      </ol>
    </section>
  `;
}

function renderToolLogs(session: RuntimePanelSession): string {
  return `
    <section class="activity-card">
      <h2>Tool and action logs</h2>
      <ol class="tool-list">
        ${
          session.toolLogs.length === 0
            ? '<li class="empty-list">No tool calls recorded.</li>'
            : [...session.toolLogs].reverse().map(renderToolLog).join('')
        }
      </ol>
    </section>
  `;
}

function renderSessionControls(session: RuntimePanelSession): string {
  const canRestore =
    session.restoration.status === 'available' || session.restoration.status === 'failed';
  return `
    <footer class="session-controls">
      <div>
        <strong>Restoration: ${escapeHtml(session.restoration.status)}</strong>
        <span>Return tracked tabs to their pre-session URLs and close tabs created by this session.</span>
      </div>
      <button type="button" data-action="restore-session" ${canRestore ? '' : 'disabled'}>Restore browser</button>
      <button type="button" class="danger" data-action="cleanup-session">Clean up session</button>
    </footer>
  `;
}

function renderEmptyState(): string {
  return `
    <main class="empty-state">
      <strong>Waiting for a Marshal runtime session</strong>
      <p>The panel will populate when the runtime sends a typed session-sync or lifecycle event.</p>
    </main>
  `;
}

function renderDetails(value: unknown): string {
  return `
    <details>
      <summary>Details</summary>
      <pre>${escapeHtml(stringifyValue(value))}</pre>
    </details>
  `;
}

function stringifyValue(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function statusTone(status: string): string {
  if (status === 'running') return 'running';
  if (status === 'success') return 'success';
  if (status === 'idle') return 'idle';
  return 'error';
}

function formatTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function escapeAttribute(value: string): string {
  return escapeHtml(value);
}

function metadataString(
  artifact: RuntimePanelSession['artifacts'][number],
  key: string,
): string | undefined {
  const value = artifact.metadata?.[key];
  return typeof value === 'string' ? value : undefined;
}
