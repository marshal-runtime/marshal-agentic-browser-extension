/**
 * The `watch` UI application: the live view of a task's or session's tab, in a Marshal panel. It runs in Marshal's
 * sandboxed iframe (no network), so it talks only JSON-RPC to the host bridge:
 *   - it polls `browser.watch.frame` for the newest screencast frame, the page's address and title, when the picture
 *     last changed and whether the person may use the page; each poll carries the picture's size in device pixels, so
 *     frames arrive at exactly the size drawn (src/watch/watches.ts);
 *   - Stop calls `browser.task.cancel`;
 *   - for a session no task drives, on the managed backend, clicks, the wheel, keys and back / forward / reload go to
 *     the page through `browser.watch.input` (refused there for a task, the person's own Chrome or an app).
 * All three are declared actions; the bridge refuses any capability that is not. Frames are drawn on a canvas through
 * createImageBitmap, so no image URL (and no CSP image source) is involved. The layout is a full-height grid that
 * never scrolls: bar, picture (fit to both sides, centered), status line. Styles use the host's theme variables.
 */
import { clientToFrame, containRect } from './geometry.js';

export const WATCH_APPLICATION_ID = 'watch';

const FRAME_ACTION = 'watchFrame';
const CANCEL_ACTION = 'cancelTask';
const INPUT_ACTION = 'watchInput';

const ICON = (paths: string): string =>
  `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;

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
    font-size: 13px;
    background: var(--background, Canvas);
    color: var(--foreground, CanvasText);
    --line: var(--border, color-mix(in oklab, CanvasText 14%, transparent));
    --soft: var(--muted-foreground, GrayText);
  }
  * { box-sizing: border-box; }
  [hidden] { display: none !important; }
  html, body { height: 100%; margin: 0; overflow: hidden; }
  /* A column, not a grid: a hidden row (the task line of a session) must not shift the picture into an auto track. */
  body { display: flex; flex-direction: column; min-width: 0; }
  body > * { flex: none; }
  body > .stage { flex: 1 1 0; }

  .bar { display: flex; align-items: center; gap: 8px; min-width: 0; padding: 7px 10px; border-bottom: 1px solid var(--line); }
  .dot { position: relative; flex: none; width: 8px; height: 8px; border-radius: 50%; background: var(--soft); }
  .dot[data-state="live"] { background: var(--success, #16a34a); }
  .dot[data-state="wait"] { background: var(--warning, #d97706); }
  .dot[data-state="failed"] { background: var(--destructive, #dc2626); }
  .dot::after { content: ""; position: absolute; inset: -3px; border-radius: 50%; border: 2px solid var(--success, #16a34a); opacity: 0; }
  .dot.blip::after {
    @media (prefers-reduced-motion: no-preference) { animation: blip .7s ease-out; }
  }
  @keyframes blip { from { opacity: .55; scale: .6; } to { opacity: 0; scale: 1.6; } }
  .nav { display: flex; gap: 2px; flex: none; }
  .icon {
    display: grid; place-items: center; width: 26px; height: 26px; padding: 0; border: 0; border-radius: calc(var(--radius, 8px) - 2px);
    background: transparent; color: var(--soft); cursor: pointer;
  }
  .icon:hover:not(:disabled) { background: var(--hover, var(--accent, color-mix(in oklab, CanvasText 8%, transparent))); color: var(--foreground, CanvasText); }
  .icon:disabled { opacity: .4; cursor: default; }
  button:focus-visible, .stage:focus-visible { outline: 2px solid var(--ring, Highlight); outline-offset: -2px; }
  .addr { flex: 1; min-width: 0; line-height: 1.3; }
  .title { font-weight: 550; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .url { font-size: 11.5px; color: var(--soft); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .url .host { color: var(--foreground, CanvasText); opacity: .85; }
  .chip {
    flex: none; font-size: 11px; font-weight: 500; padding: 2px 8px; border-radius: 999px; white-space: nowrap;
    border: 1px solid var(--line); color: var(--soft); background: var(--muted, transparent);
  }
  .stop {
    flex: none; font: inherit; font-size: 12px; font-weight: 600; cursor: pointer; padding: 4px 12px;
    border-radius: calc(var(--radius, 8px) - 2px); border: 1px solid var(--destructive, #dc2626);
    color: var(--destructive, #dc2626); background: transparent;
  }
  .stop:hover:not(:disabled) { background: var(--destructive-bg, color-mix(in oklab, var(--destructive, #dc2626) 10%, transparent)); }
  .stop:disabled { opacity: .5; cursor: default; }
  .task { display: flex; align-items: center; gap: 8px; min-width: 0; padding: 6px 10px; border-bottom: 1px solid var(--line); font-size: 12px; }
  .task .label { flex: none; color: var(--soft); }
  .task .goal { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

  .stage { position: relative; min-height: 0; min-width: 0; overflow: hidden; background: var(--muted, color-mix(in oklab, CanvasText 4%, transparent)); }
  .stage[data-interactive="true"] { touch-action: none; }
  canvas {
    position: absolute; display: block; border-radius: 4px; background: var(--card, Canvas);
    box-shadow: 0 0 0 1px var(--line), 0 1px 3px color-mix(in oklab, CanvasText 10%, transparent);
  }
  .empty { position: absolute; inset: 0; display: grid; place-items: center; padding: 16px; text-align: center; color: var(--soft); }
  .ripple {
    position: absolute; width: 22px; height: 22px; margin: -11px 0 0 -11px; border-radius: 50%; pointer-events: none;
    border: 2px solid var(--ring, Highlight); opacity: 0; animation: fade .45s ease-out;
    @media (prefers-reduced-motion: no-preference) { animation: ripple .45s ease-out; }
  }
  @keyframes fade { from { opacity: .8; } to { opacity: 0; } }
  @keyframes ripple { from { opacity: .8; scale: .4; } to { opacity: 0; scale: 1.4; } }
  .note {
    position: absolute; left: 50%; bottom: 12px; translate: -50% 0; max-width: calc(100% - 24px); padding: 6px 12px;
    border-radius: var(--radius, 8px); font-size: 12px; text-align: center;
    background: var(--popover, var(--card, Canvas)); color: var(--popover-foreground, var(--foreground, CanvasText));
    box-shadow: 0 0 0 1px var(--line), 0 4px 14px color-mix(in oklab, CanvasText 14%, transparent);
  }

  .status { display: flex; align-items: center; gap: 10px; min-width: 0; padding: 5px 10px; border-top: 1px solid var(--line); font-size: 11.5px; color: var(--soft); }
  .status .text { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .status .meta { flex: none; font-variant-numeric: tabular-nums; opacity: .8; }
  .more {
    flex: none; font: inherit; font-size: 11px; padding: 1px 7px; border-radius: 999px; cursor: pointer;
    border: 1px solid var(--line); background: transparent; color: var(--soft);
  }
  .more:hover { color: var(--foreground, CanvasText); background: var(--hover, var(--accent, transparent)); }
  .more[aria-expanded="true"] { color: var(--foreground, CanvasText); }
  .details {
    max-height: 35%; overflow: auto; margin: 0; padding: 6px 10px; border-top: 1px solid var(--line);
    font: 11px/1.45 var(--font-mono, ui-monospace, monospace); color: var(--soft); white-space: pre-wrap; overflow-wrap: anywhere;
    background: var(--card, Canvas);
  }
  body.touch .more { min-height: 32px; padding: 4px 12px; font-size: 12.5px; }

  body.touch { font-size: 14px; }
  body.touch .icon { width: 40px; height: 40px; }
  body.touch .stop { min-height: 40px; padding: 8px 16px; font-size: 14px; }
  body.touch .url { font-size: 12.5px; }
  body.touch .status { font-size: 12.5px; padding: 8px 12px; }
  @media (max-width: 380px) { .status .meta { display: none; } }
</style>
</head>
<body>
<header class="bar">
  <span class="dot" id="dot" aria-hidden="true"></span>
  <div class="nav" id="nav" hidden>
    <button type="button" class="icon" id="back" aria-label="Back" title="Back">${ICON('<path d="m12 19-7-7 7-7"/><path d="M19 12H5"/>')}</button>
    <button type="button" class="icon" id="forward" aria-label="Forward" title="Forward">${ICON('<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>')}</button>
    <button type="button" class="icon" id="reload" aria-label="Reload" title="Reload">${ICON('<path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/>')}</button>
  </div>
  <div class="addr">
    <div class="title" id="title">Connecting…</div>
    <div class="url" id="url"><span class="host" id="host"></span><span id="path"></span></div>
  </div>
  <span class="chip" id="mode" hidden></span>
  <button type="button" class="stop" id="stop" hidden>Stop</button>
</header>
<div class="task" id="task" hidden><span class="label">Task</span><span class="goal" id="goal"></span></div>
<main class="stage" id="stage" aria-label="Live view of the page">
  <canvas id="canvas" role="img" aria-label="Live view of the page"></canvas>
  <div class="empty" id="empty">Waiting for the first picture…</div>
  <div class="note" id="note" role="status" hidden></div>
</main>
<pre class="details" id="details" hidden></pre>
<footer class="status">
  <span class="text"><span id="state" role="status" aria-live="polite"></span><span id="age" aria-hidden="true"></span></span>
  <span class="meta" id="meta"></span>
  <button type="button" class="more" id="more" aria-expanded="false" aria-controls="details" hidden>Details</button>
</footer>
<script>
(() => {
  ${containRect.toString()}
  ${clientToFrame.toString()}
  const pending = new Map();
  let nextId = 1;
  let closed = false;
  let watchId = null;
  let taskId = null;
  let seq = -1;
  let timer = null;
  let polling = false;
  let failures = 0;
  let last = null;            // newest poll answer
  let lastOkAt = 0;           // local time of the newest good poll
  let clockSkew = 0;          // extension clock minus local clock
  let frameSize = null;       // {width, height} of the drawn frame
  let picture = { x: 0, y: 0, width: 0, height: 0 };
  let box = { width: 0, height: 0 };
  let view = null;            // the picture box in device pixels, sent once its size settles
  let viewTimer = null;
  let bitmap = null;
  let interactive = false;
  let lastInputAt = 0;
  let noteTimer = null;
  let finalShot = false;      // the picture is the finished task's last picture, not a live frame
  let finalLooks = 0;
  const $ = (id) => document.getElementById(id);
  const stage = $('stage');
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
  function setText(id, text) { const el = $(id); if (el.textContent !== text) el.textContent = text; }
  function note(text) {
    const el = $('note');
    el.textContent = text;
    el.hidden = false;
    clearTimeout(noteTimer);
    noteTimer = setTimeout(() => { el.hidden = true; }, 3500);
  }

  // ---- layout: the picture fits the stage on both sides, centered; the canvas holds exactly its device pixels ----
  function layout() {
    const rect = stage.getBoundingClientRect();
    const pad = rect.width < 360 ? 6 : 10;
    box = { width: Math.max(0, rect.width - pad * 2), height: Math.max(0, rect.height - pad * 2) };
    const size = frameSize || { width: 16, height: 10 };
    const fit = containRect(box.width, box.height, size.width, size.height);
    picture = { x: fit.x + pad, y: fit.y + pad, width: fit.width, height: fit.height };
    Object.assign(canvas.style, { left: picture.x + 'px', top: picture.y + 'px', width: picture.width + 'px', height: picture.height + 'px' });
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(picture.width * dpr));
    const h = Math.max(1, Math.round(picture.height * dpr));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; paint(); }
    // Frames are asked for the whole box (the browser fits them inside it), once the size has settled.
    const wanted = { width: Math.round(box.width * dpr), height: Math.round(box.height * dpr) };
    clearTimeout(viewTimer);
    viewTimer = setTimeout(() => { view = wanted; }, view ? 300 : 0);
  }
  new ResizeObserver(layout).observe(stage);

  function paint() {
    if (!bitmap) return;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  }
  async function draw(frame) {
    const bytes = Uint8Array.from(atob(frame.data), (c) => c.charCodeAt(0));
    let next = await createImageBitmap(new Blob([bytes], { type: frame.mimeType || 'image/jpeg' }));
    const resized = !frameSize || frameSize.width !== next.width || frameSize.height !== next.height;
    frameSize = { width: next.width, height: next.height };
    if (resized) layout();
    // Larger than the canvas (another consumer asked for more): downscale once with the high-quality filter.
    if (next.width > canvas.width * 1.02 || next.height > canvas.height * 1.02) {
      const scaled = await createImageBitmap(next, { resizeWidth: canvas.width, resizeHeight: canvas.height, resizeQuality: 'high' });
      next.close();
      next = scaled;
    }
    if (bitmap) bitmap.close();
    bitmap = next;
    paint();
    $('empty').hidden = true;
    const dot = $('dot');
    dot.classList.remove('blip');
    void dot.offsetWidth;
    dot.classList.add('blip');
  }

  // ---- state and status line ----
  function splitUrl(url) {
    try {
      const u = new URL(url);
      if (u.protocol === 'http:' || u.protocol === 'https:')
        return { host: u.host, rest: (u.pathname === '/' ? '' : u.pathname) + u.search + u.hash };
      return { host: '', rest: url };
    } catch (error) { return { host: '', rest: url || '' }; }
  }
  function ago(ms) {
    const s = Math.max(0, Math.round(ms / 1000));
    if (s < 60) return s + ' s ago';
    const m = Math.round(s / 60);
    return m < 60 ? m + ' min ago' : Math.round(m / 60) + ' h ago';
  }
  // The status line says what the task is doing in plain words (the extension's doing / step say); the engine's own
  // wording (refs, rungs, timings, confidences, plan notes) is behind Details.
  function describeStep(state) {
    const s = state.lastStep;
    return state.doing || (s && s.say) || 'Starting';
  }
  const END = {
    done: 'Done', low_confidence: 'Stopped: not sure the goal was met', needs_owner: 'Needs you to decide',
    needs_input: 'Needs a value from you', blocked: 'Stuck', cancelled: 'Stopped', failed: 'Failed',
    budget: 'Ran out of time', decisions_unavailable: 'Could not reach the model',
  };
  function endText(status) {
    return END[status] || (status.charAt(0).toUpperCase() + status.slice(1)).replace(/_/g, ' ');
  }
  const RUNG = { 0: 'code', 1: 'decision', 2: 'extract' };
  function rawStep(state) {
    const s = state.lastStep;
    if (!s) return '';
    const head = ['Step ' + s.step, s.action, 'rung ' + s.rung + (RUNG[s.rung] ? ' (' + RUNG[s.rung] + ')' : '')];
    if (typeof s.ms === 'number') head.push(s.ms + ' ms');
    if (typeof s.actMs === 'number') head.push('act ' + s.actMs + ' ms');
    if (typeof s.confidence === 'number') head.push('conf ' + s.confidence);
    if (s.outcome) head.push(s.outcome);
    const lines = [head.join(' · ')];
    if (s.note) lines.push(String(s.note));
    if (s.checks) lines.push('goal met ' + s.checks.goalMet + ' · needs owner ' + s.checks.needsOwner + ' · page ready ' + s.checks.pageReady);
    lines.push('phase ' + (state.phase || '?') + ' · ' + (state.steps || 0) + ' actions · ' + Math.round((state.elapsedMs || 0) / 1000) + ' s');
    if (s.url) lines.push(String(s.url));
    return lines.join('\n');
  }
  const VIEW_ONLY = {
    task: ['View only', 'A task is driving this tab. Stop it to use the page yourself.'],
    user: ['Your Chrome · view only', 'This is your own Chrome: use the page there.'],
    app: ['App · view only', 'This is a native app: use it there.'],
    unsupported: ['View only', 'This browser takes no input from the panel.'],
  };
  function render(state) {
    last = state;
    taskId = state.taskId || null;
    const running = state.state === 'running';
    const status = state.status || (running ? 'running' : 'finished');
    // Address bar.
    // A finished task's tab is gone: its last step still says where it ended.
    const url = state.url || (state.lastStep && state.lastStep.url) || '';
    const parts = splitUrl(url);
    setText('title', state.title || parts.host || (state.kind === 'task' ? 'Browser task' : 'Browser session'));
    setText('host', parts.host);
    setText('path', parts.rest);
    $('url').title = url;
    $('title').title = state.title || '';
    canvas.setAttribute('aria-label', 'Live view of ' + (state.title || parts.host || 'the page'));
    // Task row and Stop.
    $('task').hidden = !taskId;
    if (taskId && state.goal) { setText('goal', state.goal); $('goal').title = state.goal; }
    const stop = $('stop');
    stop.hidden = !taskId || !running;
    stop.disabled = !running || status === 'cancelling';
    // Interactive or view only.
    interactive = state.interactive === true && running;
    stage.dataset.interactive = String(interactive);
    stage.tabIndex = interactive ? 0 : -1;
    stage.setAttribute('aria-description', interactive ? 'Click, scroll and type here to use the page. Click outside the picture to leave.' : '');
    $('nav').hidden = !interactive;
    const viewOnly = running && state.viewOnly ? VIEW_ONLY[state.viewOnly] : null;
    const mode = $('mode');
    mode.hidden = !viewOnly || Boolean(taskId);
    if (viewOnly) { setText('mode', viewOnly[0]); mode.title = viewOnly[1]; }
    // Status line.
    let text;
    if (!running) {
      if (state.kind === 'session' && !taskId) text = 'Session closed';
      else text = endText(status) + (state.steps ? ' · ' + state.steps + (state.steps === 1 ? ' action' : ' actions') : '') + (typeof state.elapsedMs === 'number' ? ' in ' + Math.round(state.elapsedMs / 1000) + ' s' : '');
    } else if (taskId) text = status === 'cancelling' ? 'Stopping…' : describeStep(state) + '…';
    else text = 'Live';
    if (state.streamError) text += ' · no picture: ' + state.streamError;
    setText('state', text);
    const raw = taskId ? rawStep(state) : '';
    $('more').hidden = !raw;
    if (!raw) { $('details').hidden = true; $('more').setAttribute('aria-expanded', 'false'); }
    else if ($('details').textContent !== raw) $('details').textContent = raw;
    const meta = [];
    if (finalShot) meta.push('Last picture');
    if (frameSize) meta.push(frameSize.width + '×' + frameSize.height);
    if (typeof state.frameBytes === 'number') meta.push(Math.round(state.frameBytes / 1024) + ' KB');
    setText('meta', meta.join(' · '));
    $('meta').title = typeof state.quality === 'number' ? 'Picture size, JPEG quality ' + state.quality : '';
    if (!running && seq <= 0 && !bitmap) setText('empty', state.kind === 'task' ? 'The task ended before a picture was shown.' : 'The session closed before a picture was shown.');
    tick();
  }
  // The age ticks every second even when nothing arrives, and the dot says whether polls still come back.
  function tick() {
    const dot = $('dot');
    if (!last) { dot.dataset.state = failures ? 'wait' : ''; return; }
    const running = last.state === 'running';
    const fresh = Date.now() - lastOkAt < 4000;
    dot.dataset.state = !fresh && running ? 'wait' : running ? 'live' : '';
    let age = '';
    if (running && !last.taskId && typeof last.lastFrameAt === 'number') {
      const since = Date.now() + clockSkew - last.lastFrameAt;
      age = since < 1500 ? ' · page updating' : ' · page idle, last change ' + ago(since);
    }
    if (!fresh && running) age = ' · reconnecting…';
    setText('age', age);
  }
  setInterval(tick, 1000);

  // ---- polling ----
  async function poll() {
    timer = null;
    if (closed || polling) return;
    if (document.visibilityState === 'hidden') { schedule(1500); return; }
    polling = true;
    try {
      const args = {};
      if (watchId) args.watchId = watchId;
      if (watchId && seq >= 0) args.since = seq;
      if (view && view.width > 0 && view.height > 0) args.view = view;
      const state = await call('__FRAME__', args);
      if (state && typeof state.watchId === 'string' && state.watchId !== watchId) {
        // Opened without a watch id: follow the newest watch the extension has.
        watchId = state.watchId;
        seq = -1;
      }
      failures = 0;
      if (!state || state.ok === false) {
        last = null;
        $('dot').dataset.state = '';
        setText('state', (state && state.error && String(state.error).replace(/^BROWSER_NO_WATCH: /, '')) || 'This watch has ended.');
        setText('age', '');
        $('stop').disabled = true;
        $('nav').hidden = true;
        interactive = false;
        return;
      }
      lastOkAt = Date.now();
      if (typeof state.now === 'number') clockSkew = state.now - Date.now();
      const hadFrame = Boolean(state.frame);
      if (state.frame) { finalShot = state.frame.final === true; await draw(state.frame); }
      if (typeof state.seq === 'number') seq = state.seq;
      render(state);
      const busy = hadFrame || Date.now() - lastInputAt < 3000;
      // A finished task's final screenshot is read from disk on the first poll: look again soon for it.
      schedule(state.state !== 'running' ? (!bitmap && finalLooks++ < 5 ? 400 : 2000) : busy ? 200 : 500);
    } catch (error) {
      failures += 1;
      tick();
      if (!closed) schedule(Math.min(5000, 500 * failures));
    } finally {
      polling = false;
    }
  }
  function schedule(ms) { if (!closed && !timer) timer = setTimeout(poll, ms); }
  function pollSoon() { if (timer) { clearTimeout(timer); timer = null; } schedule(60); }

  // ---- input (sessions on the managed backend only; the extension refuses it otherwise) ----
  const REFUSED = {
    secret_field: 'Password and code fields are not typed from this panel.',
    rate_limited: 'Too fast: a moment, then try again.',
  };
  function dialogNote(dialog) { note('The page opened a ' + dialog.type + ': ' + String(dialog.message || '').slice(0, 120)); }
  async function send(event) {
    if (!interactive || !watchId) return;
    lastInputAt = Date.now();
    try {
      const result = await call('__INPUT__', { watchId, event });
      if (result && result.dialog) dialogNote(result.dialog);
      else if (result && result.ok === false) {
        if (result.status && REFUSED[result.status]) note(REFUSED[result.status]);
        else if (result.status === 'view_only') note((VIEW_ONLY[result.viewOnly] || ['', 'View only.'])[1]);
        else if (result.error) note(String(result.error).replace(/^[a-z_-]+: /, ''));
      }
    } catch (error) {
      note('That did not reach the page.');
    }
    pollSoon();
  }
  function pointOf(event) {
    const rect = stage.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }
  function ripple(at) {
    const el = document.createElement('div');
    el.className = 'ripple';
    el.style.left = at.x + 'px';
    el.style.top = at.y + 'px';
    stage.appendChild(el);
    setTimeout(() => el.remove(), 500);
  }
  canvas.addEventListener('click', (event) => {
    if (!interactive) {
      // Say why nothing happens (a task drives the tab, it is the person's own Chrome, an app).
      const reason = last && VIEW_ONLY[last.viewOnly];
      if (reason) note(reason[1]);
      return;
    }
    stage.focus({ preventScroll: true });
    const at = pointOf(event);
    const n = clientToFrame(at.x, at.y, picture);
    if (!n) return;
    ripple(at);
    flushText();
    send({ kind: 'click', nx: n.nx, ny: n.ny, clickCount: event.detail === 2 ? 2 : 1 });
  });
  // Wheel and touch drags are summed and sent at most every 80 ms.
  let wheel = null;
  let wheelTimer = null;
  function addWheel(at, dx, dy) {
    const n = clientToFrame(at.x, at.y, picture);
    if (!n) return;
    if (!wheel) wheel = { nx: n.nx, ny: n.ny, deltaX: 0, deltaY: 0 };
    wheel.deltaX += dx;
    wheel.deltaY += dy;
    if (!wheelTimer) wheelTimer = setTimeout(() => {
      const event = wheel;
      wheel = null;
      wheelTimer = null;
      if (event && (Math.abs(event.deltaX) >= 1 || Math.abs(event.deltaY) >= 1))
        send({ kind: 'wheel', nx: event.nx, ny: event.ny, deltaX: Math.round(event.deltaX), deltaY: Math.round(event.deltaY) });
    }, 80);
  }
  stage.addEventListener('wheel', (event) => {
    if (!interactive) return;
    event.preventDefault();
    const unit = event.deltaMode === 1 ? 40 : event.deltaMode === 2 ? box.height : 1;
    addWheel(pointOf(event), event.deltaX * unit, event.deltaY * unit);
  }, { passive: false });
  let touch = null;
  stage.addEventListener('pointerdown', (event) => {
    if (interactive && event.pointerType === 'touch') touch = { id: event.pointerId, ...pointOf(event), moved: 0 };
  });
  stage.addEventListener('pointermove', (event) => {
    if (!touch || event.pointerId !== touch.id) return;
    const at = pointOf(event);
    const dx = touch.x - at.x;
    const dy = touch.y - at.y;
    touch.moved += Math.abs(dx) + Math.abs(dy);
    touch.x = at.x;
    touch.y = at.y;
    if (touch.moved > 8) addWheel(at, dx * 2, dy * 2);
  });
  const endTouch = () => { touch = null; };
  stage.addEventListener('pointerup', endTouch);
  stage.addEventListener('pointercancel', endTouch);
  // Keys: named keys as keys, printable characters gathered into short texts. Shortcuts with Cmd/Ctrl stay Marshal's.
  const NAMED = { Enter: 'Enter', Tab: 'Tab', Escape: 'Escape', Backspace: 'Backspace', Delete: 'Delete', ' ': 'Space',
    ArrowUp: 'ArrowUp', ArrowDown: 'ArrowDown', ArrowLeft: 'ArrowLeft', ArrowRight: 'ArrowRight', Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown' };
  let text = '';
  let textTimer = null;
  function flushText() {
    clearTimeout(textTimer);
    textTimer = null;
    if (!text) return;
    const chunk = text;
    text = '';
    send({ kind: 'text', text: chunk });
  }
  stage.addEventListener('keydown', (event) => {
    if (!interactive || event.metaKey || event.ctrlKey || event.isComposing) return;
    const named = NAMED[event.key];
    if (named) {
      event.preventDefault();
      flushText();
      const modifiers = [];
      if (event.shiftKey) modifiers.push('Shift');
      if (event.altKey) modifiers.push('Alt');
      send({ kind: 'key', key: named, modifiers });
      return;
    }
    if (event.key.length === 1 && !event.altKey) {
      event.preventDefault();
      text += event.key;
      if (text.length >= 48) flushText();
      else { clearTimeout(textTimer); textTimer = setTimeout(flushText, 150); }
    }
  });
  stage.addEventListener('blur', flushText);
  // Pasted text goes as printable text too (the same checks: never into a secret field). Line breaks become spaces;
  // a paste is cut at 512 characters and sent in pieces the capability accepts.
  stage.addEventListener('paste', (event) => {
    if (!interactive) return;
    const pasted = (event.clipboardData && event.clipboardData.getData('text/plain')) || '';
    event.preventDefault();
    const clean = pasted.replace(/[\r\n\t]+/g, ' ').replace(/\p{Cc}/gu, '').slice(0, 512);
    flushText();
    for (let at = 0; at < clean.length; at += 64) send({ kind: 'text', text: clean.slice(at, at + 64) });
  });
  $('more').addEventListener('click', () => {
    const open = $('more').getAttribute('aria-expanded') !== 'true';
    $('more').setAttribute('aria-expanded', String(open));
    $('details').hidden = !open;
  });
  for (const kind of ['back', 'forward', 'reload']) $(kind).addEventListener('click', () => send({ kind }));

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
    pollSoon();
  });
  function onInput(params) {
    const args = (params && params.arguments) || {};
    const state = args.state || {};
    if (typeof state.watchId === 'string' && state.watchId !== watchId) {
      watchId = state.watchId;
      seq = -1;
      pollSoon();
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
    else if (message.method === 'ui/notifications/host-context-changed') { applyContext(message.params); layout(); }
    else if (message.method === 'ui/notifications/teardown') {
      closed = true;
      if (timer) clearTimeout(timer);
      pending.forEach((entry) => entry.reject(new Error('closed')));
      pending.clear();
    }
  });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') schedule(0); });
  layout();
  request('ui/initialize', { protocolVersion: '2026-01-26', appInfo: { name: 'Browser live view', version: '0.2.1' }, hostChrome: 'compact' })
    .then((result) => {
      applyContext(result && result.hostContext);
      layout();
      parent.postMessage({ jsonrpc: '2.0', method: 'ui/notifications/initialized', params: {} }, '*');
      // A panel opened with a watch id gets it in tool-input; one opened by hand follows the newest watch.
      setTimeout(() => { if (!watchId) schedule(0); }, 400);
    })
    .catch(() => { setText('state', 'Not connected to Marshal'); $('dot').dataset.state = 'failed'; });
})();
</script>
</body>
</html>`;

const OUTPUT = {
  type: 'object',
  additionalProperties: true,
} as const;

/** The application object `activate` returns in `uiApplications`. */
export function createWatchApplication(
  capabilities: { readonly frame: string; readonly cancel: string; readonly input: string } = {
    frame: 'browser.watch.frame',
    cancel: 'browser.task.cancel',
    input: 'browser.watch.input',
  },
): Record<string, unknown> {
  const html = HTML.replace('__FRAME__', capabilities.frame)
    .replace('__CANCEL__', capabilities.cancel)
    .replace('__INPUT__', capabilities.input);
  return {
    id: WATCH_APPLICATION_ID,
    title: 'Browser · live',
    description:
      'Live view of a @marshal/browser task or session: the page as it changes, its address, the step the engine is on, a Stop button, and for a session no task drives, clicks, scrolling and typing into the page.',
    renderId: 'marshal-browser-watch',
    resource: { uri: 'ui://marshal-browser/watch', mimeType: 'text/html', text: html },
    application: {
      // The host accepts application (and action) version 1.0.0 only: "application.version must be 1.0.0".
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
            properties: {
              watchId: { type: 'string' },
              since: { type: 'number' },
              view: {
                type: 'object',
                additionalProperties: false,
                required: ['width', 'height'],
                properties: { width: { type: 'number' }, height: { type: 'number' } },
              },
            },
          },
          outputSchema: OUTPUT,
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
          outputSchema: OUTPUT,
          allowedScopes: ['session'],
          requiredPermissions: [],
          risk: 'write',
          idempotency: 'supported',
        },
        {
          id: INPUT_ACTION,
          version: '1.0.0',
          title: 'Click, scroll or type in the watched page',
          target: { kind: 'capability', capability: capabilities.input },
          inputSchema: {
            type: 'object',
            additionalProperties: false,
            required: ['watchId', 'event'],
            properties: { watchId: { type: 'string' }, event: { type: 'object' } },
          },
          outputSchema: OUTPUT,
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
