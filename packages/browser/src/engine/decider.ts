/**
 * The extension's only way to a model: the host's `marshal.models.decide` capability (marshal-sdk model services).
 * Which provider and model answer is the host's configuration, never this code (Omer's rule of 2026-11-22: every model
 * through marshal-sdk, no provider code inside an extension).
 */
import {
  DECIDE_CAPABILITY,
  RUNTIME_PROTOCOL_VERSION,
  type DecideFailure,
  type DecideMultiInput,
  type DecideMultiOutput,
  type DecideSchemaInput,
  type DecideSchemaOutput,
  type InvocationContext,
  type RuntimeExecuteFn,
} from '../contracts.js';

/** A failed decide call. `unavailable` codes stop a task with `decisions_unavailable`. */
export class DecideError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = 'DecideError';
  }

  get unavailable(): boolean {
    return UNAVAILABLE.has(this.code);
  }
}

const UNAVAILABLE = new Set([
  'NOT_FOUND',
  'DENIED',
  'JEV_NOT_CONNECTED',
  'JEV_INVALID_KEY',
  'JEV_RATE_LIMITED',
  'JEV_UNAVAILABLE',
  'JEV_ABORTED',
]);

export interface Decider {
  judge(input: DecideMultiInput): Promise<DecideMultiOutput>;
  extract(input: DecideSchemaInput): Promise<DecideSchemaOutput>;
  /** Whether the host offers the capability at all (it makes no model call). */
  probe(): Promise<{ readonly available: boolean; readonly detail: string }>;
}

/** A decider bound to the invocation that asks, so the host applies that caller's policy to the model call. */
export function createHostDecider(execute: RuntimeExecuteFn, context?: InvocationContext): Decider {
  const call = async (input: unknown): Promise<Record<string, unknown>> => {
    const response = await execute(
      {
        protocolVersion: RUNTIME_PROTOCOL_VERSION,
        targetType: 'operation',
        target: DECIDE_CAPABILITY,
        input,
      },
      context,
    );
    if (response.status === 'not_found') {
      throw new DecideError('NOT_FOUND', `${DECIDE_CAPABILITY} is not offered by this host`);
    }
    if (response.status === 'denied' || response.status === 'approval_required') {
      throw new DecideError(
        'DENIED',
        response.error?.message ?? `${DECIDE_CAPABILITY} was not allowed`,
      );
    }
    if (response.status !== 'success') {
      throw new DecideError(
        response.error?.code ?? 'JEV_UNAVAILABLE',
        response.error?.message ?? 'decide failed',
      );
    }
    const output = response.result?.output as Record<string, unknown> | undefined;
    if (!output || typeof output !== 'object')
      throw new DecideError('JEV_INVALID_RESPONSE', 'decide returned no output');
    if (output['success'] === false) {
      const failure = output as unknown as DecideFailure;
      throw new DecideError(failure.code || 'JEV_UNAVAILABLE', failure.error || 'decide failed');
    }
    return output;
  };
  return {
    async judge(input) {
      const output = await call(input);
      if (typeof output['answers'] !== 'object' || output['answers'] === null) {
        throw new DecideError('JEV_INVALID_RESPONSE', 'decide answered without answers');
      }
      return output as unknown as DecideMultiOutput;
    },
    async extract(input) {
      return (await call(input)) as unknown as DecideSchemaOutput;
    },
    async probe() {
      const response = await execute(
        // Deliberately empty: the service refuses it before any model request.
        {
          protocolVersion: RUNTIME_PROTOCOL_VERSION,
          targetType: 'operation',
          target: DECIDE_CAPABILITY,
          input: {},
        },
        context,
      ).catch((error: unknown) => ({
        status: 'failed' as const,
        error: { code: 'ERROR', message: String(error) },
      }));
      if (response.status === 'not_found')
        return { available: false, detail: `${DECIDE_CAPABILITY} is not offered by this host` };
      if (response.status === 'denied')
        return { available: false, detail: `${DECIDE_CAPABILITY} is denied by policy` };
      return {
        available: true,
        detail: `${DECIDE_CAPABILITY} is offered; its key is checked on the first real call`,
      };
    },
  };
}
