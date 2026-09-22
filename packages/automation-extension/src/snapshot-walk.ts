/**
 * Composed-tree walk shared by SNAPSHOT_SCRIPT and MARKER_SCRIPT
 * (snapshot-script.ts) and by DomAdapter's cross-root action resolver
 * (dom-adapter.ts). Recurses into every open `shadowRoot` and same-origin
 * iframe reachable from `document`, bounded to depth 6, so element
 * discovery, the visible-text/semantics fingerprint, and action dispatch
 * all see the same composed tree instead of only the top document's light
 * DOM.
 *
 * Path grammar for actions discovered inside a pierced root
 * (`RawSnapshotAction.node`): a sequence of "sh:<hostId>" / "if:<iframeId>"
 * hops (nested allowed, e.g. an iframe inside a shadow root) joined by "/",
 * followed by the element's own stamped id - e.g. "sh:12/34" or
 * "if:7/sh:9/11". A plain id with no "/" means the top document, exactly as
 * before this walk existed.
 */

/** `document.activeElement`, drilled through shadow roots and same-origin iframes. Stamps nothing. */
export const DEEP_ACTIVE_SCRIPT = `
function __mjevDeepActive(doc) {
  let el = doc.activeElement, hops = 0;
  while (el && hops < 6) {
    if (el.shadowRoot && el.shadowRoot.activeElement) { el = el.shadowRoot.activeElement; hops++; continue; }
    if (el.tagName === 'IFRAME') {
      let inner;
      try { inner = el.contentDocument; } catch (err) { inner = null; }
      if (inner && inner.activeElement && inner.activeElement !== inner.body) { el = inner.activeElement; hops++; continue; }
    }
    break;
  }
  return el;
}
`;

/**
 * Stamps (if needed) and returns `data-mjev-id`, plus the recursive root
 * walk that also builds each root's sh:/if: path prefix and top-document
 * pixel offset. Used by the full SNAPSHOT_SCRIPT (element/action discovery
 * needs both ids and offsets).
 */
export const ROOT_WALK_SCRIPT = `
function __mjevStamp(e) {
  if (!e.hasAttribute('data-mjev-id')) e.setAttribute('data-mjev-id', String(window.__mjevNext++));
  return e.getAttribute('data-mjev-id');
}
function __mjevCollectRoots(root, offsetX, offsetY, pathPrefix, depth) {
  const roots = [{ root, offsetX, offsetY, pathPrefix }];
  if (depth >= 6) return roots;
  for (const host of root.querySelectorAll('*')) {
    if (host.shadowRoot) {
      roots.push(...__mjevCollectRoots(host.shadowRoot, offsetX, offsetY, pathPrefix + 'sh:' + __mjevStamp(host) + '/', depth + 1));
    }
  }
  for (const frame of root.querySelectorAll('iframe')) {
    let doc;
    try { doc = frame.contentDocument; } catch (err) { doc = null; }
    if (!doc || !doc.body) continue;
    if (!frame.checkVisibility || !frame.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) continue;
    const fr = frame.getBoundingClientRect();
    roots.push(...__mjevCollectRoots(doc, offsetX + fr.x, offsetY + fr.y, pathPrefix + 'if:' + __mjevStamp(frame) + '/', depth + 1));
  }
  return roots;
}
`;

/**
 * Same recursive walk, but read-only (no `data-mjev-id` stamping, no path
 * bookkeeping) - keeps `MARKER_SCRIPT`'s fast path non-mutating. Still
 * carries each root's top-document pixel offset (needed to compute the
 * same onscreen/offscreen boolean the full snapshot computes, which is
 * part of the shared fingerprint - see FINGERPRINT_SCRIPT), but never an
 * addressable sh:/if: path.
 */
export const ROOT_WALK_SCRIPT_READONLY = `
function __mjevCollectRootsRO(root, offsetX, offsetY, depth) {
  const roots = [{ root, offsetX, offsetY }];
  if (depth >= 6) return roots;
  for (const host of root.querySelectorAll('*')) {
    if (host.shadowRoot) roots.push(...__mjevCollectRootsRO(host.shadowRoot, offsetX, offsetY, depth + 1));
  }
  for (const frame of root.querySelectorAll('iframe')) {
    let doc;
    try { doc = frame.contentDocument; } catch (err) { doc = null; }
    if (!doc || !doc.body) continue;
    if (!frame.checkVisibility || !frame.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) continue;
    const fr = frame.getBoundingClientRect();
    roots.push(...__mjevCollectRootsRO(doc, offsetX + fr.x, offsetY + fr.y, depth + 1));
  }
  return roots;
}
`;

/**
 * Single shared projection used by BOTH scripts to build the marker's
 * semantics fingerprint, so a byte-identical sequence comes out of the full
 * SNAPSHOT_SCRIPT (which stamps ids and computes box/near/where) and the
 * cheap, non-mutating MARKER_SCRIPT (which cannot know ids without
 * stamping). Deliberately excludes `node`/`kind`: one entry per DOM
 * element, not per generated action (a SELECT contributes one entry, not
 * one per option; an editable field contributes one entry, not a fill+click
 * pair). Both scripts walk the FULL composed tree with no visitation cap
 * (so onscreen elements below a long scroll position are never starved by
 * offscreen elements earlier in DOM order), bucket elements into onscreen
 * vs offscreen in walk order, then cap each bucket (250 onscreen, 60
 * offscreen) before fingerprinting - the onscreen bucket first, then the
 * offscreen bucket, exactly mirroring how `actions` is built.
 */
export const FINGERPRINT_SCRIPT = `
function __mjevFingerprint(e, rname, offscreen) {
  const value = 'value' in e ? String(e.value) : e.isContentEditable || rname === 'combobox' ? e.innerText.trim() : '';
  const checked = e.getAttribute('aria-checked') ?? (['checkbox', 'radio'].includes(e.type) ? String(e.checked) : null);
  const selected = e.getAttribute('aria-selected');
  const expanded = e.getAttribute('aria-expanded');
  return [rname, name(e) || rname, value, checked, selected, expanded, offscreen ? 1 : 0];
}
`;

/**
 * Shared marker-9 (last element) projection for the focused field, used by
 * BOTH scripts so a byte-identical value comes out of the full
 * SNAPSHOT_SCRIPT (whose richer `focused` object, with role/placeholder,
 * still feeds the return value's own `focused` field for the planner - just
 * not the marker) and the cheap MARKER_SCRIPT. Requires `__mjevDeepActive`,
 * `role`, and `name` already in scope (DEEP_ACTIVE_SCRIPT plus each script's
 * own `role`/`name` helpers). Applies the SAME editable rule SNAPSHOT's
 * `focusedField()` always applied - `null` unless the deep-active element is
 * content-editable or has an editable role (textbox/searchbox/spinbutton/
 * combobox) - so a focused non-editable element (e.g. a focused button)
 * marks as `null` in both scripts, not just in SNAPSHOT_SCRIPT.
 */
export const FOCUS_FINGERPRINT_SCRIPT = `
function __mjevFocusMarker(doc) {
  const e = __mjevDeepActive(doc);
  if (!e || e === doc.body) return null;
  const rname = role(e);
  const editable = e.isContentEditable || ['textbox', 'searchbox', 'spinbutton', 'combobox'].includes(rname);
  if (!editable) return null;
  return [name(e) || rname || '', 'value' in e ? String(e.value) : ''];
}
`;

/** In-page path resolver: walks a "sh:<id>/if:<id>/.../<id>" path back to the concrete element, starting from the top document. */
export const RESOLVE_PATH_SCRIPT = `
function __mjevResolve(path) {
  const hops = path.split('/');
  const last = hops.pop();
  let root = document;
  for (const hop of hops) {
    const kind = hop.slice(0, 3), id = hop.slice(3);
    const host = root.querySelector('[data-mjev-id="' + id + '"]');
    if (!host) return null;
    root = kind === 'sh:' ? host.shadowRoot : kind === 'if:' ? host.contentDocument : null;
    if (!root) return null;
  }
  return root.querySelector('[data-mjev-id="' + last + '"]');
}
`;

export type DeepActionKind = 'click' | 'fill' | 'select' | 'scroll' | 'wait' | 'submit';

/**
 * Pure builder (no DOM access, unit-testable) for the in-page script body
 * DomAdapter.act() runs when a RawSnapshotAction.node contains a "sh:"/"if:"
 * hop - i.e. the target lives inside a pierced shadow root or same-origin
 * iframe and cannot be reached by a plain top-document CSS selector.
 */
export function buildDeepActionScript(
  path: string,
  action: { readonly kind: DeepActionKind; readonly value?: string },
  offscreen: boolean,
): string {
  const encodedValue = JSON.stringify(action.value ?? '');
  const scrollStep = offscreen
    ? `if (el.scrollIntoView) el.scrollIntoView({ block: 'center' });`
    : '';
  const actStep =
    action.kind === 'click'
      ? `el.click();`
      : action.kind === 'submit'
        ? `if (el.form) {
  el.form.requestSubmit();
} else {
  el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  el.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true }));
}`
        : action.kind === 'select'
          ? `el.value = ${encodedValue};
el.dispatchEvent(new Event('input', { bubbles: true }));
el.dispatchEvent(new Event('change', { bubbles: true }));`
          : `if (el.isContentEditable) {
  el.textContent = ${encodedValue};
} else {
  el.focus();
  if (el.select) el.select();
  el.value = ${encodedValue};
}
el.dispatchEvent(new Event('input', { bubbles: true }));
el.dispatchEvent(new Event('change', { bubbles: true }));`;
  return `${RESOLVE_PATH_SCRIPT}
const el = __mjevResolve(${JSON.stringify(path)});
if (!el) return { ok: false };
${scrollStep}
${actStep}
return { ok: true };`;
}

/**
 * True for a node produced by the composed-tree walk (lives in a shadow root
 * and/or iframe, not the top document). Deliberately returns plain `boolean`,
 * not a `node is string` type predicate: this only recognizes the "sh:"/"if:"
 * subset of strings, not every string, so a `node is string` predicate would
 * make TypeScript (incorrectly) narrow a caller's non-deep, non-null node to
 * `null` in the false branch - which previously produced several genuinely
 * dead `!== null` checks downstream in dom-adapter.ts's `act()`.
 */
export function isDeepNode(node: string | null): boolean {
  return node !== null && (node.startsWith('sh:') || node.startsWith('if:'));
}
