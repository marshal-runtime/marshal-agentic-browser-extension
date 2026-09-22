import { randomUUID } from 'node:crypto';
import { navigate, saveScreenshot } from './browser-actions.js';
import { resolveBrowserContext } from './browser-session.js';
import {
  DESCRIPTORS,
  OBSERVE_DEFAULT_CHARS,
  OBSERVE_MAX_CHARS,
  OBSERVE_MAX_FIND_TERMS,
} from './capability-schemas.js';
import { evaluateCheck } from './checks.js';
import { DomAdapter } from './dom-adapter.js';
import type {
  AgenticBrowserRuntimeHost,
  CapabilityProvider,
  InvocationContext,
  JevClient,
  MarshalRuntimeAgent,
  MarshalRuntimeAgentLaunchOutput,
  RuntimeExecResponse,
  RuntimeExecuteFn,
} from './contracts.js';
import { RUNTIME_PROTOCOL_VERSION } from './contracts.js';
import { runSubgoal } from './executor.js';
import {
  asCheck,
  asRecord,
  elementTableLines,
  findSnippets,
  optionalCheck,
  optionalPositiveInt,
  optionalString,
  optionalStringArray,
  optionalValuesMap,
  requireString,
} from './input-validation.js';
import { buildPlannerPrompt } from './planner-prompt.js';
import type { CreatePoller } from './planner-watcher.js';
import { watchPlannerLiveness } from './planner-watcher.js';
import type { RunFinishPayload, RunRecord } from './run-store.js';
import { RunStore } from './run-store.js';

export const PROVIDER_ID = '@agentic-browser/automation-extension';

const DEFAULT_MAX_SUBGOALS = 12;
const DEFAULT_TIMEOUT_MS = 15 * 60_000;
const DEFAULT_MAX_STEPS_PER_SUBGOAL = 15;
/** Host tools the planner needs; everything else (MCP, skills, ~75 host tools) only adds prompt tokens. */
const PLANNER_ALLOWED_TOOLS = [
  'runtimeInvoke',
  'runtimeSearch',
  'runtimeExecuteTypeScript',
] as const;

const DEFAULT_MIN_CONFIDENCE = 0.4;

export interface AutomationConfiguration {
  readonly defaultPlannerModel?: string;
  readonly defaultJevModel?: string;
  readonly maxStepsPerSubgoal?: number;
  /** Confidence gating threshold for the executor (see executor.ts); default 0.4. */
  readonly minConfidence?: number;
  readonly [key: string]: unknown;
}

export interface AutomationProviderOptions {
  readonly host: AgenticBrowserRuntimeHost;
  readonly jevClient: JevClient;
  readonly execute: RuntimeExecuteFn;
  readonly configuration: AutomationConfiguration;
  /** Test seam: overrides crypto.randomUUID for deterministic runIds. */
  readonly createRunId?: () => string;
  /** Test seam: overrides the real setTimeout-based run timeout. */
  readonly scheduleTimeout?: (callback: () => void, delayMs: number) => { cancel: () => void };
  /** Test seam: overrides the real setInterval-based planner liveness poller. */
  readonly createPoller?: CreatePoller;
  /** Test seam: overrides the default ~5s planner liveness poll cadence. */
  readonly pollIntervalMs?: number;
}

function defaultScheduleTimeout(callback: () => void, delayMs: number): { cancel: () => void } {
  const handle = setTimeout(callback, delayMs);
  return {
    cancel: () => {
      clearTimeout(handle);
    },
  };
}

function record(output: unknown): { readonly output: unknown } {
  return { output };
}

function rejectsAllowedTools(response: RuntimeExecResponse): boolean {
  const error = response.error;
  if (!error) return false;
  return (
    /allowedTools/i.test(error.message) || /invalid[-_]?request|invalid[-_]?input/i.test(error.code)
  );
}

interface RunStatsSnapshot {
  readonly subgoals: number;
  readonly jevCalls: number;
  readonly steps: number;
  readonly durationMs: number;
  readonly jevLatencyMs: number;
  readonly subgoalMs: number;
  readonly checkMs: number;
  readonly observeMs: number;
  readonly startupMs?: number;
  readonly plannerThinkMs: number;
  readonly capabilityCalls: number;
  readonly allowlistApplied?: boolean;
}

function runStats(run: RunRecord, durationMs: number): RunStatsSnapshot {
  const busyMs = run.subgoalMs + run.checkMs + run.observeMs;
  const startupMs =
    run.launchedAtMs !== undefined && run.firstCapabilityCallAtMs !== undefined
      ? run.firstCapabilityCallAtMs - run.launchedAtMs
      : undefined;
  return {
    subgoals: run.subgoals.length,
    jevCalls: run.jevCalls,
    steps: run.steps,
    durationMs,
    jevLatencyMs: run.jevLatencyMs,
    subgoalMs: run.subgoalMs,
    checkMs: run.checkMs,
    observeMs: run.observeMs,
    ...(startupMs === undefined ? {} : { startupMs }),
    plannerThinkMs: Math.max(0, durationMs - busyMs),
    capabilityCalls: run.capabilityCalls,
    ...(run.allowlistApplied === undefined ? {} : { allowlistApplied: run.allowlistApplied }),
  };
}

/** Best-effort planner usage; the run result never depends on it. */
async function readPlannerUsage(
  execute: RuntimeExecuteFn,
  context: InvocationContext,
  agentId: string,
): Promise<Record<string, number>> {
  const call = async (
    target: string,
    input: unknown,
  ): Promise<Record<string, unknown> | undefined> => {
    try {
      const response = await execute(
        { protocolVersion: RUNTIME_PROTOCOL_VERSION, targetType: 'operation', target, input },
        context,
      );
      const output = response.status === 'success' ? response.result?.output : undefined;
      return typeof output === 'object' && output !== null
        ? (output as Record<string, unknown>)
        : undefined;
    } catch {
      return undefined;
    }
  };
  const [got, transcript] = await Promise.all([
    call('marshal.agent.get', { agentId }),
    call('marshal.agent.transcript', { agentId, limit: 1 }),
  ]);
  const agent = got?.['agent'] as { usage?: Record<string, unknown> } | null | undefined;
  const usage = agent?.usage;
  const stats: Record<string, number> = {};
  if (typeof transcript?.['messageCount'] === 'number')
    stats['plannerMessages'] = transcript['messageCount'];
  if (typeof usage?.['inputTokens'] === 'number')
    stats['plannerInputTokens'] = usage['inputTokens'];
  if (typeof usage?.['outputTokens'] === 'number')
    stats['plannerOutputTokens'] = usage['outputTokens'];
  if (typeof usage?.['cachedInputTokens'] === 'number')
    stats['plannerCachedInputTokens'] = usage['cachedInputTokens'];
  return stats;
}

export function createAutomationCapabilityProvider(
  options: AutomationProviderOptions,
): CapabilityProvider {
  const { host, jevClient, execute, configuration } = options;
  const noteCapabilityCall = (run: RunRecord): void => {
    run.capabilityCalls++;
    run.firstCapabilityCallAtMs ??= Date.now();
  };
  const createRunId = options.createRunId ?? (() => randomUUID());
  const scheduleTimeout = options.scheduleTimeout ?? defaultScheduleTimeout;
  const createPoller = options.createPoller;
  const pollIntervalMs = options.pollIntervalMs;
  const runStore = new RunStore();
  const byName = new Map(DESCRIPTORS.map((d) => [d.name, d]));

  async function handleRun(
    input: unknown,
    context: InvocationContext,
  ): Promise<{ readonly output: unknown }> {
    const value = asRecord(input, 'browser.automation.run');
    const goal = requireString(value['goal'], 'goal');
    const startUrl = optionalString(value['startUrl'], 'startUrl');
    const plannerModel =
      optionalString(value['plannerModel'], 'plannerModel') ?? configuration.defaultPlannerModel;
    const reasoningEffort =
      (value['reasoningEffort'] as 'low' | 'medium' | 'high' | undefined) ?? 'low';
    // NOTE: parsed and defaulted but never wired into buildPlannerPrompt/the
    // executor - the planner currently has no enforced subgoal cap. Flagged
    // to the user rather than silently deleted or silently made to do
    // something (see lint-cleanup task); the `void` below is only to satisfy
    // no-unused-vars without changing behavior.
    const maxSubgoals =
      optionalPositiveInt(value['maxSubgoals'], 'maxSubgoals') ?? DEFAULT_MAX_SUBGOALS;
    void maxSubgoals;
    const timeoutMs = optionalPositiveInt(value['timeoutMs'], 'timeoutMs') ?? DEFAULT_TIMEOUT_MS;
    const workspaceName = optionalString(value['workspaceName'], 'workspaceName');
    const repoPath = optionalString(value['repoPath'], 'repoPath');

    const status = await jevClient.status();
    if (status.state !== 'connected') {
      return record({ status: 'blocked', reason: 'jev-not-connected', hint: 'call jev.connect' });
    }

    const runId = createRunId();
    const browserContext = resolveBrowserContext(host, context);
    const run = runStore.create(runId, goal, browserContext);

    if (startUrl) {
      await navigate(host, browserContext, startUrl);
    }

    const launchInput = {
      task: buildPlannerPrompt({ runId, goal, ...(startUrl ? { startUrl } : {}) }),
      idempotencyKey: `automation-run:${runId}`,
      ...(plannerModel ? { model: plannerModel } : {}),
      ...(workspaceName ? { workspaceName } : {}),
      ...(repoPath ? { repoPath } : {}),
      reasoningEffort,
    };
    const launch = (input: Record<string, unknown>): Promise<RuntimeExecResponse> =>
      execute(
        {
          protocolVersion: RUNTIME_PROTOCOL_VERSION,
          targetType: 'operation' as const,
          target: 'marshal.agent.launch',
          input,
        },
        context,
      );
    const startedAt = Date.now();
    run.launchedAtMs = startedAt;
    run.allowlistApplied = true;
    const launchResponse = await launch({ ...launchInput, allowedTools: PLANNER_ALLOWED_TOOLS });
    if (launchResponse.status !== 'success' || !launchResponse.result) {
      // Fail closed: a planner without the allowlist gets every host tool (a live run used Bash for 100 s).
      const hostLacksAllowlist = rejectsAllowedTools(launchResponse);
      if (hostLacksAllowlist) run.allowlistApplied = false;
      runStore.finish(runId, { status: 'failed' });
      return record({
        runId,
        status: 'failed',
        result: undefined,
        evidence: [],
        stats: runStats(run, Date.now() - startedAt),
        error: hostLacksAllowlist
          ? 'This Marshal host does not support allowedTools on marshal.agent.launch; update Marshal to run the planner.'
          : (launchResponse.error?.message ?? 'marshal.agent.launch did not succeed'),
      });
    }
    const agent: MarshalRuntimeAgent = (
      launchResponse.result.output as MarshalRuntimeAgentLaunchOutput
    ).agent;
    run.plannerAgentId = agent.id;
    run.plannerSessionId = agent.sessionId ?? agent.id;

    // Guards against a planner that ends its turn without ever calling
    // browser.automation.finish - without this, such a run would otherwise
    // block for the full `timeoutMs` (default 15 minutes). See
    // planner-watcher.ts for the poll/nudge/fail cadence.
    const watcher = watchPlannerLiveness({
      run,
      agentId: agent.id,
      execute,
      context,
      finishAsFailed: (evidence) =>
        runStore.finish(runId, { status: 'failed', evidence: [evidence] }),
      ...(createPoller ? { createPoller } : {}),
      ...(pollIntervalMs === undefined ? {} : { pollIntervalMs }),
    });

    const timeoutPromise = new Promise<RunFinishPayload>((resolve) => {
      const timer = scheduleTimeout(() => {
        resolve({
          status: 'failed',
          result: undefined,
          evidence: [`Timed out after ${String(timeoutMs)}ms`],
        });
      }, timeoutMs);
      void run.settled.then(() => {
        timer.cancel();
      });
    });

    const outcome = await Promise.race([run.settled, timeoutPromise]);
    watcher.stop();
    const timedOut = run.status === 'running';
    if (timedOut) {
      run.status = 'timeout';
      await execute(
        {
          protocolVersion: RUNTIME_PROTOCOL_VERSION,
          targetType: 'operation',
          target: 'marshal.agent.cancel',
          input: { agentId: agent.id },
        },
        context,
      ).catch(() => undefined);
    }

    const durationMs = Date.now() - startedAt;
    const plannerUsage = await readPlannerUsage(execute, context, agent.id);
    const finalStatus = timedOut ? 'timeout' : outcome.status;
    return record({
      runId,
      status: finalStatus,
      result: outcome.result,
      evidence: outcome.evidence ?? [],
      plannerSessionId: run.plannerSessionId,
      stats: { ...runStats(run, durationMs), ...plannerUsage },
    });
  }

  async function handleSubgoal(input: unknown): Promise<{ readonly output: unknown }> {
    const value = asRecord(input, 'browser.automation.subgoal');
    const runId = requireString(value['runId'], 'runId');
    const goal = requireString(value['goal'], 'goal');
    const values = optionalValuesMap(value['values']);
    const check = optionalCheck(value['check']);
    const maxSteps =
      optionalPositiveInt(value['maxSteps'], 'maxSteps') ??
      configuration.maxStepsPerSubgoal ??
      DEFAULT_MAX_STEPS_PER_SUBGOAL;

    const run = runStore.requireActive(runId);
    noteCapabilityCall(run);
    const startedAt = Date.now();
    const adapter = new DomAdapter(host, run.browserContext);
    const result = await runSubgoal({
      adapter,
      jevClient,
      jevModel: configuration.defaultJevModel,
      goal,
      values,
      check,
      maxSteps,
      minConfidence: configuration.minConfidence ?? DEFAULT_MIN_CONFIDENCE,
    });
    run.subgoalMs += Date.now() - startedAt;
    run.jevCalls += result.jevCalls;
    run.steps += result.steps.length;
    run.jevLatencyMs += result.steps.reduce((total, step) => total + step.jevLatencyMs, 0);
    run.subgoals.push({
      goal,
      status: result.status,
      stepCount: result.steps.length,
      steps: result.steps.map(
        (step) =>
          `${step.op} ${step.target}${step.text ? ` ${JSON.stringify(step.text)}` : ''}${step.pageChanged ? '' : ' (no page change)'}`,
      ),
      at: new Date().toISOString(),
    });
    return record(result);
  }

  async function handleCheck(input: unknown): Promise<{ readonly output: unknown }> {
    const value = asRecord(input, 'browser.automation.check');
    const runId = requireString(value['runId'], 'runId');
    const check = asCheck(value['check']);
    const run = runStore.requireActive(runId);
    noteCapabilityCall(run);
    const startedAt = Date.now();
    const adapter = new DomAdapter(host, run.browserContext);
    const snapshot = await adapter.snapshot();
    const result = await evaluateCheck(check, snapshot, jevClient, configuration.defaultJevModel);
    run.checkMs += Date.now() - startedAt;
    return record(result);
  }

  async function handleObserve(input: unknown): Promise<{ readonly output: unknown }> {
    const value = asRecord(input, 'browser.automation.observe');
    const runId = requireString(value['runId'], 'runId');
    const wantScreenshot = value['screenshot'] === true;
    const find = optionalStringArray(value['find'], 'find', OBSERVE_MAX_FIND_TERMS);
    const maxChars = optionalPositiveInt(value['maxChars'], 'maxChars') ?? OBSERVE_DEFAULT_CHARS;
    if (maxChars > OBSERVE_MAX_CHARS) {
      throw new Error(
        `AUTOMATION_INVALID_INPUT: "maxChars" must be at most ${String(OBSERVE_MAX_CHARS)}`,
      );
    }
    const run = runStore.requireActive(runId);
    noteCapabilityCall(run);
    const startedAt = Date.now();
    const adapter = new DomAdapter(host, run.browserContext);
    const snapshot = await adapter.snapshot();
    const output: Record<string, unknown> = {
      url: snapshot.url,
      title: snapshot.title,
      textExcerpt: snapshot.text.slice(0, maxChars),
      ...(find ? { matches: findSnippets(await adapter.fullText(), find) } : {}),
      elements: elementTableLines(snapshot.actions),
    };
    if (wantScreenshot) {
      const saved = await saveScreenshot(await adapter.screenshot(), runId);
      output['screenshotPath'] = saved.path;
      output['screenshotBytes'] = saved.bytes;
    }
    run.observeMs += Date.now() - startedAt;
    return record(output);
  }

  function handleFinish(input: unknown): { readonly output: unknown } {
    const value = asRecord(input, 'browser.automation.finish');
    const runId = requireString(value['runId'], 'runId');
    const status = value['status'];
    if (status !== 'succeeded' && status !== 'failed' && status !== 'blocked') {
      throw new Error(
        'AUTOMATION_INVALID_INPUT: "status" must be one of succeeded, failed, blocked',
      );
    }
    const evidenceInput = value['evidence'];
    const evidenceRaw = typeof evidenceInput === 'string' ? [evidenceInput] : evidenceInput;
    if (
      evidenceRaw !== undefined &&
      (!Array.isArray(evidenceRaw) || evidenceRaw.some((e) => typeof e !== 'string'))
    ) {
      throw new Error('AUTOMATION_INVALID_INPUT: "evidence" must be an array of strings');
    }
    const run = runStore.finish(runId, {
      status,
      result: value['result'],
      ...(evidenceRaw ? { evidence: evidenceRaw as readonly string[] } : {}),
    });
    return record({ runId: run.runId, status: run.status });
  }

  function handleGet(input: unknown): { readonly output: unknown } {
    const value = asRecord(input, 'browser.automation.get');
    const runId = requireString(value['runId'], 'runId');
    const run = runStore.get(runId);
    if (!run) throw new Error(`AUTOMATION_UNKNOWN_RUN: no run "${runId}"`);
    return record(summarize(run));
  }

  return {
    id: PROVIDER_ID,
    version: '1.0.0',
    list: () => DESCRIPTORS,
    get: (name) => byName.get(name),
    async invoke(name, input, context) {
      if (!byName.has(name)) throw new Error(`AUTOMATION_UNKNOWN_CAPABILITY: ${name}`);
      if (context.signal?.aborted) throw new Error('AUTOMATION_ABORTED: invocation was aborted');
      switch (name) {
        case 'browser.automation.run':
          return handleRun(input, context);
        case 'browser.automation.subgoal':
          return handleSubgoal(input);
        case 'browser.automation.check':
          return handleCheck(input);
        case 'browser.automation.observe':
          return handleObserve(input);
        case 'browser.automation.finish':
          return handleFinish(input);
        case 'browser.automation.get':
          return handleGet(input);
        default:
          throw new Error(`AUTOMATION_UNKNOWN_CAPABILITY: ${name}`);
      }
    },
  };
}

interface RunSummary {
  readonly runId: string;
  readonly status: RunRecord['status'];
  readonly createdAt: string;
  readonly plannerSessionId: string | undefined;
  readonly stats: RunStatsSnapshot;
  readonly subgoals: RunRecord['subgoals'];
  readonly result?: unknown;
  readonly evidence?: readonly string[];
}

function summarize(run: RunRecord): RunSummary {
  return {
    runId: run.runId,
    status: run.status,
    createdAt: run.createdAt,
    plannerSessionId: run.plannerSessionId,
    stats: runStats(run, (run.finishedAtMs ?? Date.now()) - Date.parse(run.createdAt)),
    subgoals: run.subgoals,
    ...(run.finishPayload
      ? { result: run.finishPayload.result, evidence: run.finishPayload.evidence ?? [] }
      : {}),
  };
}

export { DESCRIPTORS as AUTOMATION_CAPABILITY_DESCRIPTORS };
