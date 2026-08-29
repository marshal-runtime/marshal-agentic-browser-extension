export type MaybePromise<T> = T | Promise<T>;
export type JsonSchema = Readonly<Record<string, unknown>>;

export interface BrowserRequestContext {
  readonly chatId: string;
  readonly executionId: string;
  readonly browserSessionId: string;
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

export interface BrowserCommandMetadata {
  readonly duration: number;
  readonly timestamp: number;
  readonly commandId?: string;
  readonly context?: BrowserRequestContext;
  readonly activeTabId?: number;
  readonly ownedTabIds?: readonly number[];
  readonly browserContextId?: string;
  readonly windowId?: number;
}

export interface RuntimeExtensionManifest {
  readonly schemaVersion: 1;
  readonly identity: string;
  readonly version: string;
  readonly entrypoint: string;
  readonly moduleFormat: 'commonjs-bundle-v1';
}

export interface RuntimePrincipal {
  readonly id: string;
  readonly kind: string;
  readonly claims?: Readonly<Record<string, unknown>>;
}

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

export interface RuntimeAbortSignal {
  readonly aborted: boolean;
  readonly reason?: unknown;
}

export interface InvocationContext {
  readonly principal: RuntimePrincipal;
  readonly identity?: RuntimeHarnessIdentity;
  readonly scope?: RuntimeScope;
  readonly executionId?: string;
  readonly signal?: RuntimeAbortSignal;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface RuntimeExtensionActivationContext {
  readonly manifest: RuntimeExtensionManifest;
  readonly signal?: RuntimeAbortSignal;
  search(request: unknown, context?: InvocationContext): Promise<unknown>;
  execute<TOutput = unknown>(request: unknown, context?: InvocationContext): Promise<TOutput>;
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
  readonly annotations?: Readonly<Record<string, unknown>>;
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

export interface RuntimeCatalogAction {
  readonly type: 'host_tool';
  readonly toolId: string;
}

export interface RuntimeCatalogEntry {
  readonly id: string;
  readonly kind: 'host_tool';
  readonly title: string;
  readonly description: string;
  readonly tags?: readonly string[];
  readonly action: RuntimeCatalogAction;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface RuntimeCatalogProvider {
  readonly id: string;
  list(context: InvocationContext): MaybePromise<readonly RuntimeCatalogEntry[]>;
  get?(id: string, context: InvocationContext): MaybePromise<RuntimeCatalogEntry | undefined>;
}

export interface RuntimeExtensionActivation {
  readonly capabilityProviders?: readonly CapabilityProvider[];
  readonly catalogProviders?: readonly RuntimeCatalogProvider[];
  readonly dispose?: () => MaybePromise<void>;
}

export type BrowserLifecycleEventType =
  | 'created'
  | 'navigation'
  | 'interaction'
  | 'pause'
  | 'completion'
  | 'failure';

export interface BrowserLifecycleEvent {
  readonly protocolVersion: '1.0.0';
  readonly id: string;
  readonly type: BrowserLifecycleEventType;
  readonly occurredAt: string;
  readonly context: BrowserRequestContext;
  readonly command?: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

export interface BrowserCommandResult {
  readonly success: boolean;
  readonly data?: unknown;
  readonly error?: BrowserCommandError;
  readonly metadata?: BrowserCommandMetadata;
}

export interface MarshalBrowserRuntimeHostModule {
  createId(kind: 'browser-session' | 'execution' | 'event'): string;
  now(): string;
  resolveBrowserSession?(context: InvocationContext): ResolvedBrowserSession;
  invokeBrowserCommand(
    name: string,
    input: Record<string, unknown>,
    context: BrowserRequestContext,
  ): Promise<BrowserCommandResult>;
  publishLifecycleEvent(event: BrowserLifecycleEvent): Promise<void>;
  openOrFocusPanel(context: BrowserRequestContext): Promise<void>;
  dispose?(): MaybePromise<void>;
}
