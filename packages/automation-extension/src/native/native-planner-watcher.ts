/**
 * Liveness watchdog for the planner launched by `computer.automation.run`.
 * Same poll/nudge/fail cadence as `../planner-watcher.ts`, duplicated
 * because that module's `watchPlannerLiveness` is typed against the
 * browser-shaped `RunRecord` and this run record is native-shaped
 * (see native-run-store.ts).
 */
import { RUNTIME_PROTOCOL_VERSION } from '../contracts.js';
import type { InvocationContext, RuntimeExecuteFn } from '../contracts.js';
import type { NativeRunRecord, NativeRunStatus } from './native-run-store.js';
import {
  DEFAULT_POLL_INTERVAL_MS,
  IDLE_POLLS_AFTER_NUDGE_BEFORE_FAIL,
  IDLE_POLLS_BEFORE_NUDGE,
  type CreatePoller,
  defaultCreatePoller,
} from '../planner-watcher.js';

/**
 * `run.status` is mutated by `NativeRunStore.finish()` from an entirely
 * separate capability invocation (`computer.automation.finish`, running
 * concurrently with this watcher's poll loop) - a mutation path TypeScript's
 * control-flow narrowing can't see. Reading it through a function call
 * (instead of a bare `run.status` property access) forces a fresh,
 * un-narrowed read every time: without this, TS incorrectly treats the
 * second `run.status !== 'running'` check below as statically unreachable,
 * because nothing in this function's own visible code path reassigns it
 * between the two checks. Same fix as ../planner-watcher.ts's
 * `currentStatus`.
 */
function currentStatus(run: NativeRunRecord): NativeRunStatus {
  return run.status;
}

export interface NativePlannerWatcherOptions {
  readonly run: NativeRunRecord;
  readonly agentId: string;
  readonly execute: RuntimeExecuteFn;
  readonly context: InvocationContext;
  readonly finishAsFailed: (evidence: string) => void;
  readonly createPoller?: CreatePoller;
  readonly pollIntervalMs?: number;
}

export interface NativePlannerWatcher {
  stop(): void;
}

function agentState(
  response: Awaited<ReturnType<RuntimeExecuteFn>> | undefined,
): string | undefined {
  const output = response?.result?.output as { agent?: { state?: string } | null } | undefined;
  return output?.agent?.state ?? undefined;
}

export function watchNativePlannerLiveness(
  options: NativePlannerWatcherOptions,
): NativePlannerWatcher {
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
            message: `You must call computer.automation.finish for runId ${run.runId} now with status/result/evidence.`,
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
