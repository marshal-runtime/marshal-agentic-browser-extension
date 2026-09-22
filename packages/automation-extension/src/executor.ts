/**
 * The Jev step-loop executor for `browser.automation.subgoal`, ported from
 * jev-ultrafast's Agent.command('tick'/'predict'/'act') state machine
 * (/tmp/jev-ultrafast/jev_ultrafast/agent.py, MIT - see README.md), adapted
 * per this extension's design:
 *   - TYPE_TEXT values come from the planner's `values` map, never a text
 *     LLM call (see values.ts).
 *   - DONE is verified by a code `Check` (checks.ts) when the caller
 *     supplies one; otherwise it is reported as `claimed_done`, explicitly
 *     unverified.
 *   - "3 consecutive no-op actions -> stuck" mirrors agent.py's exact
 *     window-of-3 check (not a running counter), including that a `wait`
 *     action in the last 3 never counts as a no-op run.
 *   - Perception is adapter-agnostic (see adapter.ts): this loop only ever
 *     calls `PerceptionAdapter.snapshot/marker/act`, so a DOM tab, a native
 *     Accessibility tree, or an OCR-backed target all drive the same code.
 *   - Confidence gating: when the chosen operation/target confidence is
 *     below `minConfidence`, the loop never acts on it blindly - it re-checks
 *     freshness, retries once with a WAIT, and otherwise surfaces
 *     `low_confidence` with the top candidate alternatives for the planner
 *     to disambiguate.
 */
import { buildActionSpace } from './action-space.js';
import { markersEqual } from './browser-actions.js';
import { evaluateCheck } from './checks.js';
import type { JevClient } from './contracts.js';
import { looksLikeSecretField, resolveFieldValue } from './values.js';
import type {
  ActionSpace,
  Check,
  CheckResult,
  Decision,
  LowConfidenceInfo,
  PageSnapshot,
  SubgoalStatus,
  SubgoalStepRecord,
} from './types.js';
import { decideNextAction } from './decide.js';
import type { PerceptionAdapter } from './adapter.js';

export interface RunSubgoalOptions {
  readonly adapter: PerceptionAdapter;
  readonly jevClient: JevClient;
  readonly jevModel: string | undefined;
  readonly goal: string;
  readonly values: Readonly<Record<string, string>> | undefined;
  readonly check: Check | undefined;
  readonly maxSteps: number;
  /** Below this confidence, the loop gates the action instead of performing it. Omit to disable gating. */
  readonly minConfidence?: number;
}

export interface RunSubgoalResult {
  readonly status: SubgoalStatus;
  readonly steps: readonly SubgoalStepRecord[];
  readonly check?: CheckResult;
  readonly page: { readonly url: string; readonly title: string };
  readonly jevCalls: number;
  readonly missingField?: string;
  readonly lowConfidence?: LowConfidenceInfo;
  /** Total number of freshness re-observes (adapter.marker()/snapshot() calls made only to check staleness) during the run. Never counts toward jevCalls - a freshness check never calls Jev. */
  readonly freshnessRechecks: number;
  /** True if the freshness circuit breaker tripped at least once (2 consecutive "page changed" re-observes with no action taken) - the loop acted on the latest snapshot instead of re-deciding indefinitely. See SubgoalStepRecord.freshnessUnstable for which step. */
  readonly freshnessUnstable?: boolean;
}

interface HistoryEntry {
  readonly action: string;
  readonly kind: string;
  readonly pageChanged: boolean | null;
}

type FreshnessResult =
  | { readonly changed: false }
  | { readonly changed: true; readonly fresh: PageSnapshot };

/**
 * Mirrors agent.py's `fresh(page)` guard. When the adapter offers a fast
 * `marker()` path, use it to decide cheaply whether a full snapshot is even
 * needed; otherwise a single full snapshot serves as both the freshness
 * check and (if changed) the new snapshot, exactly like the pre-adapter
 * `takeSnapshot`-only implementation.
 */
async function checkFreshness(
  adapter: PerceptionAdapter,
  snapshot: PageSnapshot,
): Promise<FreshnessResult> {
  if (adapter.marker) {
    const marker = await adapter.marker();
    if (markersEqual(marker, snapshot.marker)) return { changed: false };
    return { changed: true, fresh: await adapter.snapshot() };
  }
  const fresh = await adapter.snapshot();
  if (markersEqual(fresh.marker, snapshot.marker)) return { changed: false };
  return { changed: true, fresh };
}

function buildLowConfidenceInfo(decision: Decision, space: ActionSpace): LowConfidenceInfo {
  const candidates = space.targets[decision.operation];
  const entries = Object.entries(
    decision.probabilities ?? { [decision.choice]: decision.confidence },
  );
  const topCandidates = entries
    .map(([index, probability]) => ({
      index,
      label: candidates?.[index]?.label ?? space.controls[index]?.label ?? index,
      probability,
    }))
    .sort((a, b) => b.probability - a.probability)
    .slice(0, 5);
  return { operation: decision.operation, confidence: decision.confidence, topCandidates };
}

/**
 * A run of `checkFreshness()` calls that keeps reporting "changed" (e.g. an
 * adapter whose marker()/snapshot() never agree - see the hybrid-adapter
 * mismatch this circuit breaker was added for) would otherwise make the loop
 * `continue` back to `decideNextAction` forever, burning one real Jev call
 * per re-observe (48 calls, 0 steps, in the run that prompted this). After
 * this many CONSECUTIVE "changed" results with no action taken in between,
 * the breaker trips: stop re-deciding and act on the latest snapshot anyway,
 * flagged `freshnessUnstable`.
 */
const MAX_CONSECUTIVE_FRESHNESS_CHANGES = 2;

export async function runSubgoal(options: RunSubgoalOptions): Promise<RunSubgoalResult> {
  const { adapter, jevClient, jevModel, goal, values, check, maxSteps, minConfidence } = options;
  const steps: SubgoalStepRecord[] = [];
  const actionKinds: string[] = [];
  const history: HistoryEntry[] = [];
  let jevCalls = 0;
  let gatedRetried = false;

  let snapshot = await adapter.snapshot();
  const maxIterations = Math.max(maxSteps * 3, 3);
  let iterations = 0;

  // Stats/circuit-breaker state for checkFreshness() re-observes. A
  // freshness re-observe only ever calls adapter.marker()/snapshot() - never
  // Jev - so freshnessRechecks is always tracked separately from jevCalls.
  let freshnessRechecks = 0;
  let consecutiveFreshnessChanges = 0;
  let freshnessUnstable = false;

  /** Wraps checkFreshness() with the stats counter and the circuit breaker; reassigns `snapshot` when changed. */
  async function checkFreshnessGate(): Promise<{ changed: boolean; giveUp: boolean }> {
    freshnessRechecks++;
    const freshness = await checkFreshness(adapter, snapshot);
    if (!freshness.changed) {
      consecutiveFreshnessChanges = 0;
      return { changed: false, giveUp: false };
    }
    snapshot = freshness.fresh;
    consecutiveFreshnessChanges++;
    if (consecutiveFreshnessChanges >= MAX_CONSECUTIVE_FRESHNESS_CHANGES) {
      freshnessUnstable = true;
      consecutiveFreshnessChanges = 0;
      return { changed: true, giveUp: true };
    }
    return { changed: true, giveUp: false };
  }

  function finish(status: SubgoalStatus, extra: Partial<RunSubgoalResult> = {}): RunSubgoalResult {
    return {
      status,
      steps,
      page: pageOf(snapshot),
      jevCalls,
      freshnessRechecks,
      ...(freshnessUnstable ? { freshnessUnstable: true } : {}),
      ...extra,
    };
  }

  while (steps.length < maxSteps) {
    if (iterations >= maxIterations) {
      return finish('budget_exhausted');
    }
    iterations++;

    const space = buildActionSpace(snapshot.actions);
    const { decision, action } = await decideNextAction(
      jevClient,
      space,
      goal,
      history,
      { url: snapshot.url, title: snapshot.title, text: snapshot.text },
      jevModel,
      undefined,
      snapshot.focused,
    );
    jevCalls++;

    const isTerminal = decision.operation === 'DONE' || decision.operation === 'BLOCKED';

    if (!isTerminal && minConfidence !== undefined && decision.confidence < minConfidence) {
      const fr = await checkFreshnessGate();
      if (fr.changed && !fr.giveUp) {
        continue;
      }
      if (!gatedRetried) {
        gatedRetried = true;
        await adapter.act({
          node: null,
          kind: 'wait',
          label: 'Wait for the page to update',
          id: 'wait',
        });
        const after = await adapter.snapshot();
        const pageChanged = !markersEqual(after.marker, snapshot.marker);
        steps.push({
          op: decision.operation,
          target: action.label,
          pageChanged,
          jevLatencyMs: decision.jevLatencyMs,
          confidence: decision.confidence,
          gated: true,
          ...(fr.giveUp ? { freshnessUnstable: true } : {}),
        });
        history.push({ action: 'Wait (low confidence retry)', kind: 'wait', pageChanged });
        snapshot = after;
        continue;
      }
      return finish('low_confidence', { lowConfidence: buildLowConfidenceInfo(decision, space) });
    }
    gatedRetried = false;

    if (isTerminal) {
      const fr = await checkFreshnessGate();
      if (fr.changed && !fr.giveUp) {
        continue;
      }
      if (decision.operation === 'BLOCKED') {
        return finish('blocked');
      }
      if (check) {
        const result = await evaluateCheck(check, snapshot, jevClient, jevModel);
        return finish(result.passed ? 'achieved' : 'check_failed', { check: result });
      }
      return finish('claimed_done');
    }

    let text: string | undefined;
    if (action.kind === 'fill') {
      text = resolveFieldValue(action.label, values);
      if (text === undefined) {
        return finish('needs_value', { missingField: action.label });
      }
    }

    // Freshness check before acting: skip the action and re-decide if the
    // page changed since the snapshot the decision was based on - unless the
    // circuit breaker has tripped, in which case act anyway on the latest
    // snapshot rather than looping back to decideNextAction indefinitely.
    const preActFreshness = await checkFreshnessGate();
    const actedDespiteInstability = preActFreshness.changed && preActFreshness.giveUp;
    if (preActFreshness.changed && !preActFreshness.giveUp) {
      continue;
    }

    await adapter.act(action, text);
    let after = await adapter.snapshot();
    let pageChanged = !markersEqual(after.marker, snapshot.marker);

    // A click that appears to be a no-op is sometimes a swallowed click (a
    // widget re-rendering/blurring right as the native click lands) rather
    // than a genuinely inert target - retry ONCE via the adapter's in-page
    // 'js' strategy (scrollIntoView + focus + click) before accepting it as
    // a real no-op step.
    if (!pageChanged && action.kind === 'click') {
      await adapter.act(action, text, { strategy: 'js' });
      const retryAfter = await adapter.snapshot();
      const retryChanged = !markersEqual(retryAfter.marker, snapshot.marker);
      if (retryChanged) {
        after = retryAfter;
        pageChanged = retryChanged;
      }
    }

    steps.push({
      op: decision.operation,
      target: action.label,
      ...(text === undefined
        ? {}
        : {
            text: looksLikeSecretField(action.label) ? `[redacted:${String(text.length)}]` : text,
          }),
      pageChanged,
      jevLatencyMs: decision.jevLatencyMs,
      confidence: decision.confidence,
      ...(actedDespiteInstability ? { freshnessUnstable: true } : {}),
    });
    actionKinds.push(action.kind);
    history.push({ action: action.label, kind: action.kind, pageChanged });

    if (steps.length >= 3) {
      const lastThree = steps.slice(-3);
      const lastThreeKinds = actionKinds.slice(-3);
      const allNoOp =
        lastThree.every((s) => !s.pageChanged) && lastThreeKinds.every((k) => k !== 'wait');
      if (allNoOp) {
        return finish('stuck', { page: pageOf(after) });
      }
    }

    snapshot = after;
  }

  return finish('budget_exhausted');
}

function pageOf(snapshot: PageSnapshot): { url: string; title: string } {
  return { url: snapshot.url, title: snapshot.title };
}
