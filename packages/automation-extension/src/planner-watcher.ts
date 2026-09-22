/**
 * Liveness watchdog for the planner agent launched by `browser.automation.run`.
 *
 * Without this, a planner that ends its turn (crashes, gets stuck, or
 * simply forgets) without ever calling `browser.automation.finish` blocks
 * the run until the full `timeoutMs` (default 15 minutes) elapses. This
 * polls `marshal.agent.get` (see
 * electron/marshal-runtime/agent-provider.ts:123-137 for the
 * `{agent: MARSHAL_RUNTIME_AGENT_SCHEMA | null}` output shape, and
 * :44-58 for `state: 'running' | 'idle'`) every `pollIntervalMs`
 * (~5s default). Two consecutive idle polls (~10s) send exactly one nudge
 * via `marshal.agent.send` (:138-164); if the agent is still idle six more
 * consecutive polls later (~30s), the run is resolved `failed` in place of
 * waiting out the full timeout.
 */
import { RUNTIME_PROTOCOL_VERSION } from './contracts.js';
import type { InvocationContext, RuntimeExecuteFn } from './contracts.js';
import type { RunRecord, RunStatus } from './run-store.js';

/**
 * `run.status` is mutated by `RunStore.finish()` from an entirely separate
 * capability invocation (`browser.automation.finish`, running concurrently
 * with this watcher's poll loop) - a mutation path TypeScript's control-flow
 * narrowing can't see. Reading it through a function call (instead of a bare
 * `run.status` property access) forces a fresh, un-narrowed read every time:
 * without this, TS incorrectly treats the second `run.status !== 'running'`
 * check below as statically unreachable, because nothing in this function's
 * own visible code path reassigns it between the two checks.
 */
function currentStatus(run: RunRecord): RunStatus {
  return run.status;
}

export interface Poller {
  stop(): void;
}

/** Test seam: production uses a real repeating timer; tests drive `onTick` manually. */
export type CreatePoller = (onTick: () => void | Promise<void>, intervalMs: number) => Poller;

export function defaultCreatePoller(
  onTick: () => void | Promise<void>,
  intervalMs: number,
): Poller {
  const handle = setInterval(() => {
    void onTick();
  }, intervalMs);
  return {
    stop: () => {
      clearInterval(handle);
    },
  };
}

export const DEFAULT_POLL_INTERVAL_MS = 5_000;
/** ~10s at the default 5s cadence. */
export const IDLE_POLLS_BEFORE_NUDGE = 2;
/** ~30s more at the default 5s cadence. */
export const IDLE_POLLS_AFTER_NUDGE_BEFORE_FAIL = 6;

export interface PlannerWatcherOptions {
  readonly run: RunRecord;
  readonly agentId: string;
  readonly execute: RuntimeExecuteFn;
  readonly context: InvocationContext;
  /** Resolves the run as failed; only called while the run is still 'running'. */
  readonly finishAsFailed: (evidence: string) => void;
  readonly createPoller?: CreatePoller;
  readonly pollIntervalMs?: number;
}

export interface PlannerWatcher {
  stop(): void;
}

function agentState(
  response: Awaited<ReturnType<RuntimeExecuteFn>> | undefined,
): string | undefined {
  const output = response?.result?.output as { agent?: { state?: string } | null } | undefined;
  return output?.agent?.state ?? undefined;
}

export function watchPlannerLiveness(options: PlannerWatcherOptions): PlannerWatcher {
  const { run, agentId, execute, context, finishAsFailed } = options;
  const createPoller = options.createPoller ?? defaultCreatePoller;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

  let idleStreak = 0;
  let nudged = false;
  let idleStreakAfterNudge = 0;

  const poller = createPoller(async () => {
    if (run.status !== 'running') {
      poller.stop();
      return;
    }

    const response = await execute(
      {
        protocolVersion: RUNTIME_PROTOCOL_VERSION,
        targetType: 'operation',
        target: 'marshal.agent.get',
        input: { agentId },
      },
      context,
    ).catch(() => undefined);

    if (currentStatus(run) !== 'running') {
      poller.stop();
      return;
    }

    const isIdle = agentState(response) === 'idle';
    if (!isIdle) {
      idleStreak = 0;
      idleStreakAfterNudge = 0;
      return;
    }

    if (!nudged) {
      idleStreak++;
      if (idleStreak < IDLE_POLLS_BEFORE_NUDGE) return;
      nudged = true;
      idleStreak = 0;
      await execute(
        {
          protocolVersion: RUNTIME_PROTOCOL_VERSION,
          targetType: 'operation',
          target: 'marshal.agent.send',
          input: {
            agentId,
            message: `You must call browser.automation.finish for runId ${run.runId} now with status/result/evidence.`,
          },
        },
        context,
      ).catch(() => undefined);
      return;
    }

    idleStreakAfterNudge++;
    if (idleStreakAfterNudge >= IDLE_POLLS_AFTER_NUDGE_BEFORE_FAIL) {
      poller.stop();
      if (currentStatus(run) === 'running') {
        finishAsFailed('planner ended without calling finish');
      }
    }
  }, pollIntervalMs);

  return {
    stop: () => {
      poller.stop();
    },
  };
}
