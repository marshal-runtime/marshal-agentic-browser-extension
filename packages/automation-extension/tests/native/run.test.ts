import { describe, expect, it, vi } from 'vitest';
import type { AxHelperClient } from '../../src/native/ax-helper-client.js';
import { createNativeCapabilityProvider } from '../../src/native/native-capabilities.js';
import type {
  InvocationContext,
  JevClient,
  RuntimeExecResponse,
  RuntimeOperationExecuteRequest,
} from '../../src/contracts.js';

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

/** Test seam: fakes the marshal-ax-helper subprocess client so handleRun's app-focus dance succeeds without a real Accessibility helper. */
function makeFakeHelperClient(): AxHelperClient {
  return {
    callWithRestart: vi.fn(async (request: { op: string }) => {
      if (request.op === 'permissions') {
        return { ok: true, accessibility: true, screenRecording: true };
      }
      if (request.op === 'apps') {
        return {
          ok: true,
          apps: [{ bundleId: 'com.test.App', name: 'Test App', pid: 111, frontmost: true }],
        };
      }
      if (request.op === 'focus') {
        return { ok: true, window: { id: 1 } };
      }
      return { ok: true };
    }),
  } as unknown as AxHelperClient;
}

function makeProvider(
  createRunId: () => string,
  extra: Record<string, unknown> = {},
): ReturnType<typeof createNativeCapabilityProvider> {
  const jevClient: JevClient = {
    status: async () => ({ state: 'connected', model: 'jev-latest' }),
    ask: vi.fn(),
  };
  const execute =
    (extra['execute'] as
      | ((request: RuntimeOperationExecuteRequest) => Promise<RuntimeExecResponse>)
      | undefined) ??
    vi.fn(async (request: RuntimeOperationExecuteRequest): Promise<RuntimeExecResponse> => {
      if (request.target === 'marshal.agent.launch') {
        return {
          protocolVersion: '1.0.0',
          status: 'success',
          result: { output: AGENT_OUTPUT },
          receipt: {},
        };
      }
      throw new Error(`unexpected operation ${request.target}`);
    });
  return createNativeCapabilityProvider({
    jevClient,
    execute,
    configuration: {},
    packageRoot: '/tmp/automation-extension-test-root',
    createHelperClient: () => makeFakeHelperClient(),
    createRunId,
    ...extra,
  });
}

describe('computer.automation.run with wait:false, and .get/.list', () => {
  it('returns the runId immediately with wait:false, and get later reports the final result', async () => {
    const provider = makeProvider(() => 'run-native-detached');

    const result = await provider.invoke(
      'computer.automation.run',
      { goal: 'g', app: 'Test App', wait: false },
      callerContext('main'),
    );
    expect(result.output).toEqual({
      runId: 'run-native-detached',
      status: 'running',
      plannerSessionId: 'planner-session-1',
    });

    const midGet = await provider.invoke(
      'computer.automation.get',
      { runId: 'run-native-detached' },
      callerContext('main'),
    );
    expect((midGet.output as { status: string }).status).toBe('running');

    await provider.invoke(
      'computer.automation.finish',
      {
        runId: 'run-native-detached',
        status: 'succeeded',
        result: { ok: true },
        evidence: ['done'],
      },
      callerContext('planner-session-1'),
    );
    // Let the background settlement (unawaited by run's wait:false response) finish.
    await new Promise((resolve) => setTimeout(resolve, 0));

    const got = await provider.invoke(
      'computer.automation.get',
      { runId: 'run-native-detached' },
      callerContext('main'),
    );
    expect(got.output).toMatchObject({
      status: 'succeeded',
      result: { ok: true },
      evidence: ['done'],
    });
  });

  it('lists recent runs newest first, for recovering a runId that was lost', async () => {
    let n = 0;
    const provider = makeProvider(() => `run-native-list-${++n}`);

    await provider.invoke(
      'computer.automation.run',
      { goal: 'first', app: 'Test App', wait: false },
      callerContext('main'),
    );
    await provider.invoke(
      'computer.automation.run',
      { goal: 'second', app: 'Test App', wait: false },
      callerContext('main'),
    );

    const listed = await provider.invoke('computer.automation.list', {}, callerContext('main'));
    const runs = (listed.output as { runs: Array<{ runId: string; goal: string }> }).runs;
    expect(runs.map((r) => r.runId)).toEqual(['run-native-list-2', 'run-native-list-1']);
    expect(runs[0]).toMatchObject({ goal: 'second', status: 'running' });
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
    const provider = makeProvider(() => 'run-native-timeout', {
      execute,
      scheduleTimeout: (callback: () => void) => {
        queueMicrotask(callback);
        return { cancel: () => undefined };
      },
    });

    const result = await provider.invoke(
      'computer.automation.run',
      { goal: 'g', app: 'Test App', timeoutMs: 1 },
      callerContext('main'),
    );
    expect(result.output).toMatchObject({ status: 'timeout' });

    const got = await provider.invoke(
      'computer.automation.get',
      { runId: 'run-native-timeout' },
      callerContext('main'),
    );
    expect(got.output).toMatchObject({
      status: 'timeout',
      evidence: ['Timed out after 1ms'],
    });
  });

  it('rejects a non-boolean wait', async () => {
    const provider = makeProvider(() => 'run-native-bad-wait');
    await expect(
      provider.invoke(
        'computer.automation.run',
        { goal: 'g', app: 'Test App', wait: 'nope' },
        callerContext('main'),
      ),
    ).rejects.toThrow(/"wait"/);
  });
});
