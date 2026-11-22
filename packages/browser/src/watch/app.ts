/**
 * The `watch` UI application: a side-panel view of a task's tab, live. It runs in Marshal's sandboxed iframe (no
 * network), so it talks only JSON-RPC to the host bridge: it polls `browser.watch.frame` for the newest screencast
 * frame plus the step the engine is on, and its Stop button calls `browser.task.cancel`. Both are declared actions;
 * the bridge refuses any capability that is not. Frames are drawn through createImageBitmap on a canvas, so no image
 * URL (and no CSP image source) is involved. Styles use the host's theme variables, sent in hostContext.
 */

export const WATCH_APPLICATION_ID = 'watch';

const FRAME_ACTION = 'watchFrame';
const CANCEL_ACTION = 'cancelTask';

const HTML = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>Browser · live</title>
<style>
  :root {
    color-scheme: light dark;
    font-family: var(--font-sans, system-ui, sans-serif);
    background: var(--background, Canvas);
    color: var(--foreground, CanvasText);
  }
  * { box-sizing: border-box; }
  [hidden] { display: none !important; }
  body { margin: 0; padding: 12px; display: flex; flex-direction: column; gap: 10px; min-height: 100vh; }
  header { display: flex; align-items: center; gap: 8px; min-width: 0; }
  .badge {
    flex: none; font-size: 12px; font-weight: 600; padding: 2px 8px; border-radius: 999px;
    border: 1px solid var(--border, GrayText); color: var(--muted-foreground, GrayText);
    background: var(--muted, transparent);
  }
  .badge[data-tone="live"] { color: var(--success-fg, var(--success, green)); background: var(--success-bg, transparent); border-color: var(--success-border, currentColor); }
  .badge[data-tone="stopped"] { color: var(--warning-fg, var(--warning, orange)); background: var(--warning-bg, transparent); border-color: var(--warning-border, currentColor); }
  .badge[data-tone="failed"] { color: var(--destructive, red); background: var(--destructive-bg, transparent); border-color: currentColor; }
  .goal { flex: 1; min-width: 0; font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--muted-foreground, GrayText); }
  button {
    flex: none; font: inherit; font-size: 13px; font-weight: 600; cursor: pointer;
    padding: 6px 14px; border-radius: var(--radius, 8px);
    border: 1px solid var(--destructive, red); color: var(--destructive, red); background: transparent;
  }
  button:hover:not(:disabled) { background: var(--destructive-bg, transparent); }
  button:focus-visible { outline: 2px solid var(--ring, Highlight); outline-offset: 2px; }
  button:disabled { cursor: default; opacity: .5; }
  .screen {
    position: relative; width: 100%; aspect-ratio: 16 / 10; overflow: hidden;
    border: 1px solid var(--border, GrayText); border-radius: var(--radius, 8px); background: var(--card, Canvas);
  }
  canvas { display: block; width: 100%; height: 100%; object-fit: contain; }
  .empty { position: absolute; inset: 0; display: grid; place-items: center; font-size: 13px; color: var(--muted-foreground, GrayText); text-align: center; padding: 12px; }
  .step { font-family: var(--font-mono, ui-monospace, monospace); font-size: 12px; line-height: 1.5; overflow-wrap: anywhere; }
  .step .phase { color: var(--muted-foreground, GrayText); }
  .meta { font-size: 12px; color: var(--muted-foreground, GrayText); overflow-wrap: anywhere; }
  body.touch button { min-height: 44px; padding: 10px 18px; font-size: 15px; }
  body.touch .step { font-size: 13px; }
</style>
</head>
<body>
<header>
  <span class="badge" id="badge" role="status" aria-live="polite">connecting</span>
  <span class="goal" id="goal"></span>
  <button type="button" id="stop" hidden>Stop</button>
</header>
<div class="screen" id="screen">
  <canvas id="canvas" role="img" aria-label="Live view of the browser tab"></canvas>
  <div class="empty" id="empty">Waiting for the first frame…</div>
</div>
<div class="step" id="step"></div>
<div class="meta" id="meta"></div>
<script>
(() => {
  const pending = new Map();
  let nextId = 1;
  let closed = false;
  let watchId = null;
  let taskId = null;
  let seq = -1;
  let timer = null;
  let polling = false;
  let failures = 0;
  const $ = (id) => document.getElementById(id);
  const canvas = $('canvas');
  const ctx = canvas.getContext('2d');

  function request(method, params) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      parent.postMessage({ jsonrpc: '2.0', id, method, params }, '*');
    });
  }
  function key() { return crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2); }
  function call(name, args) {
    return request('tools/call', { name, arguments: args, _meta: { idempotencyKey: key() } })
      .then((result) => (result && result.structuredContent ? result.structuredContent.output : result));
  }
  function applyContext(context) {
    if (!context) return;
    if (context.formFactor === 'mobile') document.body.classList.add('touch');
    const variables = context.styles && context.styles.variables;
    if (variables) for (const [name, value] of Object.entries(variables)) {
      if (name.startsWith('--')) document.documentElement.style.setProperty(name, String(value));
    }
    if (context.theme === 'dark' || context.theme === 'light') document.documentElement.style.colorScheme = context.theme;
  }
  function setBadge(text, tone) {
    const badge = $('badge');
    if (badge.textContent !== text) badge.textContent = text;
    badge.dataset.tone = tone;
  }
  function describeStep(state) {
    const s = state.lastStep;
    const phase = state.state === 'running' && state.phase ? state.phase + '…' : '';
    if (!s) return { text: phase ? 'Starting · ' + phase : '', phase: '' };
    const rung = s.rung === 0 ? 'code' : s.rung === 1 ? 'decision' : 'extract';
    const parts = ['Step ' + s.step, s.action, 'rung ' + s.rung + ' (' + rung + ')', s.ms + ' ms'];
    if (typeof s.actMs === 'number') parts.push('act ' + s.actMs + ' ms');
    if (typeof s.confidence === 'number') parts.push('conf ' + s.confidence.toFixed(2));
    if (s.outcome && s.outcome !== 'ok') parts.push(s.outcome);
    return { text: parts.join(' · ') + (s.note ? ' — ' + s.note : ''), phase };
  }
  async function draw(frame) {
    const bytes = Uint8Array.from(atob(frame.data), (c) => c.charCodeAt(0));
    const bitmap = await createImageBitmap(new Blob([bytes], { type: frame.mimeType || 'image/jpeg' }));
    if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      $('screen').style.aspectRatio = bitmap.width + ' / ' + bitmap.height;
    }
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();
    $('empty').hidden = true;
  }
  function render(state) {
    if (state.goal) { $('goal').textContent = state.goal; $('goal').title = state.goal; }
    taskId = state.taskId || null;
    const running = state.state === 'running';
    const status = state.status || (running ? 'running' : 'finished');
    if (running) setBadge(status === 'cancelling' ? 'stopping' : 'live', status === 'cancelling' ? 'stopped' : 'live');
    else setBadge(status, status === 'done' || status === 'open' ? 'live' : status === 'cancelled' || status === 'closed' ? 'stopped' : 'failed');
    const stop = $('stop');
    stop.hidden = !taskId;
    stop.disabled = !running || status === 'cancelling';
    const step = describeStep(state);
    $('step').textContent = step.text + (step.phase && state.lastStep ? '  ·  ' + step.phase : '');
    const meta = [];
    if (typeof state.steps === 'number' && state.steps > 0) meta.push(state.steps + ' actions');
    if (typeof state.elapsedMs === 'number') meta.push(Math.round(state.elapsedMs / 1000) + ' s');
    if (state.streamError) meta.push('no live view: ' + state.streamError);
    $('meta').textContent = meta.join(' · ');
    if (!running && !state.frame && seq < 0) $('empty').textContent = 'The task ended before a frame was shown.';
  }
  async function poll() {
    timer = null;
    if (closed || polling) return;
    if (document.visibilityState === 'hidden') { schedule(1000); return; }
    polling = true;
    try {
      const args = watchId ? (seq >= 0 ? { watchId, since: seq } : { watchId }) : {};
      const state = await call('__FRAME__', args);
      if (state && typeof state.watchId === 'string' && state.watchId !== watchId) {
        // Opened without a watch id: follow the newest watch the extension has.
        watchId = state.watchId;
        seq = -1;
      }
      failures = 0;
      if (!state || state.ok === false) {
        setBadge('ended', 'stopped');
        $('step').textContent = (state && state.error) || 'This watch has ended.';
        $('stop').disabled = true;
        return;
      }
      if (state.frame) { await draw(state.frame); }
      if (typeof state.seq === 'number') seq = state.seq;
      render(state);
      schedule(state.state === 'running' ? 300 : 2000);
    } catch (error) {
      failures += 1;
      if (!closed) {
        setBadge('reconnecting', 'stopped');
        schedule(Math.min(5000, 500 * failures));
      }
    } finally {
      polling = false;
    }
  }
  function schedule(ms) { if (!closed && !timer) timer = setTimeout(poll, ms); }
  $('stop').addEventListener('click', async () => {
    if (!taskId) return;
    const stop = $('stop');
    stop.disabled = true;
    stop.textContent = 'Stopping…';
    try {
      const result = await call('__CANCEL__', { taskId });
      stop.textContent = result && result.ok ? 'Stopped' : 'Stop';
      if (!(result && result.ok)) stop.disabled = false;
    } catch (error) {
      stop.textContent = 'Stop';
      stop.disabled = false;
    }
    if (timer) { clearTimeout(timer); timer = null; }
    poll();
  });
  function onInput(params) {
    const args = (params && params.arguments) || {};
    const state = args.state || {};
    if (typeof state.watchId === 'string' && state.watchId !== watchId) {
      watchId = state.watchId;
      seq = -1;
      if (timer) { clearTimeout(timer); timer = null; }
      poll();
    }
  }
  addEventListener('message', (event) => {
    if (event.source !== parent || !event.data || event.data.jsonrpc !== '2.0') return;
    const message = event.data;
    if (message.id !== undefined && pending.has(message.id)) {
      const entry = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) entry.reject(new Error(message.error.message)); else entry.resolve(message.result);
      return;
    }
    if (message.method === 'ui/notifications/tool-input') onInput(message.params);
    else if (message.method === 'ui/notifications/host-context-changed') applyContext(message.params);
    else if (message.method === 'ui/notifications/teardown') {
      closed = true;
      if (timer) clearTimeout(timer);
      pending.forEach((entry) => entry.reject(new Error('closed')));
      pending.clear();
    }
  });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') schedule(0); });
  request('ui/initialize', { protocolVersion: '2026-01-26', appInfo: { name: 'Browser live view', version: '0.2.0' }, hostChrome: 'compact' })
    .then((result) => {
      applyContext(result && result.hostContext);
      parent.postMessage({ jsonrpc: '2.0', method: 'ui/notifications/initialized', params: {} }, '*');
      // A panel opened with a watch id gets it in tool-input; one opened by hand follows the newest watch.
      setTimeout(() => { if (!watchId) schedule(0); }, 400);
    })
    .catch(() => setBadge('not connected', 'failed'));
})();
</script>
</body>
</html>`;

const FRAME_OUTPUT = {
  type: 'object',
  additionalProperties: true,
} as const;

/** The application object `activate` returns in `uiApplications`. */
export function createWatchApplication(
  capabilities: { readonly frame: string; readonly cancel: string } = {
    frame: 'browser.watch.frame',
    cancel: 'browser.task.cancel',
  },
): Record<string, unknown> {
  const html = HTML.replace('__FRAME__', capabilities.frame).replace(
    '__CANCEL__',
    capabilities.cancel,
  );
  return {
    id: WATCH_APPLICATION_ID,
    title: 'Browser · live',
    description:
      'Live view of a @marshal/browser task or session: the page as it changes, the step the engine is on, and a Stop button.',
    renderId: 'marshal-browser-watch',
    resource: { uri: 'ui://marshal-browser/watch', mimeType: 'text/html', text: html },
    application: {
      version: '1.0.0',
      presentationModes: ['inline', 'fullscreen'],
      tools: [],
      actions: [
        {
          id: FRAME_ACTION,
          version: '1.0.0',
          title: 'Read the newest live frame and step',
          target: { kind: 'capability', capability: capabilities.frame },
          inputSchema: {
            type: 'object',
            additionalProperties: false,
            properties: { watchId: { type: 'string' }, since: { type: 'number' } },
          },
          outputSchema: FRAME_OUTPUT,
          allowedScopes: ['session'],
          requiredPermissions: [],
          risk: 'read',
          idempotency: 'none',
        },
        {
          id: CANCEL_ACTION,
          version: '1.0.0',
          title: 'Stop the task',
          target: { kind: 'capability', capability: capabilities.cancel },
          inputSchema: {
            type: 'object',
            additionalProperties: false,
            required: ['taskId'],
            properties: { taskId: { type: 'string' } },
          },
          outputSchema: FRAME_OUTPUT,
          allowedScopes: ['session'],
          requiredPermissions: [],
          risk: 'write',
          idempotency: 'supported',
        },
      ],
    },
    tags: ['browser', 'live', 'watch'],
    metadata: { 'marshal.ui.viewports': ['mobile', 'desktop'] },
  };
}

/** The panel's HTML with the default capability names, for tests. */
export const WATCH_HTML = String((createWatchApplication()['resource'] as { text: string }).text);
