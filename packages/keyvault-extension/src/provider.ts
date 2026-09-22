import type {
  AgenticBrowserRuntimeHost,
  CapabilityDescriptor,
  CapabilityProvider,
  InvocationContext,
  KeyVaultStore,
  SecretInputRequest,
  SecretInputSink,
} from './contracts.js';
import { assertWindowOpen, validateEntry } from './validation.js';

export const KEYVAULT_WRITE_TO_INPUT_BOX = 'keyvault.write_to_input_box';

const INPUT_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    key: { type: 'string', minLength: 1, description: 'Operator-chosen vault key.' },
    usernameSelector: {
      type: 'string',
      minLength: 1,
      description: 'Exact CSS selector for the username input.',
    },
    passwordSelector: {
      type: 'string',
      minLength: 1,
      description: 'Exact CSS selector for the password input.',
    },
    clearFirst: { type: 'boolean' },
    timeout: { type: 'integer', minimum: 1 },
  },
  required: ['key'],
  additionalProperties: false,
});

const OUTPUT_SCHEMA = Object.freeze({
  type: 'object',
  required: ['success', 'key', 'filled'],
  properties: {
    success: { type: 'boolean' },
    key: { type: 'string' },
    filled: { type: 'array', items: { type: 'string', enum: ['username', 'password'] } },
  },
  additionalProperties: false,
});

export interface KeyVaultProviderOptions {
  readonly store: KeyVaultStore;
  readonly sink: SecretInputSink;
  readonly now?: () => Date;
}

export function createKeyVaultProvider(options: KeyVaultProviderOptions): CapabilityProvider {
  const descriptor: CapabilityDescriptor = Object.freeze({
    protocolVersion: '1.0.0',
    name: KEYVAULT_WRITE_TO_INPUT_BOX,
    version: '1.0.0',
    title: 'Write KeyVault credential to browser inputs',
    description:
      'Writes an operator-provisioned credential into explicitly selected browser inputs without returning the secret.',
    tags: ['keyvault', 'credentials', 'browser', 'secret-input'],
    inputSchema: INPUT_SCHEMA,
    outputSchema: OUTPUT_SCHEMA,
  });

  return Object.freeze({
    id: '@marshal/keyvault:capabilities',
    version: '1.0.0',
    list: () => Object.freeze([descriptor]),
    get: (name: string) => (name === KEYVAULT_WRITE_TO_INPUT_BOX ? descriptor : undefined),
    invoke: async (name: string, input: unknown, context: InvocationContext) => {
      if (name !== KEYVAULT_WRITE_TO_INPUT_BOX)
        throw new Error(`Unknown KeyVault capability: ${name}`);
      if (context.signal?.aborted) throw new Error('KEYVAULT_ABORTED: invocation was aborted');
      const request = parseRequest(input);
      const entry = await options.store.get(request.key);
      if (!entry) throw new Error('KEYVAULT_NOT_FOUND: no credential exists for that key');
      const validated = validateEntry(entry);
      assertWindowOpen(validated, options.now?.() ?? new Date());

      const filled: Array<'username' | 'password'> = [];
      if (request.usernameSelector !== undefined) {
        await typeSecret(
          options.sink,
          {
            selector: request.usernameSelector,
            text: validated.username,
            allowedUrlPatterns: validated.allowedUrlPatterns,
            browserInstanceId: context.browserInstanceId,
            clearFirst: request.clearFirst,
            timeout: request.timeout,
          },
          context,
        );
        filled.push('username');
      }
      if (request.passwordSelector !== undefined) {
        await typeSecret(
          options.sink,
          {
            selector: request.passwordSelector,
            text: validated.password,
            allowedUrlPatterns: validated.allowedUrlPatterns,
            browserInstanceId: context.browserInstanceId,
            clearFirst: request.clearFirst,
            timeout: request.timeout,
          },
          context,
        );
        filled.push('password');
      }
      if (filled.length === 0)
        throw new Error(
          'KEYVAULT_SELECTOR_REQUIRED: provide a usernameSelector or passwordSelector',
        );
      return { output: { success: true, key: validated.key, filled } };
    },
  });
}

export function createAgenticBrowserSecretInputSink(
  host: AgenticBrowserRuntimeHost,
): SecretInputSink {
  return Object.freeze({
    typeSecret: async (request: SecretInputRequest, context: InvocationContext) => {
      const result = await host.invokeSecretType({ ...request }, context);
      if (!result.success) {
        const code = result.error?.code ?? 'KEYVAULT_INPUT_FAILED';
        throw new Error(`${code}: credential was not written`);
      }
      return { success: true };
    },
  });
}

function parseRequest(input: unknown): {
  readonly key: string;
  readonly usernameSelector?: string;
  readonly passwordSelector?: string;
  readonly clearFirst?: boolean;
  readonly timeout?: number;
} {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new Error('KEYVAULT_INVALID_INPUT: capability input must be an object');
  }
  const value = input as Record<string, unknown>;
  if (typeof value['key'] !== 'string' || value['key'].trim().length === 0) {
    throw new Error('KEYVAULT_INVALID_INPUT: key is required');
  }
  const usernameSelector = optionalString(value['usernameSelector'], 'usernameSelector');
  const passwordSelector = optionalString(value['passwordSelector'], 'passwordSelector');
  if (usernameSelector === undefined && passwordSelector === undefined) {
    throw new Error('KEYVAULT_SELECTOR_REQUIRED: provide a usernameSelector or passwordSelector');
  }
  if (value['clearFirst'] !== undefined && typeof value['clearFirst'] !== 'boolean') {
    throw new Error('KEYVAULT_INVALID_INPUT: clearFirst must be boolean');
  }
  if (
    value['timeout'] !== undefined &&
    (typeof value['timeout'] !== 'number' ||
      !Number.isInteger(value['timeout']) ||
      value['timeout'] <= 0)
  ) {
    throw new Error('KEYVAULT_INVALID_INPUT: timeout must be a positive integer');
  }
  return {
    key: value['key'],
    ...(usernameSelector === undefined ? {} : { usernameSelector }),
    ...(passwordSelector === undefined ? {} : { passwordSelector }),
    ...(value['clearFirst'] === undefined ? {} : { clearFirst: value['clearFirst'] }),
    ...(value['timeout'] === undefined ? {} : { timeout: value['timeout'] }),
  };
}

function optionalString(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.trim().length === 0)
    throw new Error(`KEYVAULT_INVALID_INPUT: ${name} must be a non-empty string`);
  return value;
}

async function typeSecret(
  sink: SecretInputSink,
  request: SecretInputRequest,
  context: InvocationContext,
): Promise<void> {
  if (context.signal?.aborted) throw new Error('KEYVAULT_ABORTED: invocation was aborted');
  await sink.typeSecret(request, context);
}
