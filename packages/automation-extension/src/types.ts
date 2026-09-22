/** Shared domain types for the snapshot/action-space/executor/check pipeline. */

/** One row from the injected snapshot script's `actions` array. */
export interface RawSnapshotAction {
  readonly node: string | null;
  readonly role?: string;
  readonly label: string;
  readonly kind: 'click' | 'fill' | 'select' | 'scroll' | 'wait' | 'submit';
  readonly value?: string;
  readonly current_value?: string;
  readonly checked?: string;
  readonly selected?: string;
  readonly expanded?: string;
  readonly delta?: number;
  readonly id?: string;
  /** Coarse 3x3 screen region ("top-left", "center", "bottom-right") or "above"/"below" for offscreen items. */
  readonly where?: string;
  /** Bounding box in target coordinates: [x, y, w, h], integers. */
  readonly box?: readonly [number, number, number, number];
  /** Short nearby/contextual text (<= 60 chars) that disambiguates identical labels. */
  readonly near?: string;
  /** True when the element exists but is outside the visible viewport/window; acting on it scrolls it into view first. */
  readonly offscreen?: boolean;
  /** Which perception produced this candidate; absent means the adapter's primary source. */
  readonly source?: 'dom' | 'ax' | 'ocr' | 'ax+ocr';
}

/** Metadata about the currently focused editable control, if any. */
export interface FocusedField {
  readonly role?: string;
  readonly label: string;
  readonly value?: string;
  readonly placeholder?: string;
}

export interface PageSnapshot {
  /** Browser: page URL. Native: `app://<bundleId>/<window title>`. */
  readonly url: string;
  readonly title: string;
  readonly w: number;
  readonly h: number;
  readonly text: string;
  readonly scroll: { readonly y: number; readonly height: number };
  readonly actions: readonly RawSnapshotAction[];
  /** Fingerprint of everything that would change Jev's decision; opaque, compared by deep-equality-of-JSON. */
  readonly marker: readonly unknown[];
  readonly omittedActions: number;
  readonly focused?: FocusedField | null;
}

/** One de-duplicated interactive element, keyed by its stamped `data-mjev-id`. Ported from model.py's `action_space`. */
export interface ActionSpaceElement {
  readonly index: string;
  readonly node: string;
  readonly role?: string;
  readonly label: string;
  readonly value?: string;
  readonly checked?: string;
  readonly selected?: string;
  readonly expanded?: string;
  readonly operations: readonly ('CLICK' | 'TYPE_TEXT' | 'SELECT' | 'SUBMIT')[];
  readonly options?: readonly {
    readonly index: string;
    readonly label: string;
    readonly value: string;
  }[];
}

/** Per-operation candidate targets, keyed by target index (or `index:optionIndex` for SELECT). */
export type ActionSpaceTargets = Readonly<
  Record<string, Readonly<Record<string, RawSnapshotAction>>>
>;

/** Non-targeted controls (scroll_down/scroll_up/wait), keyed by their upper-cased id. */
export type ActionSpaceControls = Readonly<Record<string, RawSnapshotAction>>;

export interface ActionSpace {
  readonly elements: readonly ActionSpaceElement[];
  readonly targets: ActionSpaceTargets;
  readonly controls: ActionSpaceControls;
}

export interface Decision {
  readonly operation: string;
  /** Resolved action id: element node id (CLICK/TYPE_TEXT), `node:option` (SELECT), or a control id. */
  readonly choice: string;
  readonly confidence: number;
  readonly jevLatencyMs: number;
  /** Probabilities for the answer that produced `choice` (target answer when one exists, else the operation answer). */
  readonly probabilities?: Readonly<Record<string, number>>;
}

export type SubgoalStatus =
  | 'achieved'
  | 'claimed_done'
  | 'check_failed'
  | 'stuck'
  | 'blocked'
  | 'needs_value'
  | 'budget_exhausted'
  | 'low_confidence';

export interface SubgoalStepRecord {
  readonly op: string;
  readonly target: string;
  readonly text?: string;
  readonly pageChanged: boolean;
  readonly jevLatencyMs: number;
  readonly confidence: number;
  /** True when this step was a confidence-gated wait retry rather than a normal Jev-chosen action. */
  readonly gated?: boolean;
  /** True when this step's freshness circuit breaker tripped (2 consecutive "page changed" re-observes) and the loop acted anyway instead of re-deciding indefinitely. */
  readonly freshnessUnstable?: boolean;
}

export interface LowConfidenceCandidate {
  readonly index: string;
  readonly label: string;
  readonly probability: number;
}

/** Returned when the chosen operation/target confidence stays below `minConfidence` after one re-check and one wait retry. */
export interface LowConfidenceInfo {
  readonly operation: string;
  readonly confidence: number;
  readonly topCandidates: readonly LowConfidenceCandidate[];
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

export interface CheckUrlMatches {
  readonly kind: 'url_matches';
  readonly pattern: string;
}

export interface CheckTextVisible {
  readonly kind: 'text_visible';
  readonly text: string;
}

export interface CheckElementPresent {
  readonly kind: 'element_present';
  readonly label: string;
  readonly role?: string;
}

export interface CheckElementAbsent {
  readonly kind: 'element_absent';
  readonly label: string;
  readonly role?: string;
}

export interface CheckFieldValue {
  readonly kind: 'field_value';
  readonly label: string;
  readonly equals?: string;
  readonly contains?: string;
}

export interface CheckAll {
  readonly kind: 'all';
  readonly checks: readonly Check[];
}

export interface CheckJevNoul {
  readonly kind: 'jev_noul';
  readonly question: string;
}

export type Check =
  | CheckUrlMatches
  | CheckTextVisible
  | CheckElementPresent
  | CheckElementAbsent
  | CheckFieldValue
  | CheckAll
  | CheckJevNoul;

export interface CheckResult {
  readonly passed: boolean;
  readonly judgedBy: 'code' | 'model';
  readonly detail?: string;
  readonly children?: readonly CheckResult[];
}
