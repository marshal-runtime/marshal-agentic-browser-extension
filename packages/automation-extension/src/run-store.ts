import type { BrowserRequestContext } from './contracts.js';

export type RunStatus = 'running' | 'succeeded' | 'failed' | 'blocked' | 'timeout';

export interface SubgoalHistoryEntry {
  readonly goal: string;
  readonly status: string;
  readonly stepCount: number;
  readonly steps?: readonly string[];
  readonly at: string;
}

export interface RunFinishPayload {
  readonly status: 'succeeded' | 'failed' | 'blocked';
  readonly result?: unknown;
  readonly evidence?: readonly string[];
}

export interface RunRecord {
  readonly runId: string;
  readonly goal: string;
  readonly browserContext: BrowserRequestContext;
  readonly createdAt: string;
  /** Upper bound on browser.automation.subgoal calls for this run. */
  readonly maxSubgoals: number;
  status: RunStatus;
  plannerAgentId?: string;
  plannerSessionId?: string;
  subgoals: SubgoalHistoryEntry[];
  jevCalls: number;
  steps: number;
  /** Sum of per-step Jev decision latency reported by executed steps. */
  jevLatencyMs: number;
  /** Wall-clock spent inside subgoal/check/observe handlers (everything else is planner time). */
  subgoalMs: number;
  checkMs: number;
  observeMs: number;
  capabilityCalls: number;
  /** Epoch ms of the planner launch request and of its first browser.automation.* call. */
  launchedAtMs?: number;
  firstCapabilityCallAtMs?: number;
  /** False when the host rejected `allowedTools`; the run then fails without launching a planner. */
  allowlistApplied?: boolean;
  finishedAtMs?: number;
  finishPayload?: RunFinishPayload;
  /** Resolved exactly once, by `browser.automation.finish` or the run-level timeout. */
  readonly settle: (payload: RunFinishPayload) => void;
  readonly settled: Promise<RunFinishPayload>;
}

/**
 * In-memory registry of active/finished runs, scoped to one activated
 * extension instance. `browser.automation.run` blocks on `record.settled`;
 * `browser.automation.finish` (invoked by the planner, in a different
 * session) resolves it. This is the "in-memory promise resolved by finish"
 * half of the wait strategy described in the design doc.
 */
export class RunStore {
  private readonly runs = new Map<string, RunRecord>();

  create(
    runId: string,
    goal: string,
    browserContext: BrowserRequestContext,
    maxSubgoals: number,
  ): RunRecord {
    let settle!: (payload: RunFinishPayload) => void;
    const settled = new Promise<RunFinishPayload>((resolve) => {
      settle = resolve;
    });
    const record: RunRecord = {
      runId,
      goal,
      browserContext,
      createdAt: new Date().toISOString(),
      maxSubgoals,
      status: 'running',
      subgoals: [],
      jevCalls: 0,
      steps: 0,
      jevLatencyMs: 0,
      subgoalMs: 0,
      checkMs: 0,
      observeMs: 0,
      capabilityCalls: 0,
      settle,
      settled,
    };
    this.runs.set(runId, record);
    return record;
  }

  get(runId: string): RunRecord | undefined {
    return this.runs.get(runId);
  }

  requireActive(runId: string): RunRecord {
    const record = this.runs.get(runId);
    if (!record) throw new Error(`AUTOMATION_UNKNOWN_RUN: no run "${runId}"`);
    if (record.status !== 'running') {
      throw new Error(`AUTOMATION_RUN_FINISHED: run "${runId}" is already "${record.status}"`);
    }
    return record;
  }

  finish(runId: string, payload: RunFinishPayload): RunRecord {
    const record = this.requireActive(runId);
    record.status = payload.status;
    record.finishPayload = payload;
    record.finishedAtMs = Date.now();
    record.settle(payload);
    return record;
  }

  clear(): void {
    this.runs.clear();
  }
}
