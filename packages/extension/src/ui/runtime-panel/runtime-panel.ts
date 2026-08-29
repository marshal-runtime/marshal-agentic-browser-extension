import {
  RuntimePanelClient,
  createRuntimePanelState,
  isRuntimePanelBrowserCommand,
  renderRuntimePanel,
  type RuntimePanelBrowserCommandRequest,
  type RuntimePanelSession,
  type RuntimePanelState,
} from '@marshal/runtime-browser-panel';
import { createChromeRuntimePanelTransport } from '../../runtime-panel/chrome-transport.js';
import './runtime-panel.css';

const rootElement = document.querySelector<HTMLElement>('#runtime-panel-root');
if (!rootElement) {
  throw new Error('Marshal runtime panel root element was not found');
}
const root: HTMLElement = rootElement;

const client = new RuntimePanelClient(createChromeRuntimePanelTransport());
let state: RuntimePanelState = createRuntimePanelState();
let clientError: string | undefined;

function render(): void {
  root.innerHTML = renderRuntimePanel(state, { clientError });
}

function selectedSession(): RuntimePanelSession | undefined {
  return state.selectedSessionId ? state.sessions[state.selectedSessionId] : undefined;
}

async function run(action: () => Promise<RuntimePanelState>): Promise<void> {
  clientError = undefined;
  try {
    state = await action();
  } catch (error: unknown) {
    clientError = error instanceof Error ? error.message : String(error);
  }
  render();
}

async function executeBrowserCommand(
  request: Omit<RuntimePanelBrowserCommandRequest, 'sessionId'>,
): Promise<RuntimePanelState> {
  const session = selectedSession();
  if (!session) {
    throw new Error('No Marshal runtime session is selected');
  }
  const result = await client.executeBrowserCommand({
    ...request,
    sessionId: session.sessionId,
  });
  return result.state;
}

root.addEventListener('click', (event) => {
  const target = event.target;
  if (!(target instanceof Element)) {
    return;
  }
  const button = target.closest<HTMLButtonElement>('button[data-action]');
  if (!button || button.disabled) {
    return;
  }

  const action = button.dataset['action'];
  if (action === 'select-session') {
    const sessionId = button.dataset['sessionId'];
    if (sessionId) {
      void run(() => client.selectSession(sessionId));
    }
    return;
  }

  const session = selectedSession();
  if (!session) {
    return;
  }

  if (action === 'browser-command') {
    const command = button.dataset['command'];
    if (isRuntimePanelBrowserCommand(command)) {
      void run(() =>
        executeBrowserCommand({
          command,
          tabId: session.activeTabId,
          params: command === 'reload' ? { hard: false } : {},
        }),
      );
    }
  } else if (action === 'switch-tab') {
    const tabId = Number(button.dataset['tabId']);
    if (Number.isInteger(tabId)) {
      void run(() => executeBrowserCommand({ command: 'switchTab', tabId }));
    }
  } else if (action === 'new-tab') {
    void run(() => executeBrowserCommand({ command: 'createTab', params: { active: true } }));
  } else if (action === 'capture-screenshot') {
    const activeTab = session.tabs.find((tab) => tab.tabId === session.activeTabId);
    void run(() =>
      executeBrowserCommand({
        command: 'captureScreenshot',
        tabId: session.activeTabId,
        params: { format: 'png', url: activeTab?.url },
      }),
    );
  } else if (action === 'capture-html') {
    const activeTab = session.tabs.find((tab) => tab.tabId === session.activeTabId);
    void run(() =>
      executeBrowserCommand({
        command: 'getHTML',
        tabId: session.activeTabId,
        params: { url: activeTab?.url },
      }),
    );
  } else if (action === 'restore-session') {
    void run(async () => (await client.restoreSession({ sessionId: session.sessionId })).state);
  } else if (action === 'cleanup-session') {
    void run(() => client.cleanupSession({ sessionId: session.sessionId }));
  }
});

root.addEventListener('submit', (event) => {
  const form = event.target;
  if (!(form instanceof HTMLFormElement) || form.dataset['action'] !== 'navigate') {
    return;
  }
  event.preventDefault();
  const data = new FormData(form);
  const url = data.get('url');
  if (typeof url !== 'string' || url.trim() === '') {
    clientError = 'Enter a URL to navigate';
    render();
    return;
  }
  const session = selectedSession();
  void run(() =>
    executeBrowserCommand({
      command: 'navigate',
      tabId: session?.activeTabId,
      params: { url: url.trim() },
    }),
  );
});

const unsubscribe = client.subscribeState((nextState) => {
  state = nextState;
  clientError = undefined;
  render();
});

window.addEventListener(
  'pagehide',
  () => {
    unsubscribe();
  },
  { once: true },
);

render();
void run(() => client.getState());
