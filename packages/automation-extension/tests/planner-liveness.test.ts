import { describe, expect, it, vi } from 'vitest';
import { createAutomationCapabilityProvider } from '../src/capabilities.js';
import type { CreatePoller, Poller } from '../src/planner-watcher.js';
import type {
  AgenticBrowserRuntimeHost,
  BrowserCommandResult,
  InvocationContext,
  JevClient,
  RuntimeExecResponse,
  RuntimeOperationExecuteRequest,
} from '../src/contracts.js';

function makeHost(): AgenticBrowserRuntimeHost {
  return {
    createId: (kind) => `${kind}-1`,
    invokeBrowserCommand: async (): Promise<BrowserCommandResult> => ({ success: true, data: {} }),
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

/** Manual poller test double: `tick()` drives the watcher's onTick synchronously, on demand. */
function makeManualPoller(): {
  createPoller: CreatePoller;
  tick: () => Promise<void>;
  stopped: () => boolean;
} {
  let onTick: (() => void | Promise<void>) | undefined;
  let stopped = false;
  const createPoller: CreatePoller = (tick) => {
    onTick = tick;
    const poller: Poller = {
      stop: () => {
        stopped = true;
      },
    };
    return poller;
  };
  return {
    createPoller,
    tick: async () => {
      if (stopped || !onTick) return;
      await onTick();
    },
    stopped: () => stopped,
  };
}

describe('planner liveness watcher (wired through browser.automation.run)', () => {
  it('nudges once after 2 consecutive idle polls, then finishing normally still resolves the run with its own result', async () => {
    let agentState: 'running' | 'idle' = 'idle';
    const sendCalls: RuntimeOperationExecuteRequest[] = [];
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
            result: { output: { agent: { ...AGENT_OUTPUT.agent, state: agentState } } },
            receipt: {},
          };
        }
        if (request.target === 'marshal.agent.send') {
          sendCalls.push(request);
          return {
            protocolVersion: '1.0.0',
            status: 'success',
            result: { output: { agent: AGENT_OUTPUT.agent, accepted: true } },
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
    const poller = makeManualPoller();
    const provider = createAutomationCapabilityProvider({
      host: makeHost(),
      jevClient,
      execute,
      configuration: {},
      createRunId: () => 'run-nudge-1',
      createPoller: poller.createPoller,
    });

    const runPromise = provider.invoke(
      'browser.automation.run',
      { goal: 'Book a flight' },
      callerContext('main'),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    // 2 consecutive idle polls -> exactly one nudge.
    await poller.tick();
    expect(sendCalls).toHaveLength(0);
    await poller.tick();
    expect(sendCalls).toHaveLength(1);
    expect(sendCalls[0]?.input).toMatchObject({ agentId: 'agent-planner-1' });
    expect((sendCalls[0]?.input as { message: string }).message).toContain('run-nudge-1');

    // A further idle poll must not send a second nudge.
    await poller.tick();
    expect(sendCalls).toHaveLength(1);

    // The planner "wakes up" and finishes properly before the fail grace elapses.
    agentState = 'running';
    await provider.invoke(
      'browser.automation.finish',
      {
        runId: 'run-nudge-1',
        status: 'succeeded',
        result: { bookingId: 'xyz' },
        evidence: ['done'],
      },
      callerContext('planner-session-1'),
    );

    const result = await runPromise;
    expect(result.output).toMatchObject({
      runId: 'run-nudge-1',
      status: 'succeeded',
      result: { bookingId: 'xyz' },
    });
    expect(poller.stopped()).toBe(true);
    expect(sendCalls).toHaveLength(1);
  });

  it('resolves the run as failed when the planner stays idle through the post-nudge grace window without finishing', async () => {
    const sendCalls: RuntimeOperationExecuteRequest[] = [];
    const cancelCalls: RuntimeOperationExecuteRequest[] = [];
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
            result: { output: { agent: { ...AGENT_OUTPUT.agent, state: 'idle' } } },
            receipt: {},
          };
        }
        if (request.target === 'marshal.agent.send') {
          sendCalls.push(request);
          return {
            protocolVersion: '1.0.0',
            status: 'success',
            result: { output: {} },
            receipt: {},
          };
        }
        if (request.target === 'marshal.agent.cancel') {
          cancelCalls.push(request);
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
    const poller = makeManualPoller();
    const provider = createAutomationCapabilityProvider({
      host: makeHost(),
      jevClient,
      execute,
      configuration: {},
      createRunId: () => 'run-nudge-2',
      createPoller: poller.createPoller,
    });

    const runPromise = provider.invoke(
      'browser.automation.run',
      { goal: 'Book a flight' },
      callerContext('main'),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    // 2 idle polls -> nudge; 6 more idle polls -> resolve failed.
    for (let i = 0; i < 8; i++) {
      await poller.tick();
    }

    const result = await runPromise;
    expect(result.output).toMatchObject({
      runId: 'run-nudge-2',
      status: 'failed',
      evidence: ['planner ended without calling finish'],
    });
    expect(sendCalls).toHaveLength(1);
    expect(poller.stopped()).toBe(true);
    // The run-level timeout path (a distinct concern) never fires here since
    // the watcher resolved the run first - no marshal.agent.cancel call.
    expect(cancelCalls).toHaveLength(0);

    // Further ticks after the run is already resolved must be no-ops.
    await poller.tick();
    expect(sendCalls).toHaveLength(1);
  });
});
