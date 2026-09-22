import { describe, expect, it } from 'vitest';
import {
  buildDeepActionScript,
  DEEP_ACTIVE_SCRIPT,
  FINGERPRINT_SCRIPT,
  FOCUS_FINGERPRINT_SCRIPT,
  isDeepNode,
} from '../src/snapshot-walk.js';
import { MARKER_SCRIPT, SNAPSHOT_SCRIPT } from '../src/snapshot-script.js';

describe('isDeepNode', () => {
  it('is true only for "sh:"/"if:"-prefixed paths, never a plain top-document id or null', () => {
    expect(isDeepNode('sh:12/34')).toBe(true);
    expect(isDeepNode('if:7/9')).toBe(true);
    expect(isDeepNode('if:7/sh:9/11')).toBe(true);
    expect(isDeepNode('34')).toBe(false);
    expect(isDeepNode(null)).toBe(false);
  });
});

describe('buildDeepActionScript (pure resolver-script builder, no DOM)', () => {
  it('embeds the encoded path and resolves via __mjevResolve for a click', () => {
    const script = buildDeepActionScript('sh:12/34', { kind: 'click' }, false);
    expect(script).toContain('function __mjevResolve(path)');
    expect(script).toContain(JSON.stringify('sh:12/34'));
    expect(script).toContain('el.click();');
    expect(script).not.toContain('scrollIntoView');
    expect(script).toContain('return { ok: true };');
  });

  it('scrolls into view first when the target is offscreen', () => {
    const script = buildDeepActionScript('if:7/9', { kind: 'click' }, true);
    expect(script).toContain("el.scrollIntoView({ block: 'center' });");
    // Scroll must precede the click.
    expect(script.indexOf('scrollIntoView')).toBeLessThan(script.indexOf('el.click();'));
  });

  it('builds a focus+select+value-set body with input/change events for fill', () => {
    const script = buildDeepActionScript('sh:1/2', { kind: 'fill', value: 'Berlin' }, false);
    expect(script).toContain(JSON.stringify('Berlin'));
    expect(script).toContain('el.focus();');
    expect(script).toContain("el.dispatchEvent(new Event('input', { bubbles: true }));");
    expect(script).toContain("el.dispatchEvent(new Event('change', { bubbles: true }));");
    expect(script).toContain('el.isContentEditable');
    expect(script).toContain('el.textContent =');
  });

  it('sets el.value and fires input/change for select, without focus/select-all', () => {
    const script = buildDeepActionScript('if:1/2', { kind: 'select', value: 'DE' }, false);
    expect(script).toContain(JSON.stringify('DE'));
    expect(script).toContain('el.value = ' + JSON.stringify('DE'));
    expect(script).not.toContain('el.focus();');
  });

  it('returns { ok: false } when the path does not resolve, before attempting the action', () => {
    const script = buildDeepActionScript('sh:1/2', { kind: 'click' }, false);
    expect(script).toContain('if (!el) return { ok: false };');
  });
});

describe('shared marker fingerprint (SNAPSHOT_SCRIPT vs MARKER_SCRIPT parity)', () => {
  it('both scripts embed the exact same FINGERPRINT_SCRIPT fragment verbatim', () => {
    expect(SNAPSHOT_SCRIPT).toContain(FINGERPRINT_SCRIPT);
    expect(MARKER_SCRIPT).toContain(FINGERPRINT_SCRIPT);
  });

  it('both scripts walk the full composed tree with no visitation cap, then build marker semantics from the same two-bucket (onscreen capped 250, offscreen capped 60) projection', () => {
    // Neither script may break out of the element walk early - onscreen
    // elements below a long scroll position must never be starved by
    // offscreen elements earlier in DOM order.
    expect(SNAPSHOT_SCRIPT).not.toContain('break outer');
    expect(SNAPSHOT_SCRIPT).not.toContain('break findRoots');
    expect(MARKER_SCRIPT).not.toContain('break outer');
    expect(MARKER_SCRIPT).not.toContain('break findRoots');

    // SNAPSHOT_SCRIPT: elements bucketed onscreen/offscreen in walk order,
    // capped per bucket (250/60), then fingerprinted onscreen-first - the
    // marker's semantics field is that array directly, never re-derived
    // from `actions`.
    expect(SNAPSHOT_SCRIPT).toContain('const onscreenKept = onscreenEls.slice(0, 250);');
    expect(SNAPSHOT_SCRIPT).toContain('const offscreenKept = offscreenEls.slice(0, 60);');
    expect(SNAPSHOT_SCRIPT).toContain(
      'const fingerprints = onscreenKept.map(({ e, rname }) => __mjevFingerprint(e, rname, false))\n' +
        '  .concat(offscreenKept.map(({ e, rname }) => __mjevFingerprint(e, rname, true)));',
    );
    expect(SNAPSHOT_SCRIPT).toContain('JSON.stringify(fingerprints)');
    expect(SNAPSHOT_SCRIPT).not.toContain('actions.map(a =>');

    // MARKER_SCRIPT: identical two-bucket construction over its own
    // read-only walk.
    expect(MARKER_SCRIPT).toContain(
      'const semantics = onscreenEls.slice(0, 250).map(({ e, rname }) => __mjevFingerprint(e, rname, false))\n' +
        '  .concat(offscreenEls.slice(0, 60).map(({ e, rname }) => __mjevFingerprint(e, rname, true)));',
    );
    expect(MARKER_SCRIPT).toContain('JSON.stringify(semantics)');
  });

  it('is syntactically valid as the executeScript body-wrapped-as-async-IIFE both scripts are actually run as', () => {
    // Mirrors browser-actions.ts's asExpression() wrapping; throws a SyntaxError on malformed script text.
    expect(() => new Function(`return (async () => {\n${SNAPSHOT_SCRIPT}\n})`)).not.toThrow();
    expect(() => new Function(`return (async () => {\n${MARKER_SCRIPT}\n})`)).not.toThrow();
  });

  it("both scripts embed the exact same FOCUS_FINGERPRINT_SCRIPT fragment and use it (not a per-script ad hoc focused object) for the marker's last entry", () => {
    expect(SNAPSHOT_SCRIPT).toContain(FOCUS_FINGERPRINT_SCRIPT);
    expect(MARKER_SCRIPT).toContain(FOCUS_FINGERPRINT_SCRIPT);
    expect(SNAPSHOT_SCRIPT).toContain('JSON.stringify(__mjevFocusMarker(document))');
    expect(MARKER_SCRIPT).toContain('JSON.stringify(__mjevFocusMarker(document))');
    // The old mismatch: MARKER_SCRIPT built its own object for ANY focused
    // element (not just editable ones) while SNAPSHOT_SCRIPT's focusedField()
    // applied the editable check - regression fixed by routing both through
    // __mjevFocusMarker instead.
    expect(MARKER_SCRIPT).not.toContain('{ label: name(focusedEl), value:');
  });
});

describe('__mjevFocusMarker (shared focused-field marker projection - the exact fragment both scripts embed)', () => {
  // role/name are normally each script's own large label/role-computation
  // helpers; these are minimal stand-ins sufficient to exercise
  // __mjevFocusMarker's own editable-gating logic (the regression under
  // test), while executing the REAL exported FOCUS_FINGERPRINT_SCRIPT /
  // DEEP_ACTIVE_SCRIPT source unmodified.
  function buildFocusMarker(): (doc: { body: unknown; activeElement: unknown }) => unknown {
    const role = (e: { role?: string }): string | null => e.role ?? null;
    const name = (e: { label?: string }): string => e.label ?? '';
    const source = `${DEEP_ACTIVE_SCRIPT}\n${FOCUS_FINGERPRINT_SCRIPT}\nreturn __mjevFocusMarker;`;

    return new Function('role', 'name', source)(role, name) as (doc: {
      body: unknown;
      activeElement: unknown;
    }) => unknown;
  }

  it('returns [label, value] for a focused editable element - fixture: a focused searchbox input', () => {
    const focusMarker = buildFocusMarker();
    const input = {
      role: 'searchbox',
      label: 'Search Wikipedia',
      value: 'large language model',
      tagName: 'INPUT',
    };
    const doc = { body: {}, activeElement: input };
    expect(focusMarker(doc)).toEqual(['Search Wikipedia', 'large language model']);
  });

  it('returns null for a focused NON-editable element - fixture: a focused button - this is the exact bug: MARKER_SCRIPT used to return an object for ANY focused element while SNAPSHOT_SCRIPT only did for editable ones, so checkFreshness() spuriously reported "changed" whenever any field was focused', () => {
    const focusMarker = buildFocusMarker();
    const button = { role: 'button', label: 'Search', tagName: 'BUTTON' };
    const doc = { body: {}, activeElement: button };
    expect(focusMarker(doc)).toBeNull();
  });

  it('returns null when nothing (or only the body) is focused', () => {
    const focusMarker = buildFocusMarker();
    const body = {};
    expect(focusMarker({ body, activeElement: body })).toBeNull();
    expect(focusMarker({ body, activeElement: null })).toBeNull();
  });
});
