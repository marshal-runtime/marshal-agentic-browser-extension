/**
 * TypeScript port of Browser Use's jev-ultrafast `snapshot.js`
 * (/tmp/jev-ultrafast/jev_ultrafast/snapshot.js, MIT - see README.md).
 *
 * Differences from the upstream script, both required by this host's
 * execution contract (browser_execute_script wraps the given `script`
 * string as the BODY of `(async () => { const args = [...]; <script> })()`
 * - see packages/extension/src/adapters/chrome-adapter.ts's
 * `executeScript`, ~line 1452 - so the script must end in a `return`, not
 * an expression):
 *   1. Wrapped as a script BODY (uses `return`) rather than an IIFE
 *      expression, to match executeScript's evaluation contract.
 *   2. Every interactive element is stamped with a `data-mjev-id="<id>"`
 *      attribute so the executor can act on it via the stable CSS selector
 *      `[data-mjev-id="<id>"]` (browser_click / browser_type /
 *      browser_select), instead of upstream's synthetic CDP node ids that
 *      only make sense inside the same Python process's element cache.
 *   3. Text/action budgets (6000 chars, 250 in-viewport elements, plus up
 *      to 60 offscreen ones) are unchanged in spirit from upstream, kept to
 *      bound Jev's per-request payload. Budgets are global across every
 *      root in the composed tree, not per-root.
 *   4. Adds `where` (3x3 region), `box`, `near` (nearest preceding visible
 *      text), `focused`, and `offscreen` fields not present upstream, used
 *      for confidence-gating criteria (see decide.ts) and offscreen targets.
 *   5. Pierces open shadow roots and same-origin iframes (see
 *      snapshot-walk.ts): elements discovered inside a pierced root get a
 *      hierarchical `node` path ("sh:<hostId>/<id>", "if:<iframeId>/<id>",
 *      nesting allowed) instead of a bare id, and `source: 'dom'`.
 *      DomAdapter.act() resolves that path back to the element (see
 *      buildDeepActionScript in snapshot-walk.ts) since a plain top-document
 *      CSS selector cannot reach across a shadow/iframe boundary.
 */
import {
  DEEP_ACTIVE_SCRIPT,
  FINGERPRINT_SCRIPT,
  FOCUS_FINGERPRINT_SCRIPT,
  ROOT_WALK_SCRIPT,
  ROOT_WALK_SCRIPT_READONLY,
} from './snapshot-walk.js';

export const SNAPSHOT_SCRIPT = `
if (!document.body) { return { url: location.href, title: document.title, w: innerWidth, h: innerHeight, text: '', scroll: { y: scrollY, height: 0 }, actions: [], marker: [], omittedActions: 0 }; }
const safe = e => !['password', 'file', 'hidden'].includes(e.type);
const visible = e => !e.closest('[aria-hidden="true"],[inert]') &&
  e.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
const name = (e, seen = new Set()) => {
  if (!e || seen.has(e)) return '';
  seen.add(e);
  const referenced = (e.getAttribute('aria-labelledby') || '').split(/\\s+/)
    .map(id => name(document.getElementById(id), seen)).filter(Boolean).join(' ');
  return referenced || e.getAttribute('aria-label') ||
    [...(e.labels || [])].map(l => name(l, seen)).filter(Boolean).join(' ') ||
    (['button', 'submit', 'reset'].includes(e.type) ? e.value : '') || e.getAttribute('alt') ||
    (e.tagName === 'INPUT' ? '' : [...e.childNodes].map(n => n.nodeType === 3 ? n.textContent :
      n.nodeType === 1 && n.getAttribute('aria-hidden') !== 'true' ? name(n, seen) : '').join(' ').trim()) ||
    e.getAttribute('title') || e.getAttribute('placeholder') || '';
};
const roles = ['button', 'link', 'checkbox', 'radio', 'switch', 'tab', 'menuitem', 'menuitemradio',
  'option', 'gridcell', 'combobox', 'textbox', 'searchbox', 'spinbutton'];
const selector = 'a[href],button,input,textarea,select,summary,[contenteditable="true"],' +
  roles.map(role => '[role="' + role + '"]').join(',');
const role = e => {
  const explicit = e.getAttribute('role');
  if (roles.includes(explicit)) return explicit;
  if (e.tagName === 'BUTTON' || e.tagName === 'SUMMARY') return 'button';
  if (e.tagName === 'A') return 'link';
  if (e.tagName === 'SELECT') return 'combobox';
  if (e.tagName === 'TEXTAREA' || e.isContentEditable) return 'textbox';
  if (e.tagName === 'INPUT') {
    if (['checkbox', 'radio'].includes(e.type)) return e.type;
    if (['button', 'submit', 'reset', 'image'].includes(e.type)) return 'button';
    if (e.type === 'search') return 'searchbox';
    if (e.type === 'number') return 'spinbutton';
    if (['text', 'email', 'url', 'tel'].includes(e.type)) return 'textbox';
  }
  return null;
};
const regionOf = (x, y) => {
  const col = x < innerWidth / 3 ? 0 : x < (2 * innerWidth) / 3 ? 1 : 2;
  const row = y < innerHeight / 3 ? 0 : y < (2 * innerHeight) / 3 ? 1 : 2;
  const cols = ['left', '', 'right'], rows = ['top', '', 'bottom'];
  const parts = [rows[row], cols[col]].filter(Boolean);
  return parts.length ? parts.join('-') : 'center';
};
const isHeadingish = e => /^(H[1-6]|LEGEND|CAPTION)$/.test(e.tagName) || e.getAttribute('role') === 'heading' ||
  (e.className && String(e.className).toLowerCase().match(/title|heading|header|name/));
const nearText = e => {
  let node = e.previousElementSibling, hops = 0;
  while (node && hops < 8) {
    if (visible(node) && !node.matches(selector) && !node.querySelector(selector)) {
      const t = (node.innerText || node.textContent || '').trim().replace(/\\s+/g, ' ');
      if (t) return t.slice(0, 60);
    }
    node = node.previousElementSibling;
    hops++;
  }
  let ancestor = e.parentElement, depth = 0;
  while (ancestor && depth < 5) {
    const heading = [...ancestor.children].find(c => c !== e && isHeadingish(c) && visible(c));
    if (heading) {
      const t = (heading.innerText || heading.textContent || '').trim().replace(/\\s+/g, ' ');
      if (t) return t.slice(0, 60);
    }
    ancestor = ancestor.parentElement;
    depth++;
  }
  return undefined;
};
${ROOT_WALK_SCRIPT}
${DEEP_ACTIVE_SCRIPT}
${FINGERPRINT_SCRIPT}
${FOCUS_FINGERPRINT_SCRIPT}
const focusedField = () => {
  const e = __mjevDeepActive(document);
  if (!e || e === document.body) return null;
  const rname = role(e);
  const editable = e.isContentEditable || ['textbox', 'searchbox', 'spinbutton', 'combobox'].includes(rname);
  if (!editable) return null;
  return {
    ...(rname ? { role: rname } : {}),
    label: name(e) || rname || '',
    ...('value' in e ? { value: String(e.value) } : {}),
    ...(e.getAttribute && e.getAttribute('placeholder') ? { placeholder: e.getAttribute('placeholder') } : {}),
  };
};
window.__mjevNext = window.__mjevNext || 1;
const focusedEl = __mjevDeepActive(document);
let focusedNodeId = null;
const onscreenEls = [];
const offscreenEls = [];
const roots = __mjevCollectRoots(document, 0, 0, '', 0);
for (const { root, offsetX, offsetY, pathPrefix } of roots) {
  for (const e of root.querySelectorAll(selector)) {
    if (!safe(e) || !visible(e) || e.matches(':disabled') || e.closest('[aria-disabled="true"]')) continue;
    const r = e.getBoundingClientRect(), x = offsetX + r.x + r.width / 2, y = offsetY + r.y + r.height / 2, rname = role(e);
    if (!rname || r.width <= 0 || r.height <= 0) continue;
    const inViewport = x >= 0 && y >= 0 && x < innerWidth && y < innerHeight;
    // No global visitation cap: the walk always covers the whole composed
    // tree, so onscreen elements after a long scroll are never starved by
    // offscreen elements earlier in DOM order. Bucketed here in walk order;
    // the 250/60 caps are applied per bucket below, after the full walk.
    (inViewport ? onscreenEls : offscreenEls).push({ e, rname, r, offsetX, offsetY, pathPrefix, x, y });
  }
}
const omittedActions = Math.max(0, onscreenEls.length - 250);
const onscreenKept = onscreenEls.slice(0, 250);
const offscreenKept = offscreenEls.slice(0, 60);
// Same two-bucket projection MARKER_SCRIPT builds (onscreen first, capped
// at 250, then offscreen, capped at 60) - must stay byte-identical on an
// unchanged page (see snapshot-walk.ts FINGERPRINT_SCRIPT).
const fingerprints = onscreenKept.map(({ e, rname }) => __mjevFingerprint(e, rname, false))
  .concat(offscreenKept.map(({ e, rname }) => __mjevFingerprint(e, rname, true)));
function buildActionRows(item, offscreen, bucket) {
  const { e, rname, r, offsetX, offsetY, pathPrefix, x, y } = item;
  const localId = __mjevStamp(e);
  const nodeId = pathPrefix + localId;
  if (e === focusedEl) focusedNodeId = nodeId;
  const box = [Math.round(offsetX + r.x), Math.round(offsetY + r.y), Math.round(r.width), Math.round(r.height)];
  const near = nearText(e);
  const base = { node: nodeId, role: rname, label: name(e) || rname, box, ...(near ? { near } : {}),
    ...(pathPrefix ? { source: 'dom' } : {}) };
  if (offscreen) {
    base.offscreen = true;
    base.where = y < 0 ? 'above' : y >= innerHeight ? 'below' : regionOf(x, y);
  } else {
    base.where = regionOf(x, y);
  }
  for (const key of ['checked', 'selected', 'expanded']) {
    const value = e.getAttribute('aria-' + key);
    if (value !== null) base[key] = value;
  }
  if (['checkbox', 'radio'].includes(e.type)) base.checked = String(e.checked);
  if (e.tagName === 'SELECT') {
    for (const o of e.options) if (!o.selected && !o.disabled && !o.closest('optgroup[disabled]'))
      bucket.push({ ...base, kind: 'select', value: o.value,
        current_value: [...e.selectedOptions].map(so => so.label).join(', '), label: base.label + ' → ' + o.label });
  } else {
    const editable = !e.readOnly && e.getAttribute('aria-readonly') !== 'true' &&
      (['textbox', 'searchbox', 'spinbutton'].includes(rname) ||
        (rname === 'combobox' && ['INPUT', 'TEXTAREA'].includes(e.tagName)));
    const value = 'value' in e ? String(e.value) :
      e.isContentEditable || rname === 'combobox' ? e.innerText.trim() : '';
    bucket.push({ ...base, kind: editable ? 'fill' : 'click', value });
    if (editable) bucket.push({ ...base, kind: 'click', value, label: 'Open ' + base.label });
  }
}
const onscreen = [];
const offscreenActions = [];
for (const item of onscreenKept) buildActionRows(item, false, onscreen);
for (const item of offscreenKept) buildActionRows(item, true, offscreenActions);
const words = [];
const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
const range = document.createRange();
let node, length = 0;
while ((node = walker.nextNode()) && length < 6000) {
  const value = node.textContent.trim(), parent = node.parentElement;
  if (!value || !parent || parent.closest('script,style,noscript,template') || !visible(parent)) continue;
  range.selectNodeContents(node);
  const r = range.getBoundingClientRect();
  if (r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth) {
    words.push(value);
    length += value.length;
  }
}
const text = words.join('\\n').slice(0, 6000);
const height = document.documentElement.scrollHeight;
const actions = onscreen.concat(offscreenActions);
const focused = focusedField();
// A focused editable field can be submitted by pressing Enter, as an
// alternative to finding and clicking a separate Search/Submit button (see
// browser-actions.ts's 'submit' case). Only offered when the focused
// element was itself stamped during the walk above (top-document or a
// pierced shadow/iframe root; see snapshot-walk.ts's buildDeepActionScript).
if (focused && focusedNodeId !== null) {
  actions.push({ node: focusedNodeId, kind: 'submit', label: 'Press Enter in ' + focused.label, id: 'submit' });
}
// The marker's focused entry uses the SAME reduced [label, value] projection
// MARKER_SCRIPT does (__mjevFocusMarker), not the richer \`focused\` object
// above (which keeps role/placeholder for the planner) - the two MUST stay
// byte-identical on an unchanged page or the freshness check spuriously
// reports "changed" whenever any field is focused (see FOCUS_FINGERPRINT_SCRIPT).
const marker = [location.href, scrollX, scrollY, innerWidth, innerHeight, document.title, text, JSON.stringify(fingerprints), JSON.stringify(__mjevFocusMarker(document))];
if (scrollY + innerHeight < height - 2) actions.push({ node: null, kind: 'scroll', label: 'Scroll down', delta: 560, id: 'scroll_down' });
if (scrollY > 0) actions.push({ node: null, kind: 'scroll', label: 'Scroll up', delta: -560, id: 'scroll_up' });
actions.push({ node: null, kind: 'wait', label: 'Wait for the page to update', id: 'wait' });
return { url: location.href, title: document.title, w: innerWidth, h: innerHeight, text,
  scroll: { y: scrollY, height }, actions, marker, omittedActions, focused };
`;

/**
 * Cheap fast path for the executor's pre-act freshness check: computes only
 * the fields that feed `marker` (url/scroll/size/title/visible text/element
 * semantics/focused field), with no `data-mjev-id` stamping and no
 * box/near/where computation, so it is far cheaper per call than the full
 * `SNAPSHOT_SCRIPT`. Returns the bare `marker` array (see DomAdapter.marker()).
 * Still walks the composed tree (shadow roots + same-origin iframes) so an
 * action inside a pierced root is not invisible to the freshness check - it
 * just never stamps ids or builds a path, since a marker is only compared,
 * never acted on. Its `semantics` entry is built from the exact same
 * `__mjevFingerprint` projection, over the exact same element sequence, as
 * SNAPSHOT_SCRIPT - the two MUST stay byte-identical on an unchanged page,
 * or the executor's freshness check spuriously reports "changed" forever
 * (see snapshot-walk.ts FINGERPRINT_SCRIPT and tests/snapshot-walk.test.ts).
 */
export const MARKER_SCRIPT = `
if (!document.body) { return [location.href, 0, 0, innerWidth, innerHeight, document.title, '', '[]', 'null']; }
const visible = e => !e.closest('[aria-hidden="true"],[inert]') &&
  e.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
const name = (e, seen = new Set()) => {
  if (!e || seen.has(e)) return '';
  seen.add(e);
  const referenced = (e.getAttribute('aria-labelledby') || '').split(/\\s+/)
    .map(id => name(document.getElementById(id), seen)).filter(Boolean).join(' ');
  return referenced || e.getAttribute('aria-label') ||
    [...(e.labels || [])].map(l => name(l, seen)).filter(Boolean).join(' ') ||
    (['button', 'submit', 'reset'].includes(e.type) ? e.value : '') || e.getAttribute('alt') ||
    (e.tagName === 'INPUT' ? '' : [...e.childNodes].map(n => n.nodeType === 3 ? n.textContent :
      n.nodeType === 1 && n.getAttribute('aria-hidden') !== 'true' ? name(n, seen) : '').join(' ').trim()) ||
    e.getAttribute('title') || e.getAttribute('placeholder') || '';
};
const roles = ['button', 'link', 'checkbox', 'radio', 'switch', 'tab', 'menuitem', 'menuitemradio',
  'option', 'gridcell', 'combobox', 'textbox', 'searchbox', 'spinbutton'];
const selector = 'a[href],button,input,textarea,select,summary,[contenteditable="true"],' +
  roles.map(role => '[role="' + role + '"]').join(',');
const role = e => {
  const explicit = e.getAttribute('role');
  if (roles.includes(explicit)) return explicit;
  if (e.tagName === 'BUTTON' || e.tagName === 'SUMMARY') return 'button';
  if (e.tagName === 'A') return 'link';
  if (e.tagName === 'SELECT') return 'combobox';
  if (e.tagName === 'TEXTAREA' || e.isContentEditable) return 'textbox';
  if (e.tagName === 'INPUT') {
    if (['checkbox', 'radio'].includes(e.type)) return e.type;
    if (['button', 'submit', 'reset', 'image'].includes(e.type)) return 'button';
    if (e.type === 'search') return 'searchbox';
    if (e.type === 'number') return 'spinbutton';
    if (['text', 'email', 'url', 'tel'].includes(e.type)) return 'textbox';
  }
  return null;
};
const safe = e => !['password', 'file', 'hidden'].includes(e.type);
${ROOT_WALK_SCRIPT_READONLY}
${DEEP_ACTIVE_SCRIPT}
${FINGERPRINT_SCRIPT}
${FOCUS_FINGERPRINT_SCRIPT}
const onscreenEls = [];
const offscreenEls = [];
for (const { root, offsetX, offsetY } of __mjevCollectRootsRO(document, 0, 0, 0)) {
  for (const e of root.querySelectorAll(selector)) {
    if (!safe(e) || !visible(e) || e.matches(':disabled') || e.closest('[aria-disabled="true"]')) continue;
    const r = e.getBoundingClientRect(), x = offsetX + r.x + r.width / 2, y = offsetY + r.y + r.height / 2, rname = role(e);
    if (!rname || r.width <= 0 || r.height <= 0) continue;
    const inViewport = x >= 0 && y >= 0 && x < innerWidth && y < innerHeight;
    // No global visitation cap - see SNAPSHOT_SCRIPT for why. Bucketed here
    // in walk order; the 250/60 caps are applied per bucket below.
    (inViewport ? onscreenEls : offscreenEls).push({ e, rname });
  }
}
// Same two-bucket projection SNAPSHOT_SCRIPT builds (onscreen first, capped
// at 250, then offscreen, capped at 60) - must byte-match on an unchanged
// page (see snapshot-walk.ts FINGERPRINT_SCRIPT).
const semantics = onscreenEls.slice(0, 250).map(({ e, rname }) => __mjevFingerprint(e, rname, false))
  .concat(offscreenEls.slice(0, 60).map(({ e, rname }) => __mjevFingerprint(e, rname, true)));
const words = [];
const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
const range = document.createRange();
let node, length = 0;
while ((node = walker.nextNode()) && length < 6000) {
  const value = node.textContent.trim(), parent = node.parentElement;
  if (!value || !parent || parent.closest('script,style,noscript,template') || !visible(parent)) continue;
  range.selectNodeContents(node);
  const r = range.getBoundingClientRect();
  if (r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth) {
    words.push(value);
    length += value.length;
  }
}
const text = words.join('\\n').slice(0, 6000);
// Same reduced [label, value]-or-null projection SNAPSHOT_SCRIPT's marker
// uses (__mjevFocusMarker) - must byte-match on an unchanged page (see
// snapshot-walk.ts FOCUS_FINGERPRINT_SCRIPT).
return [location.href, scrollX, scrollY, innerWidth, innerHeight, document.title, text, JSON.stringify(semantics), JSON.stringify(__mjevFocusMarker(document))];
`;
