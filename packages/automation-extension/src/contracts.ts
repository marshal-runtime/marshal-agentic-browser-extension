/**
 * Local, types-only copies of the host/extension contracts this package
 * depends on. Per CLAUDE.md conventions for consuming another extension's
 * service (see @marshal/jev's own header comment), and per the keyvault
 * pattern (packages/keyvault-extension/src/contracts.ts): this package never
 * imports runtime VALUES from @agentic-browser/runtime-host,
 * @agentic-browser/mcp-server, or @agentic-browser/shared - only the shapes
 * it needs, declared locally. The live objects are resolved at activation
 * time via require()/service injection (see runtime.ts / extension.ts).
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
// marshal.agent.* operation shapes (electron/marshal-runtime/agent-provider.ts)
// ---------------------------------------------------------------------------

export type RuntimeAgentReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface MarshalRuntimeAgentLaunchInput {
  readonly task: string;
  readonly idempotencyKey: string;
  readonly sessionId?: string;
  readonly name?: string;
  readonly agentName?: string;
  readonly model?: string;
  readonly reasoningEffort?: RuntimeAgentReasoningEffort;
  readonly soul?: string;
  readonly workspaceName?: string;
  readonly repoPath?: string;
  readonly runtimeAgentRole?:
    | 'planner'
    | 'worker'
    | 'reviewer'
    | 'validator'
    | 'reconciler'
    | 'brain'
    | 'swarm';
  readonly createWorktree?: boolean;
  readonly worktreeName?: string;
  readonly branchName?: string;
  readonly baseRef?: string;
}

export interface MarshalRuntimeAgent {
  readonly id: string;
  readonly name: string;
  readonly state: 'running' | 'idle';
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly sessionId?: string;
  readonly executionId?: string;
  readonly model?: string;
  readonly reasoningEffort?: RuntimeAgentReasoningEffort;
  readonly runtimeAgentRole?: string;
  readonly [key: string]: unknown;
}

export interface MarshalRuntimeAgentLaunchOutput {
  readonly agent: MarshalRuntimeAgent;
}

export interface MarshalRuntimeAgentWaitInput {
  readonly agentId: string;
  readonly messageId?: string;
  readonly timeoutMs?: number;
}

export interface MarshalRuntimeAgentWaitOutput {
  readonly state: 'completed' | 'timeout';
  readonly agent: MarshalRuntimeAgent;
  readonly result?: string;
}

export interface MarshalRuntimeAgentIdInput {
  readonly agentId: string;
}

// ---------------------------------------------------------------------------
// Agentic browser host module (packages/runtime-extension/src/contracts.ts)
// ---------------------------------------------------------------------------

export interface BrowserRequestContext {
  readonly chatId: string;
  readonly executionId: string;
  readonly browserSessionId: string;
  readonly browserInstanceId?: string;
}

export interface ResolvedBrowserSession {
  readonly context: BrowserRequestContext;
  readonly created: boolean;
}

export interface BrowserCommandError {
  readonly code: string;
  readonly message: string;
  readonly details?: unknown;
}

export interface BrowserCommandResult {
  readonly success: boolean;
  readonly data?: unknown;
  readonly error?: BrowserCommandError;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/**
 * Narrowed subset of MarshalBrowserRuntimeHostModule (this package only
 * calls invokeBrowserCommand/resolveBrowserSession/createId - never
 * invokeSecretType, which is keyvault's host-only path).
 */
export interface AgenticBrowserRuntimeHost {
  createId(kind: 'browser-session' | 'execution' | 'event'): string;
  resolveBrowserSession?(context: InvocationContext): ResolvedBrowserSession;
  invokeBrowserCommand(
    name: string,
    input: Record<string, unknown>,
    context: BrowserRequestContext,
  ): Promise<BrowserCommandResult>;
}

// ---------------------------------------------------------------------------
// Jev client (types only - see extensions/jev-runtime-extension/src/api.ts)
// ---------------------------------------------------------------------------

export const JEV_CLIENT_SERVICE_ID = '@marshal/jev:client';
export const JEV_CLIENT_SERVICE_TOKEN: ServiceToken<JevClient> = Symbol.for(
  JEV_CLIENT_SERVICE_ID,
) as ServiceToken<JevClient>;

export interface ChoiceQuestion {
  readonly type: 'choice';
  readonly criteria: Readonly<Record<string, unknown>>;
  readonly instructions?: unknown;
}

export interface NoulQuestion {
  readonly type: 'noul';
  readonly criteria?: Readonly<{ true?: unknown; false?: unknown }>;
  readonly instructions?: unknown;
}

export type JevQuestion = ChoiceQuestion | NoulQuestion;

export interface ChoiceAnswer {
  readonly type?: 'choice';
  readonly choice: string;
  readonly probabilities: Readonly<Record<string, number>>;
  readonly confidence: number;
}

export interface NoulAnswer {
  readonly type: 'noul';
  readonly noul: number;
}

export type JevAnswer = ChoiceAnswer | NoulAnswer;

export interface JevAskRequest {
  readonly model?: string;
  readonly state: string | Readonly<Record<string, unknown>> | readonly unknown[] | null;
  readonly questions: Readonly<Record<string, JevQuestion>>;
}

export interface JevAskOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

export interface JevAskResult {
  readonly answers: Readonly<Record<string, JevAnswer>>;
  readonly model: string;
  readonly usage: { readonly input_tokens: number; readonly output_tokens: number };
  readonly latencyMs: number;
}

export type JevConnectionState =
  | 'not-connected'
  | 'connected'
  | 'invalid-key'
  | 'rate-limited'
  | 'unavailable';

export interface JevStatus {
  readonly state: JevConnectionState;
  readonly model: string;
  readonly source?: 'env' | 'stored';
  readonly lastVerifiedAt?: string;
  readonly detail?: string;
}

export interface JevClient {
  status(): Promise<JevStatus>;
  ask(request: JevAskRequest, options?: JevAskOptions): Promise<JevAskResult>;
  listModels?(): Promise<readonly unknown[]>;
}
