import { describe, expect, it, vi } from 'vitest';
import { createAutomationCapabilityProvider } from '../src/capabilities.js';
import type {
  AgenticBrowserRuntimeHost,
  BrowserCommandResult,
  InvocationContext,
  JevClient,
  RuntimeExecResponse,
  RuntimeOperationExecuteRequest,
} from '../src/contracts.js';

function makeHost(pageText = '', fullPageText = pageText): AgenticBrowserRuntimeHost {
  let counter = 0;
  const snapshot = {
    url: 'https://example.test/',
    title: 'Example',
    w: 1,
    h: 1,
    text: pageText,
    scroll: { y: 0, height: 1 },
    actions: [],
    marker: [],
    omittedActions: 0,
  };
  return {
    createId: (kind) => `${kind}-${++counter}`,
    invokeBrowserCommand: async (_command, params): Promise<BrowserCommandResult> => {
      const script = String((params as { script?: unknown }).script ?? '');
      const result = script.includes('body.innerText') ? `${fullPageText}` : snapshot;
      return { success: true, data: { success: true, result } };
    },
  };
}

function callerContext(sessionId: string): InvocationContext {
  return {
    principal: { id: 'agent-1', kind: 'agent' },
    scope: { sessionId },
    executionId: `exec-${sessionId}`,
  };
}

const AGENT_OUTPUT = {
  agent: {
    id: 'agent-planner-1',
    name: 'planner',
    state: 'running' as const,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    sessionId: 'planner-session-1',
  },
};

describe('browser.automation.run', () => {
  it('returns blocked without launching an agent when Jev is not connected', async () => {
    const execute =
      vi.fn<(request: RuntimeOperationExecuteRequest) => Promise<RuntimeExecResponse>>();
    const jevClient: JevClient = {
      status: async () => ({ state: 'not-connected', model: 'jev-latest' }),
      ask: vi.fn(),
    };
    const provider = createAutomationCapabilityProvider({
      host: makeHost(),
      jevClient,
      execute,
      configuration: {},
      createRunId: () => 'run-1',
    });

    const result = await provider.invoke(
      'browser.automation.run',
      { goal: 'Book a flight' },
      callerContext('main'),
    );

    expect(result.output).toMatchObject({
      status: 'blocked',
      reason: 'jev-not-connected',
      hint: 'call jev.connect',
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it('launches the planner, waits for finish, and returns its result', async () => {
    const execute = vi.fn(
      async (request: RuntimeOperationExecuteRequest): Promise<RuntimeExecResponse> => {
        if (request.target === 'marshal.agent.launch') {
          return {
            protocolVersion: '1.0.0',
            status: 'success',
            result: { output: AGENT_OUTPUT },
            receipt: {},
          };
        }
        throw new Error(`unexpected operation ${request.target}`);
      },
    );
    const jevClient: JevClient = {
      status: async () => ({ state: 'connected', model: 'jev-latest' }),
      ask: vi.fn(),
    };
    const provider = createAutomationCapabilityProvider({
      host: makeHost(),
      jevClient,
      execute,
      configuration: {},
      createRunId: () => 'run-2',
    });

    const runPromise = provider.invoke(
      'browser.automation.run',
      { goal: 'Book a flight' },
      callerContext('main'),
    );

    // Give the run's internal awaits (jev status, agent launch) a tick to settle before finishing.
    await new Promise((resolve) => setTimeout(resolve, 0));
    await provider.invoke(
      'browser.automation.finish',
      {
        runId: 'run-2',
        status: 'succeeded',
        result: { bookingId: 'abc' },
        evidence: ['confirmation page shown'],
      },
      callerContext('planner-session-1'),
    );

    const result = await runPromise;
    expect(result.output).toMatchObject({
      runId: 'run-2',
      status: 'succeeded',
      result: { bookingId: 'abc' },
      evidence: ['confirmation page shown'],
      plannerSessionId: 'planner-session-1',
    });
  });

  it('cancels the planner and returns status timeout when the run does not finish in time', async () => {
    let cancelCalled: RuntimeOperationExecuteRequest | undefined;
    const execute = vi.fn(
      async (request: RuntimeOperationExecuteRequest): Promise<RuntimeExecResponse> => {
        if (request.target === 'marshal.agent.launch') {
          return {
            protocolVersion: '1.0.0',
            status: 'success',
            result: { output: AGENT_OUTPUT },
            receipt: {},
          };
        }
        if (request.target === 'marshal.agent.cancel') {
          cancelCalled = request;
          return {
            protocolVersion: '1.0.0',
            status: 'success',
            result: { output: {} },
            receipt: {},
          };
        }
        throw new Error(`unexpected operation ${request.target}`);
      },
    );
    const jevClient: JevClient = {
      status: async () => ({ state: 'connected', model: 'jev-latest' }),
      ask: vi.fn(),
    };
    const provider = createAutomationCapabilityProvider({
      host: makeHost(),
      jevClient,
      execute,
      configuration: {},
      createRunId: () => 'run-3',
      // Fire the timeout immediately instead of waiting real minutes.
      scheduleTimeout: (callback) => {
        queueMicrotask(callback);
        return { cancel: () => undefined };
      },
    });

    const result = await provider.invoke(
      'browser.automation.run',
      { goal: 'Book a flight', timeoutMs: 1 },
      callerContext('main'),
    );

    expect(result.output).toMatchObject({ runId: 'run-3', status: 'timeout' });
    expect(cancelCalled).toMatchObject({
      target: 'marshal.agent.cancel',
      input: { agentId: 'agent-planner-1' },
    });
  });

  it('launches the planner without a role and restricted to the three runtime tools', async () => {
    const requests: RuntimeOperationExecuteRequest[] = [];
    const execute = vi.fn(
      async (request: RuntimeOperationExecuteRequest): Promise<RuntimeExecResponse> => {
        requests.push(request);
        return {
          protocolVersion: '1.0.0',
          status: 'failure',
          error: { code: 'operation_failed', message: 'stop' },
          receipt: {},
        } as unknown as RuntimeExecResponse;
      },
    );
    const provider = createAutomationCapabilityProvider({
      host: makeHost(),
      jevClient: {
        status: async () => ({ state: 'connected', model: 'jev-latest' }),
        ask: vi.fn(),
      },
      execute,
      configuration: {},
    });
    await provider.invoke('browser.automation.run', { goal: 'g' }, callerContext('main'));
    const input = requests[0]?.input as Record<string, unknown>;
    expect(input).not.toHaveProperty('runtimeAgentRole');
    expect(input['allowedTools']).toEqual([
      'runtimeInvoke',
      'runtimeSearch',
      'runtimeExecuteTypeScript',
    ]);
    expect(requests).toHaveLength(1);
  });

  it('fails closed instead of launching an unrestricted planner when the host rejects allowedTools', async () => {
    const launches: Record<string, unknown>[] = [];
    const execute = vi.fn(
      async (request: RuntimeOperationExecuteRequest): Promise<RuntimeExecResponse> => {
        if (request.target === 'marshal.agent.launch') {
          launches.push(request.input as Record<string, unknown>);
          if ('allowedTools' in (request.input as Record<string, unknown>)) {
            return {
              protocolVersion: '1.0.0',
              status: 'failed',
              error: {
                code: 'invalid-request',
                message: 'Unexpected Marshal agent input property: allowedTools.',
              },
            } as RuntimeExecResponse;
          }
          return {
            protocolVersion: '1.0.0',
            status: 'success',
            result: { output: AGENT_OUTPUT },
            receipt: {},
          };
        }
        throw new Error(`unexpected operation ${request.target}`);
      },
    );
    const provider = createAutomationCapabilityProvider({
      host: makeHost(),
      jevClient: {
        status: async () => ({ state: 'connected', model: 'jev-latest' }),
        ask: vi.fn(),
      },
      execute,
      configuration: {},
      createRunId: () => 'run-fallback',
    });
    const result = await provider.invoke(
      'browser.automation.run',
      { goal: 'g' },
      callerContext('main'),
    );
    const output = result.output as {
      status: string;
      error: string;
      stats: Record<string, unknown>;
    };
    expect(launches).toHaveLength(1);
    expect(output.status).toBe('failed');
    expect(output.error).toMatch(/does not support allowedTools/);
    expect(output.stats).toMatchObject({ allowlistApplied: false });
  });

  it('does not retry the launch for unrelated failures', async () => {
    const execute = vi.fn(
      async (): Promise<RuntimeExecResponse> => ({
        protocolVersion: '1.0.0',
        status: 'failed',
        error: {
          code: 'operation_failed',
          message: 'workspaceName and repoPath must identify the same workspace root',
        },
      }),
    );
    const provider = createAutomationCapabilityProvider({
      host: makeHost(),
      jevClient: {
        status: async () => ({ state: 'connected', model: 'jev-latest' }),
        ask: vi.fn(),
      },
      execute,
      configuration: {},
    });
    const result = await provider.invoke(
      'browser.automation.run',
      { goal: 'g' },
      callerContext('main'),
    );
    expect(execute).toHaveBeenCalledTimes(1);
    expect(result.output).toMatchObject({ status: 'failed' });
  });

  it('reports timing, capability-call and planner usage stats', async () => {
    const execute = vi.fn(
      async (request: RuntimeOperationExecuteRequest): Promise<RuntimeExecResponse> => {
        if (request.target === 'marshal.agent.launch') {
          return {
            protocolVersion: '1.0.0',
            status: 'success',
            result: { output: AGENT_OUTPUT },
            receipt: {},
          };
        }
        if (request.target === 'marshal.agent.get') {
          return {
            protocolVersion: '1.0.0',
            status: 'success',
            result: {
              output: {
                agent: {
                  ...AGENT_OUTPUT.agent,
                  usage: { inputTokens: 1200, outputTokens: 80, cachedInputTokens: 900 },
                },
              },
            },
          } as RuntimeExecResponse;
        }
        if (request.target === 'marshal.agent.transcript') {
          return {
            protocolVersion: '1.0.0',
            status: 'success',
            result: { output: { messageCount: 3 } },
          } as RuntimeExecResponse;
        }
        throw new Error(`unexpected operation ${request.target}`);
      },
    );
    const provider = createAutomationCapabilityProvider({
      host: makeHost(),
      jevClient: {
        status: async () => ({ state: 'connected', model: 'jev-latest' }),
        ask: vi.fn(),
      },
      execute,
      configuration: {},
      createRunId: () => 'run-stats',
    });
    const runPromise = provider.invoke(
      'browser.automation.run',
      { goal: 'g' },
      callerContext('main'),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    await provider.invoke('browser.automation.observe', { runId: 'run-stats' }, callerContext('p'));
    await provider.invoke(
      'browser.automation.finish',
      { runId: 'run-stats', status: 'succeeded' },
      callerContext('p'),
    );

    const stats = ((await runPromise).output as { stats: Record<string, unknown> }).stats;
    expect(stats).toMatchObject({
      capabilityCalls: 1,
      allowlistApplied: true,
      plannerMessages: 3,
      plannerInputTokens: 1200,
      plannerOutputTokens: 80,
      plannerCachedInputTokens: 900,
    });
    for (const key of [
      'durationMs',
      'subgoalMs',
      'checkMs',
      'observeMs',
      'jevLatencyMs',
      'startupMs',
      'plannerThinkMs',
    ]) {
      expect(typeof stats[key]).toBe('number');
    }
  });

  it('finish accepts a bare string evidence value as a single-item list', async () => {
    const provider = createAutomationCapabilityProvider({
      host: makeHost(),
      jevClient: {
        status: async () => ({ state: 'connected', model: 'jev-latest' }),
        ask: vi.fn(),
      },
      execute: vi.fn(
        async (request: RuntimeOperationExecuteRequest): Promise<RuntimeExecResponse> => {
          if (request.target === 'marshal.agent.launch') {
            return {
              protocolVersion: '1.0.0',
              status: 'success',
              result: { output: AGENT_OUTPUT },
              receipt: {},
            };
          }
          throw new Error('unexpected');
        },
      ),
      configuration: {},
      createRunId: () => 'run-ev',
    });
    const runPromise = provider.invoke(
      'browser.automation.run',
      { goal: 'g' },
      callerContext('main'),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    await provider.invoke(
      'browser.automation.finish',
      { runId: 'run-ev', status: 'succeeded', evidence: 'single string' },
      callerContext('p'),
    );
    expect((await runPromise).output).toMatchObject({ evidence: ['single string'] });
  });

  it('get returns the final result and evidence once the run has finished', async () => {
    const provider = createAutomationCapabilityProvider({
      host: makeHost(),
      jevClient: {
        status: async () => ({ state: 'connected', model: 'jev-latest' }),
        ask: vi.fn(),
      },
      execute: vi.fn(
        async (request: RuntimeOperationExecuteRequest): Promise<RuntimeExecResponse> => {
          if (request.target === 'marshal.agent.launch') {
            return {
              protocolVersion: '1.0.0',
              status: 'success',
              result: { output: AGENT_OUTPUT },
              receipt: {},
            };
          }
          throw new Error('unexpected');
        },
      ),
      configuration: {},
      createRunId: () => 'run-get',
    });
    const runPromise = provider.invoke(
      'browser.automation.run',
      { goal: 'g' },
      callerContext('main'),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    await provider.invoke(
      'browser.automation.finish',
      { runId: 'run-get', status: 'succeeded', result: { n: 1 }, evidence: ['e1'] },
      callerContext('p'),
    );
    await runPromise;
    const got = await provider.invoke(
      'browser.automation.get',
      { runId: 'run-get' },
      callerContext('main'),
    );
    expect(got.output).toMatchObject({
      runId: 'run-get',
      status: 'succeeded',
      result: { n: 1 },
      evidence: ['e1'],
    });
  });

  it('run with wait:false returns the runId immediately, and get later reports the final result', async () => {
    const provider = createAutomationCapabilityProvider({
      host: makeHost(),
      jevClient: {
        status: async () => ({ state: 'connected', model: 'jev-latest' }),
        ask: vi.fn(),
      },
      execute: vi.fn(
        async (request: RuntimeOperationExecuteRequest): Promise<RuntimeExecResponse> => {
          if (request.target === 'marshal.agent.launch') {
            return {
              protocolVersion: '1.0.0',
              status: 'success',
              result: { output: AGENT_OUTPUT },
              receipt: {},
            };
          }
          throw new Error('unexpected');
        },
      ),
      configuration: {},
      createRunId: () => 'run-detached',
    });

    const result = await provider.invoke(
      'browser.automation.run',
      { goal: 'g', wait: false },
      callerContext('main'),
    );
    expect(result.output).toEqual({
      runId: 'run-detached',
      status: 'running',
      plannerSessionId: 'planner-session-1',
    });

    const midGet = await provider.invoke(
      'browser.automation.get',
      { runId: 'run-detached' },
      callerContext('main'),
    );
    expect((midGet.output as { status: string }).status).toBe('running');

    await provider.invoke(
      'browser.automation.finish',
      { runId: 'run-detached', status: 'succeeded', result: { ok: true }, evidence: ['done'] },
      callerContext('planner-session-1'),
    );
    // Let the background settlement (unawaited by run's wait:false response) finish.
    await new Promise((resolve) => setTimeout(resolve, 0));

    const finalGet = await provider.invoke(
      'browser.automation.get',
      { runId: 'run-detached' },
      callerContext('main'),
    );
    expect(finalGet.output).toMatchObject({
      runId: 'run-detached',
      status: 'succeeded',
      result: { ok: true },
      evidence: ['done'],
    });
  });

  it('rejects a non-boolean wait', async () => {
    const provider = createAutomationCapabilityProvider({
      host: makeHost(),
      jevClient: {
        status: async () => ({ state: 'connected', model: 'jev-latest' }),
        ask: vi.fn(),
      },
      execute: vi.fn(),
      configuration: {},
    });
    await expect(
      provider.invoke('browser.automation.run', { goal: 'g', wait: 'nope' }, callerContext('main')),
    ).rejects.toThrow(/"wait"/);
  });

  it('get reports evidence for a run that timed out (not just an empty result)', async () => {
    const execute = vi.fn(
      async (request: RuntimeOperationExecuteRequest): Promise<RuntimeExecResponse> => {
        if (request.target === 'marshal.agent.launch') {
          return {
            protocolVersion: '1.0.0',
            status: 'success',
            result: { output: AGENT_OUTPUT },
            receipt: {},
          };
        }
        if (request.target === 'marshal.agent.cancel') {
          return {
            protocolVersion: '1.0.0',
            status: 'success',
            result: { output: {} },
            receipt: {},
          };
        }
        throw new Error(`unexpected operation ${request.target}`);
      },
    );
    const provider = createAutomationCapabilityProvider({
      host: makeHost(),
      jevClient: {
        status: async () => ({ state: 'connected', model: 'jev-latest' }),
        ask: vi.fn(),
      },
      execute,
      configuration: {},
      createRunId: () => 'run-timeout-get',
      scheduleTimeout: (callback) => {
        queueMicrotask(callback);
        return { cancel: () => undefined };
      },
    });

    const result = await provider.invoke(
      'browser.automation.run',
      { goal: 'g', timeoutMs: 1 },
      callerContext('main'),
    );
    expect(result.output).toMatchObject({ status: 'timeout' });

    const got = await provider.invoke(
      'browser.automation.get',
      { runId: 'run-timeout-get' },
      callerContext('main'),
    );
    expect(got.output).toMatchObject({
      status: 'timeout',
      evidence: ['Timed out after 1ms'],
    });
  });

  it('get reports the error for a run whose planner failed to launch', async () => {
    const execute = vi.fn(
      async (): Promise<RuntimeExecResponse> =>
        ({
          protocolVersion: '1.0.0',
          status: 'failed',
          error: { code: 'operation_failed', message: 'boom' },
        }) as RuntimeExecResponse,
    );
    const provider = createAutomationCapabilityProvider({
      host: makeHost(),
      jevClient: {
        status: async () => ({ state: 'connected', model: 'jev-latest' }),
        ask: vi.fn(),
      },
      execute,
      configuration: {},
      createRunId: () => 'run-launch-fail',
    });

    await provider.invoke('browser.automation.run', { goal: 'g' }, callerContext('main'));
    const got = await provider.invoke(
      'browser.automation.get',
      { runId: 'run-launch-fail' },
      callerContext('main'),
    );
    expect(got.output).toMatchObject({ status: 'failed', error: 'boom' });
  });

  it('forwards optional workspaceName/repoPath to marshal.agent.launch and omits them by default', async () => {
    const launches: RuntimeOperationExecuteRequest[] = [];
    const execute = vi.fn(
      async (request: RuntimeOperationExecuteRequest): Promise<RuntimeExecResponse> => {
        launches.push(request);
        return {
          protocolVersion: '1.0.0',
          status: 'failure',
          error: { code: 'operation_failed', message: 'stop' },
          receipt: {},
        } as unknown as RuntimeExecResponse;
      },
    );
    const provider = createAutomationCapabilityProvider({
      host: makeHost(),
      jevClient: {
        status: async () => ({ state: 'connected', model: 'jev-latest' }),
        ask: vi.fn(),
      },
      execute,
      configuration: {},
    });

    await provider.invoke('browser.automation.run', { goal: 'g' }, callerContext('main'));
    await provider.invoke(
      'browser.automation.run',
      { goal: 'g', workspaceName: 'Marshal', repoPath: '/tmp/ws' },
      callerContext('main'),
    );

    const [defaultInput, explicitInput] = launches.map((l) => l.input as Record<string, unknown>);
    expect(defaultInput).not.toHaveProperty('workspaceName');
    expect(defaultInput).not.toHaveProperty('repoPath');
    expect(explicitInput).toMatchObject({ workspaceName: 'Marshal', repoPath: '/tmp/ws' });
  });

  it('finish is only valid for an active runId', async () => {
    const provider = createAutomationCapabilityProvider({
      host: makeHost(),
      jevClient: {
        status: async () => ({ state: 'connected', model: 'jev-latest' }),
        ask: vi.fn(),
      },
      execute: vi.fn(),
      configuration: {},
    });

    await expect(
      provider.invoke(
        'browser.automation.finish',
        { runId: 'no-such-run', status: 'succeeded' },
        callerContext('x'),
      ),
    ).rejects.toThrow('AUTOMATION_UNKNOWN_RUN');
  });
});

describe('browser.automation.list', () => {
  function makeListProvider(
    createRunId: () => string,
  ): ReturnType<typeof createAutomationCapabilityProvider> {
    return createAutomationCapabilityProvider({
      host: makeHost(),
      jevClient: {
        status: async () => ({ state: 'connected', model: 'jev-latest' }),
        ask: vi.fn(),
      },
      execute: vi.fn(
        async (request: RuntimeOperationExecuteRequest): Promise<RuntimeExecResponse> => {
          if (request.target === 'marshal.agent.launch') {
            return {
              protocolVersion: '1.0.0',
              status: 'success',
              result: { output: AGENT_OUTPUT },
              receipt: {},
            };
          }
          throw new Error('unexpected');
        },
      ),
      configuration: {},
      createRunId,
    });
  }

  it('lists runs newest first, for recovering a runId that was lost', async () => {
    let n = 0;
    const provider = makeListProvider(() => `run-list-${++n}`);

    await provider.invoke(
      'browser.automation.run',
      { goal: 'first goal', wait: false },
      callerContext('main'),
    );
    await provider.invoke(
      'browser.automation.run',
      { goal: 'second goal', wait: false },
      callerContext('main'),
    );

    const listed = await provider.invoke('browser.automation.list', {}, callerContext('main'));
    const runs = (listed.output as { runs: Array<{ runId: string; goal: string }> }).runs;
    expect(runs.map((r) => r.runId)).toEqual(['run-list-2', 'run-list-1']);
    expect(runs[0]).toMatchObject({ goal: 'second goal', status: 'running' });
  });

  it('truncates a long goal to an excerpt', async () => {
    const provider = makeListProvider(() => 'run-long-goal');
    await provider.invoke(
      'browser.automation.run',
      { goal: 'g'.repeat(500), wait: false },
      callerContext('main'),
    );

    const listed = await provider.invoke('browser.automation.list', {}, callerContext('main'));
    const [run] = (listed.output as { runs: Array<{ goal: string }> }).runs;
    expect(run?.goal.length).toBe(201);
    expect(run?.goal.endsWith('…')).toBe(true);
  });

  it('respects limit and rejects a limit above the max', async () => {
    const provider = makeListProvider(() => 'run-limit');
    await expect(
      provider.invoke('browser.automation.list', { limit: 1000 }, callerContext('main')),
    ).rejects.toThrow(/"limit"/);
  });
});

describe('browser.automation.observe extraction', () => {
  async function observe(
    pageText: string,
    input: Record<string, unknown>,
  ): Promise<{ textExcerpt: string; matches?: Record<string, string[]> }> {
    const provider = createAutomationCapabilityProvider({
      host: makeHost(pageText.slice(0, 1200), pageText),
      jevClient: {
        status: async () => ({ state: 'connected', model: 'jev-latest' }),
        ask: vi.fn(),
      },
      execute: vi.fn(
        async (): Promise<RuntimeExecResponse> => ({
          protocolVersion: '1.0.0',
          status: 'success',
          result: { output: AGENT_OUTPUT },
          receipt: {},
        }),
      ),
      configuration: {},
      createRunId: () => 'run-observe',
    });
    const runPromise = provider.invoke(
      'browser.automation.run',
      { goal: 'g' },
      callerContext('main'),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    const result = await provider.invoke(
      'browser.automation.observe',
      { runId: 'run-observe', ...input },
      callerContext('p'),
    );
    await provider.invoke(
      'browser.automation.finish',
      { runId: 'run-observe', status: 'succeeded' },
      callerContext('p'),
    );
    await runPromise;
    return result.output as { textExcerpt: string; matches?: Record<string, string[]> };
  }

  const longPage = `${'intro '.repeat(400)}Population (2024) 1,050,153 people ${'tail '.repeat(50)}`;

  it('returns snippets from the full page text even when it is outside the viewport excerpt', async () => {
    const output = await observe(longPage, { find: ['population'] });
    expect(output.textExcerpt.length).toBe(1000);
    expect(output.matches?.['population']?.[0]).toContain('1,050,153');
  });

  it('widens the excerpt with maxChars and reports terms that are absent as empty', async () => {
    const output = await observe(longPage, { maxChars: 2000, find: ['nowhere'] });
    expect(output.textExcerpt.length).toBe(1200);
    expect(output.matches).toEqual({ nowhere: [] });
  });

  it('rejects an oversized maxChars', async () => {
    await expect(observe(longPage, { maxChars: 9000 })).rejects.toThrow(/maxChars/);
  });
});
