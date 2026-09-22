/**
 * `computer.automation.*` capability provider: the same three-tier design as
 * `../capabilities.ts` (planner agent -> code executor -> code checks), but
 * targeting a native macOS app's Accessibility tree via `AxAdapter` /
 * `marshal-ax-helper` instead of a browser tab. Reuses the target-agnostic
 * executor/checks/action-space pipeline unchanged.
 */
import { randomUUID } from 'node:crypto';
import { existsSync } from 'fs';
import { buildActionSpace } from '../action-space.js';
import type { PerceptionAdapter } from '../adapter.js';
import { evaluateCheck } from '../checks.js';
import type {
  CapabilityDescriptor,
  CapabilityProvider,
  InvocationContext,
  JevClient,
  MarshalRuntimeAgent,
  MarshalRuntimeAgentLaunchOutput,
  RuntimeExecResponse,
  RuntimeExecuteFn,
} from '../contracts.js';
import { RUNTIME_PROTOCOL_VERSION } from '../contracts.js';
import { runSubgoal } from '../executor.js';
import type { CreatePoller } from '../planner-watcher.js';
import { AxAdapter } from './ax-adapter.js';
import { AxHelperClient, resolveAxHelperPath } from './ax-helper-client.js';
import { HybridAdapter, type OcrMode } from './hybrid-adapter.js';
import { buildNativePlannerPrompt } from './native-planner-prompt.js';
import { watchNativePlannerLiveness } from './native-planner-watcher.js';
import type { NativeRunFinishPayload, NativeRunRecord } from './native-run-store.js';
import { NativeRunStore } from './native-run-store.js';
import { OcrClient, resolveOcrHelperPath } from './ocr-client.js';
import {
  asCheck,
  asRecord,
  findSnippets,
  optionalCheck,
  optionalPositiveInt,
  optionalStringArray,
  optionalValuesMap,
  requireString,
} from './native-validation.js';

export const NATIVE_PROVIDER_ID = '@agentic-browser/automation-extension/computer';
const PROTOCOL_VERSION = '1.0.0';

const DEFAULT_TIMEOUT_MS = 15 * 60_000;
const DEFAULT_MAX_STEPS_PER_SUBGOAL = 15;
const PLANNER_ALLOWED_TOOLS = [
  'runtimeInvoke',
  'runtimeSearch',
  'runtimeExecuteTypeScript',
] as const;
const OBSERVE_DEFAULT_CHARS = 1000;
const OBSERVE_MAX_CHARS = 8000;
const OBSERVE_MAX_FIND_TERMS = 16;

export interface NativeAutomationConfiguration {
  readonly axHelperPath?: string;
  readonly ocrHelperPath?: string;
  readonly ocrMode?: OcrMode;
  readonly defaultPlannerModel?: string;
  readonly defaultJevModel?: string;
  readonly maxStepsPerSubgoal?: number;
  readonly minConfidence?: number;
  readonly [key: string]: unknown;
}

export interface NativeAutomationProviderOptions {
  readonly jevClient: JevClient;
  readonly execute: RuntimeExecuteFn;
  readonly configuration: NativeAutomationConfiguration;
  readonly packageRoot: string;
  readonly createRunId?: () => string;
  readonly scheduleTimeout?: (callback: () => void, delayMs: number) => { cancel: () => void };
  readonly createPoller?: CreatePoller;
  readonly pollIntervalMs?: number;
  /** Test seam: overrides the real AxHelperClient. */
  readonly createHelperClient?: () => AxHelperClient;
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

interface NativeRunStatsSnapshot {
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

function runStats(run: NativeRunRecord, durationMs: number): NativeRunStatsSnapshot {
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

function elementTableLines(actions: Parameters<typeof buildActionSpace>[0]): readonly string[] {
  const space = buildActionSpace(actions);
  return space.elements.map((element) => {
    const value = element.value !== undefined ? ` = ${JSON.stringify(element.value)}` : '';
    const role = element.role ?? 'element';
    return `[${element.index}] ${role} ${JSON.stringify(element.label)}${value}`;
  });
}

interface HelperApp {
  readonly bundleId: string;
  readonly name: string;
  readonly pid: number;
  readonly frontmost: boolean;
}

function findApp(apps: readonly HelperApp[], query: string): HelperApp | undefined {
  const exact = apps.find((a) => a.bundleId === query);
  if (exact) return exact;
  const lower = query.toLowerCase();
  return (
    apps.find((a) => a.name.toLowerCase() === lower) ??
    apps.find((a) => a.name.toLowerCase().includes(lower))
  );
}

const RUN_INPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['goal', 'app'],
  properties: {
    goal: { type: 'string', minLength: 1 },
    app: {
      type: 'string',
      minLength: 1,
      description: 'Bundle id (e.g. com.apple.TextEdit) or app name.',
    },
    plannerModel: { type: 'string' },
    reasoningEffort: { enum: ['low', 'medium', 'high'] },
    timeoutMs: { type: 'integer', minimum: 1 },
    workspaceName: { type: 'string' },
    repoPath: { type: 'string' },
    ocrMode: {
      enum: ['auto', 'always', 'never'],
      description: 'OCR fallback over the AX tree; default "auto".',
    },
  },
} as const;

const STRING_ARRAY_SCHEMA = { type: 'array', items: { type: 'string' } } as const;

function descriptor(
  suffix: string,
  title: string,
  description: string,
  inputSchema: CapabilityDescriptor['inputSchema'],
  outputSchema: CapabilityDescriptor['outputSchema'],
  risk: 'low' | 'medium' | 'high',
): CapabilityDescriptor {
  const name = `computer.automation.${suffix}`;
  return {
    protocolVersion: PROTOCOL_VERSION,
    name,
    version: '1.0.0',
    title,
    description,
    tags: ['computer-use', 'automation', 'jev', 'accessibility'],
    inputSchema,
    outputSchema,
    permissions: [{ permission: `marshal.tool.invoke:${name}`, risk }],
  };
}

const DESCRIPTORS: readonly CapabilityDescriptor[] = [
  descriptor(
    'apps',
    'List running GUI apps',
    'Returns running macOS GUI apps with bundleId/name/pid, and Accessibility/Screen Recording permission status.',
    { type: 'object', additionalProperties: false, properties: {} },
    {
      type: 'object',
      properties: {
        permissions: { type: 'object' },
        apps: { type: 'array', items: { type: 'object' } },
      },
      additionalProperties: false,
    },
    'low',
  ),
  descriptor(
    'run',
    'Run a native app automation goal end to end',
    'Focuses the target app, launches a cheap planner agent driving it via the Accessibility tree, and waits for it to finish.',
    RUN_INPUT_SCHEMA,
    {
      type: 'object',
      properties: {
        runId: { type: 'string' },
        status: { type: 'string' },
        result: {},
        evidence: STRING_ARRAY_SCHEMA,
        plannerSessionId: { type: 'string' },
        stats: { type: 'object' },
        error: { type: 'string' },
        reason: { type: 'string' },
        hint: { type: 'string' },
      },
      additionalProperties: false,
    },
    'high',
  ),
  descriptor(
    'subgoal',
    'Drive one subgoal with the Jev step-loop executor against a native app',
    'Runs the code-driven observe/decide/act loop until DONE/BLOCKED/stuck/budget for one small subgoal.',
    {
      type: 'object',
      additionalProperties: false,
      required: ['runId', 'goal'],
      properties: {
        runId: { type: 'string', minLength: 1 },
        goal: { type: 'string', minLength: 1 },
        values: { type: 'object' },
        check: { type: 'object' },
        maxSteps: { type: 'integer', minimum: 1 },
      },
    },
    {
      type: 'object',
      properties: {
        status: { type: 'string' },
        steps: { type: 'array', items: { type: 'object' } },
        page: { type: 'object' },
        jevCalls: { type: 'integer' },
        freshnessRechecks: { type: 'integer' },
        freshnessUnstable: { type: 'boolean' },
        check: { type: 'object' },
        missingField: { type: 'string' },
        lowConfidence: { type: 'object' },
      },
      additionalProperties: false,
    },
    'high',
  ),
  descriptor(
    'check',
    'Evaluate a code or model postcondition against the current app state',
    'Evaluates a Check (url_matches/text_visible/element_present/element_absent/field_value/all/jev_noul) in code.',
    {
      type: 'object',
      additionalProperties: false,
      required: ['runId', 'check'],
      properties: { runId: { type: 'string', minLength: 1 }, check: { type: 'object' } },
    },
    {
      type: 'object',
      properties: {
        passed: { type: 'boolean' },
        judgedBy: { type: 'string' },
        detail: { type: 'string' },
        children: { type: 'array', items: { type: 'object' } },
      },
      additionalProperties: false,
    },
    'low',
  ),
  descriptor(
    'observe',
    'Read a compact snapshot of the bound native app',
    '"find" adds snippets around each term from the app text (matches); "maxChars" widens the excerpt.',
    {
      type: 'object',
      additionalProperties: false,
      required: ['runId'],
      properties: {
        runId: { type: 'string', minLength: 1 },
        find: {
          type: 'array',
          items: { type: 'string', minLength: 1 },
          maxItems: OBSERVE_MAX_FIND_TERMS,
        },
        maxChars: { type: 'integer', minimum: 1, maximum: OBSERVE_MAX_CHARS },
      },
    },
    {
      type: 'object',
      properties: {
        url: { type: 'string' },
        title: { type: 'string' },
        textExcerpt: { type: 'string' },
        matches: { type: 'object' },
        elements: STRING_ARRAY_SCHEMA,
      },
      additionalProperties: false,
    },
    'low',
  ),
  descriptor(
    'finish',
    'End an automation run',
    'Resolves the run started by computer.automation.run with a final status/result/evidence.',
    {
      type: 'object',
      additionalProperties: false,
      required: ['runId', 'status'],
      properties: {
        runId: { type: 'string', minLength: 1 },
        status: { enum: ['succeeded', 'failed', 'blocked'] },
        result: {},
        evidence: { anyOf: [{ type: 'array', items: { type: 'string' } }, { type: 'string' }] },
      },
    },
    {
      type: 'object',
      properties: { runId: { type: 'string' }, status: { type: 'string' } },
      additionalProperties: false,
    },
    'low',
  ),
  descriptor(
    'get',
    'Read an automation run record',
    'Returns the run status, stats, and subgoal history.',
    {
      type: 'object',
      additionalProperties: false,
      required: ['runId'],
      properties: { runId: { type: 'string', minLength: 1 } },
    },
    {
      type: 'object',
      properties: {
        runId: { type: 'string' },
        status: { type: 'string' },
        createdAt: { type: 'string' },
        plannerSessionId: { type: 'string' },
        stats: { type: 'object' },
        subgoals: { type: 'array', items: { type: 'object' } },
        result: {},
        evidence: STRING_ARRAY_SCHEMA,
      },
      additionalProperties: false,
    },
    'low',
  ),
];

export function createNativeCapabilityProvider(
  options: NativeAutomationProviderOptions,
): CapabilityProvider {
  const { jevClient, execute, configuration, packageRoot } = options;
  const createRunId = options.createRunId ?? (() => randomUUID());
  const scheduleTimeout = options.scheduleTimeout ?? defaultScheduleTimeout;
  const runStore = new NativeRunStore();
  const byName = new Map(DESCRIPTORS.map((d) => [d.name, d]));

  let helperClient: AxHelperClient | undefined;
  // Not `async`: this has no `await` (resolveAxHelperPath is synchronous).
  // The try/catch replicates async's throw-becomes-rejection behavior
  // exactly (see extension.ts's `activate` for the same pattern).
  const helper = (): Promise<AxHelperClient> => {
    try {
      if (helperClient) return Promise.resolve(helperClient);
      helperClient =
        options.createHelperClient?.() ??
        new AxHelperClient({
          binaryPath: resolveAxHelperPath(packageRoot, configuration.axHelperPath),
        });
      return Promise.resolve(helperClient);
    } catch (error) {
      return Promise.reject(error as Error);
    }
  };

  /** Wraps the AX adapter with OCR fallback (HybridAdapter) when an OCR helper binary is actually installed and ocrMode allows it; otherwise the AX adapter alone. */
  const buildAdapter = (
    axAdapter: AxAdapter,
    goal: string,
    ocrMode: OcrMode,
  ): PerceptionAdapter => {
    if (ocrMode === 'never') return axAdapter;
    const ocrHelperPath = resolveOcrHelperPath(packageRoot, configuration.ocrHelperPath);
    if (!existsSync(ocrHelperPath)) return axAdapter;
    const ocrClient = new OcrClient({ helperPath: ocrHelperPath });
    return new HybridAdapter(axAdapter, ocrClient, axAdapter.target, { goal, ocrMode });
  };

  const noteCapabilityCall = (run: NativeRunRecord): void => {
    run.capabilityCalls++;
    run.firstCapabilityCallAtMs ??= Date.now();
  };

  async function handleApps(): Promise<{ readonly output: unknown }> {
    const client = await helper();
    const [permissions, appsResponse] = await Promise.all([
      client.callWithRestart({ op: 'permissions' }),
      client.callWithRestart({ op: 'apps' }),
    ]);
    return record({
      permissions: permissions.ok
        ? {
            accessibility: permissions['accessibility'],
            screenRecording: permissions['screenRecording'],
          }
        : undefined,
      apps: appsResponse.ok ? appsResponse['apps'] : [],
    });
  }

  async function handleRun(
    input: unknown,
    context: InvocationContext,
  ): Promise<{ readonly output: unknown }> {
    const value = asRecord(input, 'computer.automation.run');
    const goal = requireString(value['goal'], 'goal');
    const appQuery = requireString(value['app'], 'app');
    const plannerModel =
      (value['plannerModel'] as string | undefined) ?? configuration.defaultPlannerModel;
    const reasoningEffort =
      (value['reasoningEffort'] as 'low' | 'medium' | 'high' | undefined) ?? 'low';
    const timeoutMs = optionalPositiveInt(value['timeoutMs'], 'timeoutMs') ?? DEFAULT_TIMEOUT_MS;
    const workspaceName = value['workspaceName'] as string | undefined;
    const repoPath = value['repoPath'] as string | undefined;
    const ocrMode = (value['ocrMode'] as OcrMode | undefined) ?? configuration.ocrMode ?? 'auto';

    const status = await jevClient.status();
    if (status.state !== 'connected') {
      return record({ status: 'blocked', reason: 'jev-not-connected', hint: 'call jev.connect' });
    }

    const client = await helper();
    const permissions = await client.callWithRestart({ op: 'permissions' });
    if (!permissions.ok || permissions['accessibility'] !== true) {
      return record({
        status: 'blocked',
        reason: 'accessibility-not-granted',
        hint: 'open x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility and grant Marshal Accessibility access',
      });
    }

    const appsResponse = await client.callWithRestart({ op: 'apps' });
    const apps =
      (appsResponse.ok ? (appsResponse['apps'] as HelperApp[] | undefined) : undefined) ?? [];
    const app = findApp(apps, appQuery);
    if (!app) {
      return record({
        status: 'failed',
        error: `AUTOMATION_APP_NOT_FOUND: no running app matches "${appQuery}"`,
      });
    }
    const focusResponse = await client.callWithRestart(
      { op: 'focus', bundleId: app.bundleId, pid: app.pid },
      8_000,
    );
    if (!focusResponse.ok) {
      return record({
        status: 'failed',
        error: `AUTOMATION_FOCUS_FAILED: ${focusResponse.error ?? 'could not focus app'}`,
      });
    }
    if (focusResponse['window'] === null || focusResponse['window'] === undefined) {
      return record({
        status: 'blocked',
        reason: 'no-window',
        hint: `open a window in ${app.name} and retry`,
      });
    }

    const runId = createRunId();
    const axAdapter = new AxAdapter(
      client,
      { bundleId: app.bundleId, pid: app.pid, appName: app.name },
      { goal },
    );
    const adapter: PerceptionAdapter = buildAdapter(axAdapter, goal, ocrMode);
    const run = runStore.create(runId, goal, adapter);

    const launchInput = {
      task: buildNativePlannerPrompt({ runId, goal, appLabel: `${app.name} (${app.bundleId})` }),
      idempotencyKey: `computer-automation-run:${runId}`,
      ...(plannerModel ? { model: plannerModel } : {}),
      ...(workspaceName ? { workspaceName } : {}),
      ...(repoPath ? { repoPath } : {}),
      reasoningEffort,
    };
    const launch = (launchArgs: Record<string, unknown>): Promise<RuntimeExecResponse> =>
      execute(
        {
          protocolVersion: RUNTIME_PROTOCOL_VERSION,
          targetType: 'operation' as const,
          target: 'marshal.agent.launch',
          input: launchArgs,
        },
        context,
      );

    const startedAt = Date.now();
    run.launchedAtMs = startedAt;
    run.allowlistApplied = true;
    const launchResponse = await launch({ ...launchInput, allowedTools: PLANNER_ALLOWED_TOOLS });
    if (launchResponse.status !== 'success' || !launchResponse.result) {
      const hostLacksAllowlist = rejectsAllowedTools(launchResponse);
      if (hostLacksAllowlist) run.allowlistApplied = false;
      runStore.finish(runId, { status: 'failed' });
      await adapter.dispose?.().catch(() => undefined);
      return record({
        runId,
        status: 'failed',
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

    const watcher = watchNativePlannerLiveness({
      run,
      agentId: agent.id,
      execute,
      context,
      finishAsFailed: (evidence) =>
        runStore.finish(runId, { status: 'failed', evidence: [evidence] }),
      ...(options.createPoller ? { createPoller: options.createPoller } : {}),
      ...(options.pollIntervalMs === undefined ? {} : { pollIntervalMs: options.pollIntervalMs }),
    });

    const timeoutPromise = new Promise<NativeRunFinishPayload>((resolve) => {
      const timer = scheduleTimeout(() => {
        resolve({ status: 'failed', evidence: [`Timed out after ${String(timeoutMs)}ms`] });
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

    await adapter.dispose?.().catch(() => undefined);

    const durationMs = Date.now() - startedAt;
    const finalStatus = timedOut ? 'timeout' : outcome.status;
    return record({
      runId,
      status: finalStatus,
      result: outcome.result,
      evidence: outcome.evidence ?? [],
      plannerSessionId: run.plannerSessionId,
      stats: runStats(run, durationMs),
    });
  }

  async function handleSubgoal(input: unknown): Promise<{ readonly output: unknown }> {
    const value = asRecord(input, 'computer.automation.subgoal');
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
    const result = await runSubgoal({
      adapter: run.adapter,
      jevClient,
      jevModel: configuration.defaultJevModel,
      goal,
      values,
      check,
      maxSteps,
      ...(configuration.minConfidence === undefined
        ? {}
        : { minConfidence: configuration.minConfidence }),
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
    const value = asRecord(input, 'computer.automation.check');
    const runId = requireString(value['runId'], 'runId');
    const check = asCheck(value['check']);
    const run = runStore.requireActive(runId);
    noteCapabilityCall(run);
    const startedAt = Date.now();
    const snapshot = await run.adapter.snapshot();
    const result = await evaluateCheck(check, snapshot, jevClient, configuration.defaultJevModel);
    run.checkMs += Date.now() - startedAt;
    return record(result);
  }

  async function handleObserve(input: unknown): Promise<{ readonly output: unknown }> {
    const value = asRecord(input, 'computer.automation.observe');
    const runId = requireString(value['runId'], 'runId');
    const find = optionalStringArray(value['find'], 'find', OBSERVE_MAX_FIND_TERMS);
    const maxChars = optionalPositiveInt(value['maxChars'], 'maxChars') ?? OBSERVE_DEFAULT_CHARS;
    if (maxChars > OBSERVE_MAX_CHARS)
      throw new Error(
        `AUTOMATION_INVALID_INPUT: "maxChars" must be at most ${String(OBSERVE_MAX_CHARS)}`,
      );
    const run = runStore.requireActive(runId);
    noteCapabilityCall(run);
    const startedAt = Date.now();
    const snapshot = await run.adapter.snapshot();
    const output: Record<string, unknown> = {
      url: snapshot.url,
      title: snapshot.title,
      textExcerpt: snapshot.text.slice(0, maxChars),
      ...(find ? { matches: findSnippets(await run.adapter.fullText(), find) } : {}),
      elements: elementTableLines(snapshot.actions),
    };
    run.observeMs += Date.now() - startedAt;
    return record(output);
  }

  function handleFinish(input: unknown): { readonly output: unknown } {
    const value = asRecord(input, 'computer.automation.finish');
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
    const value = asRecord(input, 'computer.automation.get');
    const runId = requireString(value['runId'], 'runId');
    const run = runStore.get(runId);
    if (!run) throw new Error(`AUTOMATION_UNKNOWN_RUN: no run "${runId}"`);
    return record({
      runId: run.runId,
      status: run.status,
      createdAt: run.createdAt,
      plannerSessionId: run.plannerSessionId,
      stats: runStats(run, (run.finishedAtMs ?? Date.now()) - Date.parse(run.createdAt)),
      subgoals: run.subgoals,
      ...(run.finishPayload
        ? { result: run.finishPayload.result, evidence: run.finishPayload.evidence ?? [] }
        : {}),
    });
  }

  return {
    id: NATIVE_PROVIDER_ID,
    version: '1.0.0',
    list: () => DESCRIPTORS,
    get: (name) => byName.get(name),
    async invoke(name, input, context) {
      if (!byName.has(name)) throw new Error(`AUTOMATION_UNKNOWN_CAPABILITY: ${name}`);
      if (context.signal?.aborted) throw new Error('AUTOMATION_ABORTED: invocation was aborted');
      switch (name) {
        case 'computer.automation.apps':
          return handleApps();
        case 'computer.automation.run':
          return handleRun(input, context);
        case 'computer.automation.subgoal':
          return handleSubgoal(input);
        case 'computer.automation.check':
          return handleCheck(input);
        case 'computer.automation.observe':
          return handleObserve(input);
        case 'computer.automation.finish':
          return handleFinish(input);
        case 'computer.automation.get':
          return handleGet(input);
        default:
          throw new Error(`AUTOMATION_UNKNOWN_CAPABILITY: ${name}`);
      }
    },
  };
}

export { DESCRIPTORS as NATIVE_AUTOMATION_CAPABILITY_DESCRIPTORS };
