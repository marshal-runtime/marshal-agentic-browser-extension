import { describe, expect, it, vi } from 'vitest';
import { createAutomationCapabilityProvider } from '../src/capabilities.js';
import type {
  AgenticBrowserRuntimeHost,
  BrowserCommandResult,
  BrowserRequestContext,
  InvocationContext,
  JevClient,
  RuntimeExecResponse,
  RuntimeOperationExecuteRequest,
} from '../src/contracts.js';
import type { PageSnapshot } from '../src/types.js';

function context(sessionId: string): InvocationContext {
  return {
    principal: { id: 'agent-1', kind: 'agent' },
    scope: { sessionId },
    executionId: `exec-${sessionId}`,
  };
}

function snapshot(): PageSnapshot {
  return {
    url: 'https://example.com',
    title: 'Example',
    w: 1024,
    h: 768,
    text: '',
    scroll: { y: 0, height: 100 },
    actions: [],
    marker: ['m'],
    omittedActions: 0,
  };
}

describe('run binding', () => {
  it('subgoal acts in the browser session bound at run time, not the session of whoever calls subgoal', async () => {
    const recordedContexts: BrowserRequestContext[] = [];
    let idCounter = 0;
    const host: AgenticBrowserRuntimeHost = {
      createId: (kind) => `${kind}-${++idCounter}`,
      invokeBrowserCommand: async (name, input, requestContext): Promise<BrowserCommandResult> => {
        recordedContexts.push(requestContext);
        if (name === 'browser_execute_script') {
          const script = String((input as { script?: unknown }).script ?? '');
          // The fast marker() path (dom-adapter.ts) runs a script that returns a bare array,
          // never a full PageSnapshot object; distinguish it from the full snapshot script.
          if (script.includes('data-mjev-id')) return { success: true, data: snapshot() };
          return { success: true, data: snapshot().marker };
        }
        return { success: true, data: {} };
      },
    };
    const execute = vi.fn(
      async (request: RuntimeOperationExecuteRequest): Promise<RuntimeExecResponse> => {
        if (request.target === 'marshal.agent.launch') {
          return {
            protocolVersion: '1.0.0',
            status: 'success',
            result: {
              output: {
                agent: {
                  id: 'agent-1',
                  name: 'planner',
                  state: 'running',
                  createdAt: 'now',
                  updatedAt: 'now',
                  sessionId: 'planner-session',
                },
              },
            },
            receipt: {},
          };
        }
        return { protocolVersion: '1.0.0', status: 'success', result: { output: {} }, receipt: {} };
      },
    );
    const jevClient: JevClient = {
      status: async () => ({ state: 'connected', model: 'jev-latest' }),
      ask: vi.fn(async () => ({
        answers: {
          operation: { choice: 'BLOCKED', probabilities: { DONE: 0, BLOCKED: 1 }, confidence: 1 },
        },
        model: 'jev-latest',
        usage: { input_tokens: 1, output_tokens: 1 },
        latencyMs: 1,
      })),
    };

    const provider = createAutomationCapabilityProvider({
      host,
      jevClient,
      execute,
      configuration: {},
      createRunId: () => 'run-bind-1',
    });

    // The caller of `run` is "main-session" - this fixes the bound browser context.
    const runPromise = provider.invoke(
      'browser.automation.run',
      { goal: 'do the thing' },
      context('main-session'),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    // The planner calls `subgoal` from an entirely different session/executionId.
    await provider.invoke(
      'browser.automation.subgoal',
      { runId: 'run-bind-1', goal: 'click something', maxSteps: 1 },
      context('planner-session-different'),
    );

    await provider.invoke(
      'browser.automation.finish',
      { runId: 'run-bind-1', status: 'succeeded' },
      context('planner-session-different'),
    );
    await runPromise;

    expect(recordedContexts.length).toBeGreaterThan(0);
    for (const recorded of recordedContexts) {
      expect(recorded.chatId).toBe('main-session');
      expect(recorded.executionId).toBe('exec-main-session');
      expect(recorded.chatId).not.toBe('planner-session-different');
    }
  });
});
