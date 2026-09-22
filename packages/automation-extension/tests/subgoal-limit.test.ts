import { describe, expect, it, vi } from 'vitest';
import { createAutomationCapabilityProvider } from '../src/capabilities.js';
import type {
  AgenticBrowserRuntimeHost,
  BrowserCommandResult,
  InvocationContext,
  JevAskResult,
  JevClient,
  RuntimeExecResponse,
  RuntimeOperationExecuteRequest,
} from '../src/contracts.js';
import { MARKER_SCRIPT } from '../src/snapshot-script.js';

const SNAPSHOT = {
  url: 'https://example.test/',
  title: 'Example',
  w: 1,
  h: 1,
  text: 'page',
  scroll: { y: 0, height: 1 },
  actions: [],
  marker: [],
  omittedActions: 0,
};

const host: AgenticBrowserRuntimeHost = {
  createId: (kind) => `${kind}-1`,
  invokeBrowserCommand: async (_command, params): Promise<BrowserCommandResult> => {
    const script = String((params as { script?: unknown }).script ?? '');
    const result = script.includes(MARKER_SCRIPT) ? [] : SNAPSHOT;
    return { success: true, data: { success: true, result } };
  },
};

const jevClient: JevClient = {
  status: async () => ({ state: 'connected', model: 'jev-latest' }),
  ask: async (): Promise<JevAskResult> => ({
    answers: { operation: { choice: 'DONE', probabilities: { DONE: 1 }, confidence: 0.9 } },
    model: 'jev-latest',
    usage: { input_tokens: 1, output_tokens: 1 },
    latencyMs: 1,
  }),
};

const context: InvocationContext = {
  principal: { id: 'agent-1', kind: 'agent' },
  scope: { sessionId: 'main' },
  executionId: 'exec-main',
};

describe('browser.automation.run maxSubgoals', () => {
  it('tells the planner its budget and rejects subgoal calls beyond it', async () => {
    let plannerTask = '';
    const execute = vi.fn(
      async (request: RuntimeOperationExecuteRequest): Promise<RuntimeExecResponse> => {
        if (request.target === 'marshal.agent.launch') {
          plannerTask = String((request.input as { task?: unknown }).task);
        }
        return {
          protocolVersion: '1.0.0',
          status: 'success',
          result: {
            output: {
              agent: {
                id: 'planner-1',
                name: 'planner',
                state: 'running',
                createdAt: '2026-01-01T00:00:00.000Z',
                updatedAt: '2026-01-01T00:00:00.000Z',
              },
            },
          },
          receipt: {},
        };
      },
    );
    const provider = createAutomationCapabilityProvider({
      host,
      jevClient,
      execute,
      configuration: {},
      createRunId: () => 'run-limit',
    });

    const runPromise = provider.invoke(
      'browser.automation.run',
      { goal: 'g', maxSubgoals: 1 },
      context,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(plannerTask).toContain('at most 1 subgoal calls');

    await provider.invoke('browser.automation.subgoal', { runId: 'run-limit', goal: 'a' }, context);
    await expect(
      provider.invoke('browser.automation.subgoal', { runId: 'run-limit', goal: 'b' }, context),
    ).rejects.toThrow('AUTOMATION_SUBGOAL_LIMIT');

    await provider.invoke(
      'browser.automation.finish',
      { runId: 'run-limit', status: 'succeeded' },
      context,
    );
    const result = await runPromise;
    expect(result.output).toMatchObject({ status: 'succeeded', stats: { subgoals: 1 } });
  });
});
