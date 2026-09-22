export type JsonSchema = Readonly<Record<string, unknown>>;

export interface RuntimePrincipal {
  readonly id: string;
  readonly kind: string;
  readonly claims?: Readonly<Record<string, unknown>>;
}

export interface RuntimeScope {
  readonly workspaceId?: string;
  readonly projectId?: string;
  readonly sessionId?: string;
  readonly threadId?: string;
  readonly [key: string]: string | undefined;
}

export interface InvocationContext {
  readonly principal: RuntimePrincipal;
  readonly scope?: RuntimeScope;
  readonly executionId?: string;
  /** Host-assigned browser instance; never supplied by the model. */
  readonly browserInstanceId?: string;
  readonly signal?: { readonly aborted: boolean; readonly reason?: unknown };
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface RuntimeExtensionManifest {
  readonly schemaVersion: 1;
  readonly identity: string;
  readonly version: string;
  readonly entrypoint: string;
  readonly moduleFormat: 'commonjs-bundle-v1';
}

export interface RuntimeServiceAccessor {
  get<T>(token: RuntimeServiceToken<T>): T;
}

export type RuntimeServiceToken<T> = symbol & { readonly __type?: (value: T) => T };

export interface RuntimeExtensionActivationContext {
  readonly manifest: RuntimeExtensionManifest;
  readonly configuration: Readonly<Record<string, unknown>>;
  readonly services: RuntimeServiceAccessor;
}

export interface CapabilityDescriptor {
  readonly protocolVersion: '1.0.0';
  readonly name: string;
  readonly version: string;
  readonly title: string;
  readonly description: string;
  readonly tags: readonly string[];
  readonly inputSchema: JsonSchema;
  readonly outputSchema: JsonSchema;
}

export interface CapabilityProvider {
  readonly id: string;
  readonly version: string;
  list(context: InvocationContext): readonly CapabilityDescriptor[];
  get(name: string, context: InvocationContext): CapabilityDescriptor | undefined;
  invoke(
    name: string,
    input: unknown,
    context: InvocationContext,
  ): Promise<{ readonly output: unknown }>;
}

export interface RuntimeExtensionActivation {
  readonly capabilityProviders?: readonly CapabilityProvider[];
  readonly dispose?: () => void | Promise<void>;
}

export interface KeyVaultEntry {
  readonly key: string;
  readonly username: string;
  readonly password: string;
  readonly allowedUrlPatterns: readonly string[];
  readonly notBefore: string;
  readonly expiresAt: string;
}

export interface KeyVaultStore {
  get(key: string): Promise<KeyVaultEntry | undefined>;
  /** Host/UI provisioning method; never exposed as an agent capability. */
  put(entry: KeyVaultEntry): Promise<void>;
  /** Host/UI removal method; never exposed as an agent capability. */
  remove?(key: string): Promise<void>;
  /** Optional metadata-only listing for host/UI administration. */
  listMetadata?(): Promise<readonly KeyVaultEntryMetadata[]>;
}

export interface KeyVaultEntryMetadata {
  readonly key: string;
  readonly allowedUrlPatterns: readonly string[];
  readonly notBefore: string;
  readonly expiresAt: string;
}

export interface SecretInputRequest {
  readonly selector: string;
  readonly text: string;
  readonly allowedUrlPatterns: readonly string[];
  /** Host-assigned browser instance binding for Safari or multi-browser hosts. */
  readonly browserInstanceId?: string;
  readonly clearFirst?: boolean;
  readonly timeout?: number;
}

export interface SecretInputSink {
  typeSecret(
    request: SecretInputRequest,
    context: InvocationContext,
  ): Promise<{ readonly success: boolean }>;
}

export const KEYVAULT_STORE_SERVICE = Symbol.for(
  '@marshal/keyvault:store',
) as RuntimeServiceToken<KeyVaultStore>;

export const KEYVAULT_SECRET_INPUT_SERVICE = Symbol.for(
  '@marshal/keyvault:secret-input',
) as RuntimeServiceToken<SecretInputSink>;

export interface AgenticBrowserRuntimeHost {
  invokeSecretType(
    input: Record<string, unknown>,
    context: InvocationContext,
  ): Promise<{
    readonly success: boolean;
    readonly error?: { readonly code?: string; readonly message?: string };
  }>;
}
