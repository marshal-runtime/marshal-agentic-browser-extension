/**
 * In-memory registry of `computer.automation.run` runs, mirroring
 * `../run-store.ts` but keyed to a `PerceptionAdapter` (an `AxAdapter`
 * pinned to a native app, optionally wrapped in a `HybridAdapter` for OCR
 * fallback) instead of a `BrowserRequestContext`. Kept as a separate small
 * type because `RunRecord` is declared browser-shaped and this package
 * treats that file as owned by the DOM-adapter work.
 */
import type { PerceptionAdapter } from '../adapter.js';

export type NativeRunStatus = 'running' | 'succeeded' | 'failed' | 'blocked' | 'timeout';

export interface NativeSubgoalHistoryEntry {
  readonly goal: string;
  readonly status: string;
  readonly stepCount: number;
  readonly steps?: readonly string[];
  readonly at: string;
}

export interface NativeRunFinishPayload {
  readonly status: 'succeeded' | 'failed' | 'blocked' | 'timeout';
  readonly result?: unknown;
  readonly evidence?: readonly string[];
  /** Set when the run never got a real result (launch failure, timeout); see computer.automation.get. */
  readonly error?: string;
}

export interface NativeRunRecord {
  readonly runId: string;
  readonly goal: string;
  readonly adapter: PerceptionAdapter;
  readonly createdAt: string;
  status: NativeRunStatus;
  plannerAgentId?: string;
  plannerSessionId?: string;
  subgoals: NativeSubgoalHistoryEntry[];
  jevCalls: number;
  steps: number;
  jevLatencyMs: number;
  subgoalMs: number;
  checkMs: number;
  observeMs: number;
  capabilityCalls: number;
  launchedAtMs?: number;
  firstCapabilityCallAtMs?: number;
  allowlistApplied?: boolean;
  finishedAtMs?: number;
  finishPayload?: NativeRunFinishPayload;
  readonly settle: (payload: NativeRunFinishPayload) => void;
  readonly settled: Promise<NativeRunFinishPayload>;
}

export class NativeRunStore {
  private readonly runs = new Map<string, NativeRunRecord>();

  create(runId: string, goal: string, adapter: PerceptionAdapter): NativeRunRecord {
    let settle!: (payload: NativeRunFinishPayload) => void;
    const settled = new Promise<NativeRunFinishPayload>((resolve) => {
      settle = resolve;
    });
    const record: NativeRunRecord = {
      runId,
      goal,
      adapter,
      createdAt: new Date().toISOString(),
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

  get(runId: string): NativeRunRecord | undefined {
    return this.runs.get(runId);
  }

  /** All runs known to this store (any status), in creation order. See computer.automation.list. */
  list(): readonly NativeRunRecord[] {
    return [...this.runs.values()];
  }

  requireActive(runId: string): NativeRunRecord {
    const record = this.runs.get(runId);
    if (!record) throw new Error(`AUTOMATION_UNKNOWN_RUN: no run "${runId}"`);
    if (record.status !== 'running') {
      throw new Error(`AUTOMATION_RUN_FINISHED: run "${runId}" is already "${record.status}"`);
    }
    return record;
  }

  finish(runId: string, payload: NativeRunFinishPayload): NativeRunRecord {
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
