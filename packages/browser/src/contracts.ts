/**
 * Types-only copies of the Marshal Runtime contracts this package uses, lifted from
 * packages/automation-extension/src/contracts.ts (e23e966). The package imports no runtime values from the host or
 * another extension: the live objects arrive through activate()'s context.
 */

export type MaybePromise<T> = T | Promise<T>;
export type JsonSchema = Readonly<Record<string, unknown>>;

// ---------------------------------------------------------------------------
// Marshal Runtime capability protocol (subset of @marshal/agent-runtime-core)
// ---------------------------------------------------------------------------

export interface RuntimeHarnessIdentity {
  readonly harnessId: string;
  readonly installationId?: string;
  readonly profileId?: string;
  readonly userId?: string;
  readonly agentId?: string;
}

export interface RuntimeScope {
  readonly workspaceId?: string;
  readonly projectId?: string;
  readonly sessionId?: string;
  readonly threadId?: string;
  readonly parentExecutionId?: string;
  readonly [key: string]: string | undefined;
}

export interface RuntimePrincipal {
  readonly id: string;
  readonly kind: string;
  readonly claims?: Readonly<Record<string, unknown>>;
}

export interface RuntimeAbortSignal {
  readonly aborted: boolean;
  readonly reason?: unknown;
}

export interface InvocationContext {
  readonly principal: RuntimePrincipal;
  readonly identity?: RuntimeHarnessIdentity;
  readonly scope?: RuntimeScope;
  readonly executionId?: string;
  /** Host-assigned browser instance; never supplied by the model. */
  readonly browserInstanceId?: string;
  readonly signal?: RuntimeAbortSignal;
  readonly approval?: Readonly<Record<string, unknown>>;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface CapabilityPermissionRequirement {
  readonly permission: string;
  readonly reason?: string;
  readonly scope?: string;
  readonly risk?: 'low' | 'medium' | 'high' | 'critical';
}

export interface CapabilityDescriptor {
  readonly protocolVersion: '1.0.0';
  readonly name: string;
  readonly version: string;
  readonly title?: string;
  readonly description: string;
  readonly tags?: readonly string[];
  readonly inputSchema?: JsonSchema;
  readonly outputSchema: JsonSchema;
  readonly permissions?: readonly CapabilityPermissionRequirement[];
}

export interface CapabilityInvocationResult<TOutput = unknown> {
  readonly output: TOutput;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface CapabilityProvider {
  readonly id: string;
  readonly version?: string;
  list(context: InvocationContext): MaybePromise<readonly CapabilityDescriptor[]>;
  get?(name: string, context: InvocationContext): MaybePromise<CapabilityDescriptor | undefined>;
  invoke(
    name: string,
    input: unknown,
    context: InvocationContext,
  ): MaybePromise<CapabilityInvocationResult>;
}

export const RUNTIME_PROTOCOL_VERSION = '1.0.0';

/** Adapter-friendly request for a named provider operation (RuntimeOperationExecuteRequest). */
export interface RuntimeOperationExecuteRequest {
  readonly protocolVersion: string;
  readonly targetType: 'operation';
  readonly target: string;
  readonly input?: unknown;
  readonly requestId?: string;
  readonly approval?: Readonly<Record<string, unknown>>;
}

export type RuntimeExecutionStatus =
  | 'success'
  | 'not_found'
  | 'denied'
  | 'approval_required'
  | 'failed'
  | 'cancelled';

export interface RuntimeError {
  readonly code: string;
  readonly message: string;
  readonly details?: unknown;
}

export interface RuntimeExecResponse<TOutput = unknown> {
  readonly protocolVersion: string;
  readonly status: RuntimeExecutionStatus;
  readonly result?: CapabilityInvocationResult<TOutput>;
  readonly error?: RuntimeError;
  readonly receipt?: unknown;
}

/**
 * The activation context handed to `activate()` (see
 * agent-runtime-extensions' RuntimeExtensionActivationContext,
 * `execute()` at src/manager.ts:1421). A capability provider captures
 * `execute` via closure in `activate()` because `execute` is NOT part of
 * the per-invocation InvocationContext passed to CapabilityProvider.invoke().
 */
export interface RuntimeExtensionActivationContext<
  TConfiguration extends Readonly<Record<string, unknown>> = Readonly<Record<string, unknown>>,
> {
  readonly manifest: { readonly identity: string; readonly version: string };
  readonly configuration: TConfiguration;
  readonly services: RuntimeServiceAccessor;
  readonly signal?: RuntimeAbortSignal;
  execute<TOutput = unknown>(
    request: RuntimeOperationExecuteRequest,
    context?: InvocationContext,
  ): Promise<RuntimeExecResponse<TOutput>>;
}

/**
 * Non-generic view of `RuntimeExtensionActivationContext['execute']`, used
 * wherever this package stores/passes the bound `execute` function (a
 * concrete generic instantiation is not assignable to a generic call
 * signature in a field position). A real bound `context.execute` value -
 * which IS generic - satisfies this narrower shape structurally.
 */
export type RuntimeExecuteFn = (
  request: RuntimeOperationExecuteRequest,
  context?: InvocationContext,
) => Promise<RuntimeExecResponse>;

/**
 * A service-lookup token branded with the type it resolves to, so `get`/
 * `tryGet` can be typed via the token's own generic parameter (which
 * `@typescript-eslint/no-unnecessary-type-parameters` requires - a type
 * param must appear more than once in the signature). The brand is a
 * compile-time-only phantom field; a `ServiceToken<T>` is still a plain
 * `symbol` at runtime, so existing `Symbol.for(...)` tokens are unaffected.
 */
export type ServiceToken<T> = symbol & { readonly __serviceType?: T };

export interface RuntimeServiceAccessor {
  get<T>(token: ServiceToken<T>): T;
  tryGet<T>(token: ServiceToken<T>): T | undefined;
}

export interface RuntimeExtensionActivation {
  readonly capabilityProviders?: readonly CapabilityProvider[];
  readonly dispose?: () => MaybePromise<void>;
}

// ---------------------------------------------------------------------------
// marshal.models.decide (marshal-sdk src/models; contract: decide-contract.md of 2026-11-22).
// The extension reaches every model through this one capability: no provider, key or model name here.
// ---------------------------------------------------------------------------

export const DECIDE_CAPABILITY = 'marshal.models.decide';

export type DecideImage =
  | string
  | { readonly url: string; readonly detail?: 'low' | 'high' | 'auto' | 'original' };

export type DecideQuestion =
  | {
      readonly type: 'choice';
      readonly criteria: Readonly<Record<string, string>>;
      readonly instructions?: string;
      readonly images?: readonly DecideImage[];
    }
  | {
      readonly type: 'predicate';
      readonly instructions: string;
      readonly images?: readonly DecideImage[];
    }
  | {
      readonly type: 'score';
      readonly criteria: Readonly<Record<string, string>>;
      readonly instructions?: string;
      readonly images?: readonly DecideImage[];
    };

export interface DecideMultiInput {
  readonly state: string;
  readonly images?: readonly DecideImage[];
  readonly questions: Readonly<Record<string, DecideQuestion>>;
}

export interface DecideSchemaInput {
  readonly question: string;
  readonly schema: Readonly<Record<string, unknown>>;
  readonly context: string;
  readonly images?: readonly DecideImage[];
}

export type DecideAnswer =
  | {
      readonly type: 'choice';
      readonly choice: string;
      readonly confidence: number;
      readonly probabilities: Readonly<Record<string, number>>;
    }
  | { readonly type: 'predicate'; readonly probability: number }
  | {
      readonly type: 'score';
      readonly score: number;
      readonly confidence: number;
      readonly probabilities: Readonly<Record<string, number>>;
    }
  | { readonly type: 'noul'; readonly noul: number }
  | { readonly type: 'refusal' };

export interface DecideMultiOutput {
  readonly success: true;
  readonly answers: Readonly<Record<string, DecideAnswer>>;
  readonly provider?: string;
  readonly model?: string;
  readonly usage?: { readonly input_tokens?: number; readonly output_tokens?: number };
  readonly latencyMs?: number;
}

export interface DecideSchemaOutput {
  readonly success: true;
  readonly choice: unknown;
  readonly provider?: string;
  readonly model?: string;
  readonly latencyMs?: number;
}

export interface DecideFailure {
  readonly success: false;
  readonly error: string;
  readonly code: string;
}
