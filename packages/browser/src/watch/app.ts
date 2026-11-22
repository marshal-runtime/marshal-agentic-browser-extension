/**
 * The `watch` UI application: the live view of a task's or session's tab, in a Marshal panel. It runs in Marshal's
 * sandboxed iframe (no network), so it talks only JSON-RPC to the host bridge:
 *   - it polls `browser.watch.frame` for the newest picture, the page's address and title, whether it is loading and
 *     whether the person may use the page; each poll carries the pane's size in device pixels and its pixel ratio, so
 *     a tab this extension started takes the pane's own size (a browser pane, not a shrunken desktop window) and
 *     frames arrive at exactly the size drawn (src/watch/watches.ts);
 *   - Stop calls `browser.task.cancel`;
 *   - for a session no task drives, on the managed backend, clicks, the wheel, keys, back / forward / reload and a
 *     typed address go to the page through `browser.watch.input` (refused there for a task, the person's own Chrome
 *     or an app).
 * All three are declared actions; the bridge refuses any capability that is not. Frames are drawn on a canvas through
 * createImageBitmap, so no image URL (and no CSP image source) is involved. The layout never scrolls: a browser
 * toolbar (back, forward, reload, address, who drives the page), then the page edge to edge; a running task floats
 * over the page as one line with Stop. Styles use the host's theme variables.
 */
import { clientToFrame, containRect } from './geometry.js';

export const WATCH_APPLICATION_ID = 'watch';

const FRAME_ACTION = 'watchFrame';
const CANCEL_ACTION = 'cancelTask';
const INPUT_ACTION = 'watchInput';

const ICON = (paths: string, size = 16, extra = ''): string =>
  `<svg viewBox="0 0 24 24" width="${String(size)}" height="${String(size)}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"${extra}>${paths}</svg>`;

const PATHS = {
  back: '<path d="m12 19-7-7 7-7"/><path d="M19 12H5"/>',
  forward: '<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>',
  reload: '<path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/>',
  lock: '<rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  unlocked:
    '<rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/>',
  globe:
    '<circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/>',
  fit: '<path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M21 8V5a2 2 0 0 0-2-2h-3"/><path d="M3 16v3a2 2 0 0 0 2 2h3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  alert: '<circle cx="12" cy="12" r="10"/><path d="M12 8v4"/><path d="M12 16h.01"/>',
  pointer:
    '<path d="M4.037 4.688a.495.495 0 0 1 .651-.651l16 6.5a.5.5 0 0 1-.063.947l-6.124 1.58a2 2 0 0 0-1.438 1.435l-1.579 6.126a.5.5 0 0 1-.947.063z"/>',
} as const;

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
    --bg: var(--background-base, var(--background, Canvas));
    --fg: var(--foreground, CanvasText);
    --line: var(--border, color-mix(in oklab, CanvasText 12%, transparent));
    --soft: var(--muted-foreground, GrayText);
    --chrome: var(--card, Canvas);
    --field: var(--muted-base, var(--muted, color-mix(in oklab, CanvasText 6%, transparent)));
    --pop: var(--popover, var(--card, Canvas));
    --agent: var(--ring, #5b47d6);
    --ok: var(--success, #16a34a);
    --warn: var(--warning, #d97706);
    --bad: var(--destructive, #dc2626);
    --bar-h: 44px;
    background: var(--bg);
    color: var(--fg);
  }
  * { box-sizing: border-box; }
  [hidden] { display: none !important; }
  html, body { height: 100%; margin: 0; overflow: hidden; }
  /* A column: the toolbar, then the page, which takes every pixel that is left. */
  body { display: flex; flex-direction: column; min-width: 0; }
  button { font: inherit; }
  button:focus-visible, input:focus-visible { outline: 2px solid var(--agent); outline-offset: 1px; }

  /* ---- toolbar ---- */
  .bar {
    position: relative; flex: none; display: flex; align-items: center; gap: 6px; min-width: 0;
    height: var(--bar-h); padding: 0 8px; background: var(--chrome); border-bottom: 1px solid var(--line);
  }
  .nav { display: flex; gap: 1px; flex: none; }
  .icon {
    display: grid; place-items: center; flex: none; width: 28px; height: 28px; padding: 0; border: 0; border-radius: 8px;
    background: transparent; color: var(--soft); cursor: pointer;
    transition: background-color .12s ease, color .12s ease, scale .12s ease;
  }
  .icon:hover:not(:disabled) { background: var(--hover, color-mix(in oklab, var(--fg) 8%, transparent)); color: var(--fg); }
  .icon:active:not(:disabled) { scale: .92; }
  .icon:disabled { opacity: .32; cursor: default; }
  .icon[aria-pressed="true"] { color: var(--fg); }
  .icon.turn svg { @media (prefers-reduced-motion: no-preference) { animation: turn .5s ease-out; } }
  @keyframes turn { to { rotate: 360deg; } }

  .omni {
    position: relative; flex: 1; min-width: 0; height: 30px; margin: 0; display: flex; align-items: center;
    border-radius: 999px; background: var(--field); border: 1px solid transparent;
    transition: border-color .12s ease, background-color .12s ease, box-shadow .12s ease;
  }
  .omni:hover { border-color: var(--line); }
  .omni:focus-within {
    background: var(--chrome); border-color: color-mix(in oklab, var(--agent) 65%, transparent);
    box-shadow: 0 0 0 3px color-mix(in oklab, var(--agent) 16%, transparent);
  }
  .lead { flex: none; display: grid; place-items: center; width: 31px; padding-left: 3px; color: var(--soft); }
  .lead svg { display: none; }
  .omni[data-scheme="https"] .i-lock, .omni[data-scheme="http"] .i-open, .omni[data-scheme=""] .i-globe { display: block; }
  .omni[data-scheme="http"] .lead { color: var(--warn); }
  .shown {
    position: absolute; left: 31px; right: 12px; top: 0; bottom: 0; display: flex; align-items: center; min-width: 0;
    pointer-events: none; white-space: nowrap; overflow: hidden;
  }
  .shown .host { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; font-weight: 500; }
  .shown .path { flex: 1 1 0; min-width: 0; overflow: hidden; text-overflow: ellipsis; color: var(--soft); }
  .omni input {
    flex: 1; min-width: 0; height: 100%; padding: 0 12px 0 0; border: 0; outline: 0; background: transparent;
    font: inherit; color: transparent; caret-color: var(--fg);
  }
  .omni input::placeholder { color: var(--soft); opacity: 1; }
  .omni input::selection { background: color-mix(in oklab, var(--agent) 28%, transparent); }
  .omni input:read-only { cursor: default; }
  .omni:focus-within input { color: var(--fg); }
  .omni:focus-within .shown { visibility: hidden; }

  .badge {
    flex: none; display: inline-flex; align-items: center; gap: 6px; height: 24px; padding: 0 9px 0 8px; border-radius: 999px;
    font-size: 11.5px; font-weight: 500; white-space: nowrap; color: var(--soft); border: 1px solid var(--line); cursor: default;
    transition: color .2s ease, background-color .2s ease, border-color .2s ease;
  }
  .dot { position: relative; flex: none; width: 7px; height: 7px; border-radius: 50%; background: currentColor; opacity: .7; }
  .dot::after { content: ""; position: absolute; inset: -3px; border-radius: 50%; border: 1.5px solid currentColor; opacity: 0; }
  .badge[data-state="live"] .dot { background: var(--ok); color: var(--ok); opacity: 1; }
  .badge[data-state="wait"] .dot { background: var(--warn); opacity: 1; }
  .badge[data-state="failed"] .dot { background: var(--bad); opacity: 1; }
  .badge[data-state="agent"] {
    color: var(--agent); border-color: color-mix(in oklab, var(--agent) 32%, transparent);
    background: color-mix(in oklab, var(--agent) 9%, transparent);
  }
  .badge[data-state="agent"] .dot { opacity: 1; }
  @media (prefers-reduced-motion: no-preference) {
    .dot.blip::after { animation: blip .7s ease-out; }
    .badge[data-state="agent"] .dot::after { animation: blip 1.5s ease-out infinite; }
  }
  @keyframes blip { from { opacity: .6; scale: .6; } to { opacity: 0; scale: 1.7; } }
  .size {
    flex: none; height: 24px; display: inline-flex; align-items: center; padding: 0 8px; border-radius: 999px; font-size: 11px;
    font-variant-numeric: tabular-nums; color: var(--soft); background: var(--field); white-space: nowrap;
  }
  .progress { position: absolute; left: 0; right: 0; bottom: -1px; height: 2px; overflow: hidden; pointer-events: none; }
  .progress::before {
    content: ""; position: absolute; inset: 0; width: 100%; opacity: .7; border-radius: 2px;
    background: linear-gradient(90deg, transparent, var(--agent), transparent);
    @media (prefers-reduced-motion: no-preference) { width: 45%; opacity: 1; animation: slide 1.05s cubic-bezier(.4, 0, .2, 1) infinite; }
  }
  @keyframes slide { from { translate: -100% 0; } to { translate: 230% 0; } }

  /* ---- the page ---- */
  .stage { position: relative; flex: 1 1 0; min-height: 0; min-width: 0; overflow: hidden; background: var(--bg); outline: 0; }
  .stage[data-interactive="true"] { touch-action: none; }
  /* A page that keeps its own size (a phone the caller asked for, the standard desktop size) sits on a quiet grid. */
  .stage[data-fit="false"] {
    background-color: var(--field);
    background-image: radial-gradient(color-mix(in oklab, var(--fg) 10%, transparent) 1px, transparent 1px);
    background-size: 16px 16px;
  }
  canvas { position: absolute; display: block; background: var(--chrome); }
  .stage[data-fit="false"] canvas {
    border-radius: 10px;
    box-shadow: 0 0 0 1px var(--line), 0 12px 34px -10px color-mix(in oklab, CanvasText 34%, transparent);
  }
  .stage:focus::after {
    content: ""; position: absolute; inset: 0; pointer-events: none; z-index: 2;
    box-shadow: inset 0 0 0 2px color-mix(in oklab, var(--agent) 45%, transparent);
  }
  .glow {
    position: absolute; inset: 0; pointer-events: none; z-index: 2;
    box-shadow: inset 0 0 0 2px color-mix(in oklab, var(--agent) 75%, transparent), inset 0 0 34px color-mix(in oklab, var(--agent) 24%, transparent);
    @media (prefers-reduced-motion: no-preference) { animation: breathe 2.6s ease-in-out infinite; }
  }
  @keyframes breathe { 50% { opacity: .5; } }
  .cursor {
    position: absolute; left: 0; top: 0; width: 22px; height: 22px; margin: -4px 0 0 -4px; pointer-events: none; z-index: 3;
    color: var(--agent); filter: drop-shadow(0 2px 5px rgb(0 0 0 / .35)); opacity: 0;
    transition: translate .42s cubic-bezier(.2, .8, .2, 1), opacity .25s ease;
    @media (prefers-reduced-motion: reduce) { transition: opacity .25s ease; }
  }
  .cursor[data-on="true"] { opacity: 1; }
  .cursor svg { display: block; fill: currentColor; stroke: #fff; stroke-width: 1.6; }
  .ripple {
    position: absolute; width: 26px; height: 26px; margin: -13px 0 0 -13px; border-radius: 50%; pointer-events: none; z-index: 3;
    border: 2px solid var(--agent); opacity: 0; animation: fade .5s ease-out;
    @media (prefers-reduced-motion: no-preference) { animation: ripple .5s ease-out; }
  }
  @keyframes fade { from { opacity: .8; } to { opacity: 0; } }
  @keyframes ripple { from { opacity: .85; scale: .35; } to { opacity: 0; scale: 1.5; } }

  .empty { position: absolute; inset: 0; z-index: 1; display: grid; place-items: center; padding: 24px; text-align: center; color: var(--soft); }
  .empty[data-over="true"] { background: color-mix(in oklab, var(--bg) 66%, transparent); backdrop-filter: saturate(.5) blur(1.5px); }
  .empty .box { display: grid; gap: 9px; justify-items: center; max-width: 300px; }
  .empty[data-over="true"] .box {
    padding: 18px 22px; border-radius: 16px; background: var(--pop);
    box-shadow: 0 0 0 1px var(--line), 0 14px 40px -12px rgb(0 0 0 / .35);
  }
  .glyph {
    width: 42px; height: 42px; border-radius: 13px; display: grid; place-items: center; color: var(--agent);
    background: color-mix(in oklab, var(--agent) 11%, transparent);
  }
  .empty[data-busy="true"] .glyph svg { display: none; }
  .empty:not([data-busy="true"]) .glyph .ring { display: none; }
  .ring, .spin {
    width: 16px; height: 16px; border-radius: 50%; border: 2px solid color-mix(in oklab, var(--agent) 25%, transparent);
    border-top-color: var(--agent);
    @media (prefers-reduced-motion: no-preference) { animation: turn .8s linear infinite; }
  }
  .empty .head { color: var(--fg); font-weight: 600; font-size: 14px; }
  .empty .sub { font-size: 12.5px; line-height: 1.45; text-wrap: balance; }
  .empty .sub:empty { display: none; }

  .note {
    position: absolute; left: 50%; top: 12px; translate: -50% 0; z-index: 5; max-width: calc(100% - 24px); padding: 7px 13px;
    border-radius: 11px; font-size: 12px; text-align: center; background: var(--pop); color: var(--popover-foreground, var(--fg));
    box-shadow: 0 0 0 1px var(--line), 0 10px 28px -8px rgb(0 0 0 / .3);
    @media (prefers-reduced-motion: no-preference) { animation: drop .18s ease-out; }
  }
  @keyframes drop { from { opacity: 0; translate: -50% -6px; } }

  /* ---- the task: what the agent is doing, floating over the page ---- */
  .hud {
    position: absolute; left: 50%; bottom: 14px; translate: -50% 0; z-index: 4; width: max-content; min-width: min(260px, calc(100% - 24px));
    max-width: min(640px, calc(100% - 24px)); border-radius: 17px; overflow: hidden; color: var(--popover-foreground, var(--fg));
    background: color-mix(in oklab, var(--pop) 84%, transparent); backdrop-filter: blur(16px) saturate(1.5);
    box-shadow: 0 0 0 1px color-mix(in oklab, var(--fg) 11%, transparent), 0 14px 40px -10px rgb(0 0 0 / .4);
  }
  .hud[data-open="true"] { width: min(640px, calc(100% - 24px)); }
  .hud .row { display: flex; align-items: center; gap: 9px; min-width: 0; min-height: 40px; padding: 7px 7px 7px 13px; }
  .hud .mark { flex: none; display: none; width: 16px; height: 16px; }
  .hud[data-state="done"] .mark.ok, .hud[data-state="ended"] .mark.warned { display: block; }
  .hud .mark.ok { color: var(--ok); }
  .hud .mark.warned { color: var(--warn); }
  .hud:not([data-state="running"]) .spin { display: none; }
  .spin { flex: none; }
  .say { flex: 1 1 auto; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-weight: 550; }
  .count { flex: none; color: var(--soft); font-size: 11.5px; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .more, .stop { flex: none; height: 26px; border-radius: 999px; cursor: pointer; font-size: 12px; transition: background-color .12s ease, color .12s ease, scale .12s ease; }
  .more { padding: 0 10px; border: 1px solid var(--line); background: transparent; color: var(--soft); }
  .more:hover, .more[aria-expanded="true"] { color: var(--fg); background: var(--hover, color-mix(in oklab, var(--fg) 7%, transparent)); }
  .stop { padding: 0 13px; border: 0; font-weight: 600; color: #fff; background: var(--bad); }
  .stop:hover:not(:disabled) { background: color-mix(in oklab, var(--bad) 86%, #000); }
  .stop:active:not(:disabled) { scale: .95; }
  .stop:disabled { opacity: .55; cursor: default; }
  .goal { padding: 1px 13px 9px; font-size: 12px; line-height: 1.45; color: var(--soft); overflow-wrap: anywhere; max-height: 6em; overflow: auto; }
  .goal b { font-weight: 550; color: var(--fg); }
  .details {
    margin: 0; padding: 9px 13px; border-top: 1px solid var(--line); max-height: 30vh; overflow: auto;
    font: 11px/1.5 var(--font-mono, ui-monospace, monospace); color: var(--soft); white-space: pre-wrap; overflow-wrap: anywhere;
  }

  body.touch { font-size: 14px; --bar-h: 52px; }
  body.touch .icon { width: 40px; height: 40px; }
  body.touch .omni { height: 38px; }
  body.touch .more, body.touch .stop { height: 36px; padding: 0 15px; font-size: 13.5px; }
  @media (max-width: 430px) { .badge .label { display: none; } .badge { padding: 0 8px; } #forward { display: none; } }
  @media (max-width: 330px) { .count { display: none; } }
</style>
</head>
<body>
<header class="bar">
  <div class="nav" id="nav" hidden>
    <button type="button" class="icon" id="back" aria-label="Back" title="Back">${ICON(PATHS.back)}</button>
    <button type="button" class="icon" id="forward" aria-label="Forward" title="Forward">${ICON(PATHS.forward)}</button>
    <button type="button" class="icon" id="reload" aria-label="Reload" title="Reload">${ICON(PATHS.reload, 15)}</button>
  </div>
  <div class="omni" id="omni" data-scheme="" role="search">
    <span class="lead" aria-hidden="true">${ICON(PATHS.lock, 13, ' class="i-lock"')}${ICON(PATHS.unlocked, 13, ' class="i-open"')}${ICON(PATHS.globe, 14, ' class="i-globe"')}</span>
    <div class="shown" id="url" aria-hidden="true"><span class="host" id="host"></span><span class="path" id="path"></span></div>
    <input id="address" type="text" inputmode="url" enterkeyhint="go" autocomplete="off" autocapitalize="off" spellcheck="false" aria-label="Address" placeholder="Connecting…" readonly>
  </div>
  <span class="size" id="size" hidden></span>
  <button type="button" class="icon" id="fit" aria-label="Fit the page to this panel" aria-pressed="true" hidden>${ICON(PATHS.fit, 15)}</button>
  <span class="badge" id="badge" data-state=""><span class="dot" id="dot" aria-hidden="true"></span><span class="label" id="live">Connecting</span></span>
  <div class="progress" id="progress" hidden></div>
</header>
<main class="stage" id="stage" data-fit="true" aria-label="Live view of the page">
  <canvas id="canvas" role="img" aria-label="Live view of the page"></canvas>
  <div class="glow" id="glow" hidden></div>
  <div class="cursor" id="cursor" aria-hidden="true">${ICON(PATHS.pointer, 22)}</div>
  <div class="empty" id="empty" data-busy="true">
    <div class="box">
      <div class="glyph"><span class="ring"></span>${ICON(PATHS.globe, 20)}</div>
      <div class="head" id="emptyHead">Starting the browser…</div>
      <div class="sub" id="emptySub"></div>
    </div>
  </div>
  <div class="note" id="note" role="status" hidden></div>
  <section class="hud" id="hud" data-state="running" aria-label="Task" hidden>
    <div class="row">
      <span class="spin" aria-hidden="true"></span>
      ${ICON(PATHS.check, 16, ' class="mark ok"')}${ICON(PATHS.alert, 16, ' class="mark warned"')}
      <span class="say" id="state" role="status" aria-live="polite"></span>
      <span class="count" id="count"></span>
      <button type="button" class="more" id="more" aria-expanded="false" aria-controls="details" hidden>Details</button>
      <button type="button" class="stop" id="stop" hidden>Stop</button>
    </div>
    <div class="goal" id="goal" hidden></div>
    <pre class="details" id="details" hidden></pre>
  </section>
</main>
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
  let frameSize = null;       // {width, height} of the drawn frame, in its own pixels
  let picture = { x: 0, y: 0, width: 0, height: 0 }; // where the frame is drawn, in the stage's CSS pixels
  let view = null;            // what this panel tells the extension about itself, sent once its size settles
  let viewTimer = null;
  let bitmap = null;
  let interactive = false;
  let lastInputAt = 0;
  let lastPictureAt = 0;      // local time a new picture last arrived
  let noteTimer = null;
  let finalShot = false;      // the picture is the finished task's last picture, not a live frame
  let sharp = false;          // the picture is a still at the page's own pixels
  let finalLooks = 0;
  let pageFit = false;        // the page has this panel's size: it is drawn edge to edge
  let fitWanted = true;       // the person's choice: the page follows the panel (else the standard desktop size, scaled)
  let pointerAt = 0;
  let cursorTimer = null;
  let navigatingUntil = 0;    // the loading line shows at once after the person navigates
  let editing = false;        // the address field has focus
  const viewer = 'p-' + Math.random().toString(36).slice(2, 12);
  const $ = (id) => document.getElementById(id);
  const stage = $('stage');
  const canvas = $('canvas');
  const ctx = canvas.getContext('2d');
  const address = $('address');
  try { fitWanted = localStorage.getItem('fit') !== 'off'; } catch (error) { /* no storage in this frame */ }

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
  function empty(head, sub, busy, over) {
    const el = $('empty');
    if (head === null) { el.hidden = true; return; }
    el.hidden = false;
    el.dataset.busy = String(Boolean(busy));
    el.dataset.over = String(Boolean(over));
    setText('emptyHead', head);
    setText('emptySub', sub || '');
  }

  // ---- layout ----
  // A page sized to this panel is drawn edge to edge from the top left, pixel for pixel. A page that keeps its own
  // size (the caller's phone size, the standard desktop size, the person's own Chrome) is fit inside with a margin,
  // never larger than the page itself. Every edge sits on a whole device pixel, so the picture is never resampled.
  function layout() {
    const dpr = window.devicePixelRatio || 1;
    const snap = (css) => Math.round(css * dpr) / dpr;
    const bar = document.body.classList.contains('touch') ? 52 : 44;
    document.documentElement.style.setProperty('--bar-h', snap(bar) + 'px');
    const rect = stage.getBoundingClientRect();
    const full = { width: Math.floor(rect.width * dpr), height: Math.floor(rect.height * dpr) };
    const pad = rect.width < 360 ? 8 : 16;
    const inner = { width: Math.max(0, Math.floor((rect.width - pad * 2) * dpr)), height: Math.max(0, Math.floor((rect.height - pad * 2) * dpr)) };
    stage.dataset.fit = String(pageFit || !frameSize);
    if (frameSize && full.width > 0 && full.height > 0) {
      let device;
      if (pageFit) {
        let scale = Math.min(full.width / frameSize.width, full.height / frameSize.height);
        // The frame is the page's own pixels (or half of them on a dense screen while it moves): draw it exactly.
        if (Math.abs(scale - 1) < 0.02) scale = 1; else if (Math.abs(scale - 2) < 0.04) scale = 2;
        device = { x: 0, y: 0, width: Math.min(full.width, Math.round(frameSize.width * scale)), height: Math.min(full.height, Math.round(frameSize.height * scale)) };
      } else {
        const page = last && last.page;
        const limit = page ? { width: Math.round(page.width * dpr), height: Math.round(page.height * dpr) } : inner;
        const box = { width: Math.min(inner.width, limit.width), height: Math.min(inner.height, limit.height) };
        const fitted = containRect(box.width, box.height, frameSize.width, frameSize.height);
        device = { x: Math.round((full.width - fitted.width) / 2), y: Math.round((full.height - fitted.height) / 2), width: fitted.width, height: fitted.height };
      }
      picture = { x: device.x / dpr, y: device.y / dpr, width: device.width / dpr, height: device.height / dpr };
      Object.assign(canvas.style, { left: picture.x + 'px', top: picture.y + 'px', width: picture.width + 'px', height: picture.height + 'px' });
      if (canvas.width !== device.width || canvas.height !== device.height) { canvas.width = Math.max(1, device.width); canvas.height = Math.max(1, device.height); paint(); }
    }
    // What the extension is told: the whole pane when the page should follow it, else the room a fitted picture has.
    const follow = fitWanted && !(last && last.page && last.page.pinned);
    const area = follow ? full : inner;
    const wanted = { width: area.width, height: area.height, dpr: Math.round(dpr * 1000) / 1000, fit: follow, viewer };
    clearTimeout(viewTimer);
    viewTimer = setTimeout(() => { if (wanted.width > 0 && wanted.height > 0) view = wanted; }, view && view.fit === wanted.fit ? 250 : 0);
  }
  new ResizeObserver(layout).observe(stage);

  function paint() {
    if (!bitmap) return;
    const exact = bitmap.width === canvas.width && bitmap.height === canvas.height;
    ctx.imageSmoothingEnabled = !exact;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  }
  async function draw(frame) {
    const bytes = Uint8Array.from(atob(frame.data), (c) => c.charCodeAt(0));
    let next = await createImageBitmap(new Blob([bytes], { type: frame.mimeType || 'image/jpeg' }));
    const resized = !frameSize || frameSize.width !== next.width || frameSize.height !== next.height;
    frameSize = { width: next.width, height: next.height };
    if (resized) layout();
    // Larger than the canvas (a page that keeps its own size, in a smaller pane): downscale once with the good filter.
    if (next.width > canvas.width * 1.02 || next.height > canvas.height * 1.02) {
      const scaled = await createImageBitmap(next, { resizeWidth: canvas.width, resizeHeight: canvas.height, resizeQuality: 'high' });
      next.close();
      next = scaled;
    }
    if (bitmap) bitmap.close();
    bitmap = next;
    paint();
    const dot = $('dot');
    dot.classList.remove('blip');
    void dot.offsetWidth;
    dot.classList.add('blip');
  }

  // ---- words ----
  function splitUrl(url) {
    try {
      const u = new URL(url);
      if (u.protocol === 'http:' || u.protocol === 'https:')
        return { scheme: u.protocol.slice(0, -1), host: u.host, rest: (u.pathname === '/' ? '' : u.pathname) + u.search + u.hash };
      return { scheme: '', host: '', rest: url };
    } catch (error) { return { scheme: '', host: '', rest: url || '' }; }
  }
  function ago(ms) {
    const s = Math.max(0, Math.round(ms / 1000));
    if (s < 60) return s + ' s ago';
    const m = Math.round(s / 60);
    return m < 60 ? m + ' min ago' : Math.round(m / 60) + ' h ago';
  }
  function clock(ms) {
    const s = Math.max(0, Math.round(ms / 1000));
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  }
  // The task line says what the task is doing in plain words (the extension's doing / step say); the engine's own
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
  const ENDED_SHOWN_MS = 20000;
  const VIEW_ONLY = {
    task: ['Agent working', 'The agent is driving this tab. Stop it to use the page yourself.'],
    user: ['Your Chrome', 'This is your own Chrome: use the page there.'],
    app: ['App', 'This is a native app: use it there.'],
    unsupported: ['View only', 'This browser takes no input from the panel.'],
  };

  // ---- what the newest answer shows ----
  function render(state) {
    last = state;
    taskId = state.taskId || null;
    const running = state.state === 'running';
    const status = state.status || (running ? 'running' : 'finished');
    const managed = state.backend === 'managed';
    interactive = state.interactive === true && running;
    const wasFit = pageFit;
    pageFit = Boolean(state.page && state.page.fit) && running;
    if (wasFit !== pageFit) layout();

    // Address field. A finished task's tab is gone: its last step still says where it ended.
    const url = state.url || (state.lastStep && state.lastStep.url) || '';
    const parts = splitUrl(url);
    $('omni').dataset.scheme = parts.scheme;
    setText('host', parts.host);
    setText('path', parts.rest);
    if (!editing && address.value !== url) address.value = url;
    address.readOnly = !interactive;
    address.placeholder = interactive ? 'Type a web address' : running ? 'Opening…' : '';
    address.title = state.title ? state.title + '\n' + url : url;
    canvas.setAttribute('aria-label', 'Live view of ' + (state.title || parts.host || 'the page'));

    // Back, forward, reload: only a tab this extension started has them.
    $('nav').hidden = !managed || !running;
    $('back').disabled = !interactive || state.canGoBack === false;
    $('forward').disabled = !interactive || state.canGoForward === false;
    $('reload').disabled = !interactive;
    $('progress').hidden = !(running && (state.loading === true || Date.now() < navigatingUntil));

    // The page's size: it follows the panel, or it is the size someone asked for.
    const page = state.page;
    const fit = $('fit');
    fit.hidden = !(running && managed && page && !page.pinned);
    fit.setAttribute('aria-pressed', String(fitWanted));
    fit.title = fitWanted ? 'The page follows this panel. Click for the standard desktop size.' : 'Standard desktop size, scaled to fit. Click to size the page to this panel.';
    const size = $('size');
    size.hidden = !(running && page && (page.pinned || !pageFit));
    if (page) { setText('size', page.width + ' × ' + page.height); size.title = page.pinned ? 'The size this page was opened with.' : 'The page keeps this size and is scaled to fit.'; }

    // Who is using the page.
    stage.dataset.interactive = String(interactive);
    stage.tabIndex = interactive ? 0 : -1;
    stage.setAttribute('aria-description', interactive ? 'Click, scroll and type here to use the page.' : '');
    $('glow').hidden = !(running && taskId);

    // The automation's pointer glides to where it last clicked.
    const pointer = state.pointer;
    if (pointer && pointer.at !== pointerAt && picture.width > 0) {
      pointerAt = pointer.at;
      const at = { x: picture.x + pointer.nx * picture.width, y: picture.y + pointer.ny * picture.height };
      const cursor = $('cursor');
      cursor.style.translate = at.x + 'px ' + at.y + 'px';
      cursor.dataset.on = 'true';
      setTimeout(() => ripple(at), 380);
      clearTimeout(cursorTimer);
      cursorTimer = setTimeout(() => { cursor.dataset.on = 'false'; }, 5000);
    }

    // The task: what the agent does, how far it got, Stop.
    // In a session, a task that just ended stays on the line for a while (how it ended), then the line goes.
    const ended = !taskId && running && state.ended && Date.now() + clockSkew - state.ended.finishedAt < ENDED_SHOWN_MS ? state.ended : null;
    const job = taskId ? state : ended;
    const hud = $('hud');
    hud.hidden = !job;
    if (job) {
      const working = job === state && running;
      const jobStatus = job === state ? status : job.status;
      const steps = job.steps || 0;
      const acts = steps + (steps === 1 ? ' action' : ' actions');
      hud.dataset.state = working ? 'running' : jobStatus === 'done' ? 'done' : 'ended';
      if (working) {
        setText('state', jobStatus === 'cancelling' ? 'Stopping…' : describeStep(job) + '…');
        setText('count', (steps ? acts + ' · ' : '') + clock(job.elapsedMs || 0));
      } else {
        setText('state', endText(jobStatus));
        setText('count', (steps ? acts : '') + (typeof job.elapsedMs === 'number' ? (steps ? ' in ' : '') + Math.round(job.elapsedMs / 1000) + ' s' : ''));
      }
      $('state').title = job.goal || '';
      const stop = $('stop');
      stop.hidden = !working;
      stop.disabled = jobStatus === 'cancelling';
      if (working && jobStatus !== 'cancelling' && stop.textContent !== 'Stop') stop.textContent = 'Stop';
      const raw = rawStep(job);
      const more = $('more');
      more.hidden = !raw && !job.goal;
      const open = more.getAttribute('aria-expanded') === 'true' && !more.hidden;
      hud.dataset.open = String(open);
      $('goal').hidden = !open || !job.goal;
      if (job.goal) setText('goal', job.goal);
      $('details').hidden = !open || !raw;
      if ($('details').textContent !== raw) $('details').textContent = raw;
    }

    // Nothing to draw, or a session that closed.
    if (bitmap) {
      if (!running && state.kind === 'session' && !taskId) empty('Session closed', 'This is the last picture of the page.', false, true);
      else empty(null);
    } else if (running) empty(state.streamError ? 'No picture yet' : 'Opening the page…', state.streamError || '', !state.streamError, false);
    else if (seq <= 0) empty(state.kind === 'task' ? 'The task ended' : 'Session closed', state.kind === 'task' ? 'It ended before a picture was shown.' : 'It closed before a picture was shown.', false, false);
    tick();
  }
  // The badge ticks every second even when nothing arrives: it says who drives the page and whether answers still come.
  function tick() {
    const badge = $('badge');
    if (!last) { badge.dataset.state = failures ? 'wait' : ''; setText('live', failures ? 'Reconnecting' : 'Connecting'); return; }
    const running = last.state === 'running';
    const fresh = Date.now() - lastOkAt < 4000;
    const only = running && last.viewOnly ? VIEW_ONLY[last.viewOnly] : null;
    let state = 'live';
    let label = 'Live';
    if (!running) { state = ''; label = 'Ended'; }
    else if (!fresh) { state = 'wait'; label = 'Reconnecting'; }
    else if (last.taskId) { state = 'agent'; label = 'Agent working'; }
    else if (only) label = only[0];
    badge.dataset.state = state;
    setText('live', label);
    const tip = [];
    if (only) tip.push(only[1]);
    else if (running && interactive) tip.push('You can click, scroll and type in the page.');
    if (running && typeof last.lastFrameAt === 'number') {
      const since = Date.now() + clockSkew - last.lastFrameAt;
      tip.push(since < 1500 ? 'The page is changing now.' : 'Last change ' + ago(since) + '.');
    }
    if (finalShot) tip.push('Showing the last picture.');
    if (frameSize) tip.push(frameSize.width + ' × ' + frameSize.height + ' px' + (sharp ? ', sharp still' : typeof last.quality === 'number' ? ', quality ' + last.quality : '') + (typeof last.frameBytes === 'number' ? ', ' + Math.round(last.frameBytes / 1024) + ' KB' : ''));
    badge.title = tip.join('\n');
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
      if (view) args.view = view;
      const state = await call('__FRAME__', args);
      if (state && typeof state.watchId === 'string' && state.watchId !== watchId) {
        // Opened without a watch id: follow the newest watch the extension has.
        watchId = state.watchId;
        seq = -1;
      }
      failures = 0;
      if (!state || state.ok === false) {
        last = null;
        interactive = false;
        $('badge').dataset.state = '';
        setText('live', 'Idle');
        $('nav').hidden = true;
        $('fit').hidden = true;
        $('size').hidden = true;
        $('hud').hidden = true;
        $('glow').hidden = true;
        $('progress').hidden = true;
        address.readOnly = true;
        address.placeholder = '';
        const why = (state && state.error && String(state.error).replace(/^BROWSER_NO_WATCH: /, '')) || 'This view has ended.';
        empty(bitmap ? 'This view has ended' : 'No browser to show', bitmap ? 'This is the last picture of the page.' : why.charAt(0).toUpperCase() + why.slice(1) + '.', false, Boolean(bitmap));
        schedule(3000);
        return;
      }
      lastOkAt = Date.now();
      if (typeof state.now === 'number') clockSkew = state.now - Date.now();
      const hadFrame = Boolean(state.frame);
      if (state.frame) { finalShot = state.frame.final === true; sharp = state.frame.sharp === true; await draw(state.frame); }
      if (typeof state.seq === 'number') seq = state.seq;
      render(state);
      if (hadFrame) lastPictureAt = Date.now();
      // A page that just changed, loads, or is being used is looked at often; a page at rest, a few times a second.
      const busy = Date.now() - lastPictureAt < 2000 || state.loading === true || Date.now() - lastInputAt < 3000;
      // A finished task's final screenshot is read from disk on the first poll: look again soon for it.
      schedule(state.state !== 'running' ? (!bitmap && finalLooks++ < 5 ? 400 : 2000) : busy ? 110 : 320);
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

  // ---- input (a tab this extension started that no task drives; the extension refuses it otherwise) ----
  const REFUSED = {
    secret_field: 'Password and code fields are not typed from this panel.',
    rate_limited: 'Too fast: a moment, then try again.',
  };
  const NOT_AN_ADDRESS = 'That is not a web address. Try one like example.com.';
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
        else if (event.kind === 'navigate' && String(result.error).startsWith('BROWSER_BAD_INPUT')) note(NOT_AN_ADDRESS);
        else if (result.error) note(String(result.error).replace(/^[A-Za-z_-]+: /, ''));
      }
    } catch (error) {
      note(event.kind === 'navigate' ? NOT_AN_ADDRESS : 'That did not reach the page.');
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
    setTimeout(() => el.remove(), 550);
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
    const unit = event.deltaMode === 1 ? 40 : event.deltaMode === 2 ? picture.height : 1;
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
    if (event.target !== stage || !interactive || event.metaKey || event.ctrlKey || event.isComposing) return;
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
    if (event.target !== stage || !interactive) return;
    const pasted = (event.clipboardData && event.clipboardData.getData('text/plain')) || '';
    event.preventDefault();
    const clean = pasted.replace(/[\r\n\t]+/g, ' ').replace(/\p{Cc}/gu, '').slice(0, 512);
    flushText();
    for (let at = 0; at < clean.length; at += 64) send({ kind: 'text', text: clean.slice(at, at + 64) });
  });

  // ---- toolbar ----
  address.addEventListener('focus', () => {
    editing = true;
    address.value = (last && last.url) || address.value;
    address.select();
  });
  address.addEventListener('blur', () => {
    editing = false;
    address.value = (last && last.url) || '';
  });
  // Enter goes on the key, not on a form: the panel's frame is sandboxed without form submission.
  address.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') { event.preventDefault(); address.blur(); return; }
    if (event.key !== 'Enter' || event.isComposing) return;
    event.preventDefault();
    const typed = address.value.trim();
    if (!typed || !interactive) return;
    address.blur();
    navigatingUntil = Date.now() + 1500;
    $('progress').hidden = false;
    send({ kind: 'navigate', url: typed });
  });
  for (const kind of ['back', 'forward', 'reload']) $(kind).addEventListener('click', () => {
    if (kind === 'reload') { const el = $('reload'); el.classList.remove('turn'); void el.offsetWidth; el.classList.add('turn'); }
    navigatingUntil = Date.now() + 1200;
    $('progress').hidden = false;
    send({ kind });
  });
  $('fit').addEventListener('click', () => {
    fitWanted = !fitWanted;
    try { localStorage.setItem('fit', fitWanted ? 'on' : 'off'); } catch (error) { /* no storage in this frame */ }
    $('fit').setAttribute('aria-pressed', String(fitWanted));
    layout();
    pollSoon();
  });
  $('more').addEventListener('click', () => {
    const open = $('more').getAttribute('aria-expanded') !== 'true';
    $('more').setAttribute('aria-expanded', String(open));
    if (last) render(last);
  });
  $('stop').addEventListener('click', async () => {
    if (!taskId) return;
    const stop = $('stop');
    stop.disabled = true;
    stop.textContent = 'Stopping…';
    try {
      const result = await call('__CANCEL__', { taskId });
      if (!(result && result.ok)) { stop.textContent = 'Stop'; stop.disabled = false; }
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
  matchMedia('(resolution: ' + (window.devicePixelRatio || 1) + 'dppx)').addEventListener('change', layout);
  layout();
  request('ui/initialize', { protocolVersion: '2026-01-26', appInfo: { name: 'Browser live view', version: '0.3.0' }, hostChrome: 'compact' })
    .then((result) => {
      applyContext(result && result.hostContext);
      layout();
      parent.postMessage({ jsonrpc: '2.0', method: 'ui/notifications/initialized', params: {} }, '*');
      // A panel opened with a watch id gets it in tool-input; one opened by hand follows the newest watch.
      setTimeout(() => { if (!watchId) schedule(0); }, 400);
    })
    .catch(() => { $('badge').dataset.state = 'failed'; setText('live', 'Offline'); empty('Not connected to Marshal', 'Close this panel and open it again.', false, false); });
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
                properties: {
                  width: { type: 'number' },
                  height: { type: 'number' },
                  dpr: { type: 'number' },
                  fit: { type: 'boolean' },
                  viewer: { type: 'string' },
                },
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
