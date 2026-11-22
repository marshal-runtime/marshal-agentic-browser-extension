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

/**
 * A failed decide call. `unavailable` codes stop a task with `decisions_unavailable`. So does any failure of the host
 * to run the capability at all (`hostFailure`: a non-success runtime status or a rejected call), whatever its code:
 * those say nothing about the page, so they must not read as the page being `blocked`.
 */
export class DecideError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly hostFailure = false,
  ) {
    super(`${code}: ${message}`);
    this.name = 'DecideError';
  }

  get unavailable(): boolean {
    return this.hostFailure || UNAVAILABLE.has(this.code);
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
    ).catch((error: unknown) => {
      throw new DecideError(
        'HOST_ERROR',
        error instanceof Error ? error.message : String(error),
        true,
      );
    });
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
        true,
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

/**
 * An embedding host's own decide function (a host without the `marshal.models.decide` capability, e.g. a brand VM that
 * forwards each question set to its server): it takes the capability's input and answers with its output. The model,
 * provider and key stay the host's; this package adds none (R5.2).
 */
export type DecideFunction = (
  input: DecideMultiInput | DecideSchemaInput,
  context?: InvocationContext,
) => Promise<unknown>;

/**
 * `execute` answering only `marshal.models.decide` from a host's decide function, so the decider above keeps every
 * check of the answer. The empty probe input is answered without a call; a thrown error is a host failure
 * (`decisions_unavailable`), never a page verdict.
 */
export function decideFunctionExecute(
  decide: DecideFunction,
  fallback?: RuntimeExecuteFn,
): RuntimeExecuteFn {
  return async (request, context) => {
    if (request.target !== DECIDE_CAPABILITY) {
      if (fallback) return fallback(request, context);
      return {
        protocolVersion: RUNTIME_PROTOCOL_VERSION,
        status: 'not_found',
        error: { code: 'NOT_FOUND', message: `${request.target} is not offered by this host` },
      };
    }
    const input = request.input as Record<string, unknown> | undefined;
    if (!input || Object.keys(input).length === 0)
      return {
        protocolVersion: RUNTIME_PROTOCOL_VERSION,
        status: 'success',
        result: { output: { success: false, code: 'JEV_BAD_REQUEST', error: 'empty probe' } },
      };
    const output = await decide(input as unknown as DecideMultiInput | DecideSchemaInput, context);
    return { protocolVersion: RUNTIME_PROTOCOL_VERSION, status: 'success', result: { output } };
  };
}
