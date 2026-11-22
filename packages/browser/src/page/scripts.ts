/**
 * In-page scripts a page backend runs with `Runtime.evaluate`. Each one is a function BODY (it ends in `return`) and is
 * wrapped by `asExpression`. They resolve elements by the snapshot's `data-mjev-id` paths (snapshot-walk.ts grammar),
 * so they work the same over a CDP pipe (managed Chrome) and over chrome.debugger (the planned `user` backend).
 */
import { RESOLVE_PATH_SCRIPT } from './snapshot-walk.js';

export const asExpression = (body: string): string => `(async () => {\n${body}\n})()`;

/** Top-document viewport rect of an element, adding the offset of every same-origin iframe on its path. */
const RECT_SCRIPT = `
function __mbRect(path, el) {
  const r = el.getBoundingClientRect();
  let x = r.x, y = r.y;
  const hops = path.split('/'); hops.pop();
  let root = document;
  for (const hop of hops) {
    const host = root.querySelector('[data-mjev-id="' + hop.slice(3) + '"]');
    if (!host) break;
    if (hop.startsWith('if:')) { const fr = host.getBoundingClientRect(); x += fr.x; y += fr.y; root = host.contentDocument; }
    else root = host.shadowRoot;
    if (!root) break;
  }
  return { x, y, w: r.width, h: r.height };
}
`;

/**
 * Scrolls the element into view and returns the point to click in top-document viewport coordinates, plus whether
 * that point actually hits the element (an overlay can cover it; the caller then falls back to an in-page click).
 */
export function pointScript(path: string): string {
  return `${RESOLVE_PATH_SCRIPT}${RECT_SCRIPT}
const el = __mjevResolve(${JSON.stringify(path)});
if (!el) return { ok: false, error: 'element-gone' };
const before = el.getBoundingClientRect();
if (before.top < 0 || before.bottom > innerHeight || before.left < 0 || before.right > innerWidth) {
  el.scrollIntoView({ block: 'center', inline: 'center' });
  await new Promise(r => setTimeout(r, 120));
}
const r = __mbRect(${JSON.stringify(path)}, el);
if (r.w <= 0 || r.h <= 0) return { ok: false, error: 'element-not-visible' };
const x = r.x + r.w / 2, y = r.y + r.h / 2;
let hitEl = null;
try { hitEl = document.elementFromPoint(x, y); } catch (e) { hitEl = null; }
const isFrameHop = ${JSON.stringify(path.includes('if:') || path.includes('sh:'))};
const hit = isFrameHop || (hitEl !== null && (hitEl === el || el.contains(hitEl) || hitEl.contains(el)));
return { ok: true, x, y, hit };`;
}

export function jsClickScript(path: string): string {
  return `${RESOLVE_PATH_SCRIPT}
const el = __mjevResolve(${JSON.stringify(path)});
if (!el) return { ok: false, error: 'element-gone' };
el.scrollIntoView({ block: 'center' });
if (el.focus) el.focus();
el.click();
return { ok: true };`;
}

/** Focuses an editable element and empties it through the native value setter (so React-style inputs see it). */
export function focusAndClearScript(path: string): string {
  return `${RESOLVE_PATH_SCRIPT}
const el = __mjevResolve(${JSON.stringify(path)});
if (!el) return { ok: false, error: 'element-gone' };
el.scrollIntoView({ block: 'center' });
el.focus();
if (el.isContentEditable) {
  const range = el.ownerDocument.createRange();
  range.selectNodeContents(el);
  const sel = el.ownerDocument.getSelection();
  sel.removeAllRanges(); sel.addRange(range);
  return { ok: true };
}
const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
const setter = Object.getOwnPropertyDescriptor(proto, 'value');
if (setter && setter.set) setter.set.call(el, ''); else el.value = '';
el.dispatchEvent(new Event('input', { bubbles: true }));
return { ok: true };`;
}

export function selectScript(path: string, value: string): string {
  return `${RESOLVE_PATH_SCRIPT}
const el = __mjevResolve(${JSON.stringify(path)});
if (!el || el.tagName !== 'SELECT') return { ok: false, error: 'element-gone' };
const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
if (setter && setter.set) setter.set.call(el, ${JSON.stringify(value)}); else el.value = ${JSON.stringify(value)};
el.dispatchEvent(new Event('input', { bubbles: true }));
el.dispatchEvent(new Event('change', { bubbles: true }));
return { ok: el.value === ${JSON.stringify(value)} };`;
}

export function focusScript(path: string): string {
  return `${RESOLVE_PATH_SCRIPT}
const el = __mjevResolve(${JSON.stringify(path)});
if (!el) return { ok: false, error: 'element-gone' };
el.focus();
return { ok: true };`;
}

export const MARKS_ID = '__marshal_browser_marks';

/**
 * Draws one numbered box per listed element (the "marked screenshot"); `removeMarksScript` takes it away again.
 * The layer is fixed, ignores the pointer and sits above the page, so it changes nothing the page can observe
 * except one extra element for the length of a screenshot.
 */
export function drawMarksScript(
  marks: readonly { readonly node: string; readonly ref: string }[],
): string {
  return `${RESOLVE_PATH_SCRIPT}${RECT_SCRIPT}
const old = document.getElementById(${JSON.stringify(MARKS_ID)});
if (old) old.remove();
const layer = document.createElement('div');
layer.id = ${JSON.stringify(MARKS_ID)};
layer.setAttribute('aria-hidden', 'true');
layer.style.cssText = 'position:fixed;inset:0;z-index:2147483647;pointer-events:none;';
const colors = ['#e6194b','#3cb44b','#4363d8','#f58231','#911eb4','#008080','#f032e6','#9a6324'];
let drawn = 0;
const marks = ${JSON.stringify(marks)};
marks.forEach((mark, i) => {
  const el = __mjevResolve(mark.node);
  if (!el) return;
  const r = __mbRect(mark.node, el);
  if (r.w <= 0 || r.h <= 0 || r.y + r.h < 0 || r.y > innerHeight || r.x + r.w < 0 || r.x > innerWidth) return;
  const color = colors[i % colors.length];
  const box = document.createElement('div');
  box.style.cssText = 'position:fixed;box-sizing:border-box;border:2px solid ' + color + ';left:' + r.x + 'px;top:' + r.y + 'px;width:' + r.w + 'px;height:' + r.h + 'px;';
  const tag = document.createElement('div');
  tag.textContent = mark.ref;
  tag.style.cssText = 'position:absolute;left:-2px;top:' + (r.y > 16 ? -16 : 0) + 'px;background:' + color + ';color:#fff;font:bold 11px/14px monospace;padding:0 3px;white-space:nowrap;';
  box.appendChild(tag);
  layer.appendChild(box);
  drawn++;
});
document.documentElement.appendChild(layer);
await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
return { ok: true, drawn };`;
}

export const REMOVE_MARKS_SCRIPT = `const layer = document.getElementById(${JSON.stringify(MARKS_ID)}); if (layer) layer.remove(); return { ok: true };`;

export const FULL_TEXT_SCRIPT = `return document.body ? String(document.body.innerText || '').slice(0, 100000) : '';`;
