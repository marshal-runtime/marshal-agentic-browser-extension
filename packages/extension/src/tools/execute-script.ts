/**
 * Execute-script and execute-console-command tool handlers.
 *
 * {@link createExecuteScriptHandler} validates incoming parameters via
 * {@link ExecuteScriptParamsSchema}, delegates to
 * {@link IBrowserAdapter.executeScript}, and returns the serialised result.
 *
 * {@link createExecuteConsoleHandler} validates incoming parameters via
 * {@link ExecuteConsoleCommandParamsSchema}, delegates to
 * {@link IBrowserAdapter.executeConsoleCommand}, and returns console output
 * separated from the return value with log levels distinguished.
 */

import type { IBrowserAdapter, ValidationResult } from '@agentic-browser/shared';
import { ExecuteScriptParamsSchema, ExecuteConsoleCommandParamsSchema, ExecuteScriptFileParamsSchema, ExecuteValidationParamsSchema, ErrorCode } from '@agentic-browser/shared';

/** Default timeout for script execution (30 seconds). */
const DEFAULT_EXECUTE_SCRIPT_TIMEOUT = 30_000;

/** Default timeout for console command execution (30 seconds). */
const DEFAULT_CONSOLE_COMMAND_TIMEOUT = 30_000;

/** Default timeout for script file execution (30 seconds). */
const DEFAULT_SCRIPT_FILE_TIMEOUT = 30_000;

/** Default timeout for validation execution (30 seconds). */
const DEFAULT_VALIDATION_TIMEOUT = 30_000;

/**
 * Creates an execute-script command handler bound to the given browser adapter.
 *
 * The returned function validates raw params with Zod, calls the adapter's
 * executeScript method, and returns the JSON-serialised result.
 */
export function createExecuteScriptHandler(adapter: IBrowserAdapter) {
  return async (params: unknown): Promise<unknown> => {
    const parsed = ExecuteScriptParamsSchema.safeParse(params);

    if (!parsed.success) {
      throw new Error(`Invalid executeScript params: ${parsed.error.issues.map((i) => i.message).join(', ')}`);
    }

    const { script, args, timeout } = parsed.data;

    const result = await adapter.executeScript({
      script,
      args,
      timeout: timeout ?? DEFAULT_EXECUTE_SCRIPT_TIMEOUT,
    });

    if (!result.ok) {
      const error = result.error;
      throw new Error(`[${error.code}] ${error.message}`);
    }

    const value = result.value;

    if (value === undefined || value === null) {
      return value ?? null;
    }

    if (typeof value === 'object') {
      try {
        return JSON.parse(JSON.stringify(value));
      } catch {
        return String(value);
      }
    }

    return value;
  };
}

/**
 * Creates an execute-console-command handler bound to the given browser adapter.
 *
 * The returned function validates raw params with Zod, calls the adapter's
 * executeConsoleCommand method, and returns an object containing both the
 * return value and captured console output with log/warn/error levels.
 */
export function createExecuteConsoleHandler(adapter: IBrowserAdapter) {
  return async (params: unknown): Promise<unknown> => {
    const parsed = ExecuteConsoleCommandParamsSchema.safeParse(params);

    if (!parsed.success) {
      throw new Error(`Invalid executeConsoleCommand params: ${parsed.error.issues.map((i) => i.message).join(', ')}`);
    }

    const { command, timeout } = parsed.data;

    const result = await adapter.executeConsoleCommand({
      command,
      timeout: timeout ?? DEFAULT_CONSOLE_COMMAND_TIMEOUT,
    });

    if (!result.ok) {
      const error = result.error;
      throw new Error(`[${error.code}] ${error.message}`);
    }

    return result.value;
  };
}

/**
 * Creates an execute-script-file handler bound to the given browser adapter.
 *
 * The returned function validates raw params with Zod, calls the adapter's
 * executeScriptFile method, and returns the result.
 */
export function createExecuteScriptFileHandler(adapter: IBrowserAdapter) {
  return async (params: unknown): Promise<unknown> => {
    const parsed = ExecuteScriptFileParamsSchema.safeParse(params);

    if (!parsed.success) {
      throw new Error(`Invalid executeScriptFile params: ${parsed.error.issues.map((i: { message: string }) => i.message).join(', ')}`);
    }

    const { file, timeout } = parsed.data;

    const result = await adapter.executeScriptFile({
      file,
      timeout: timeout ?? DEFAULT_SCRIPT_FILE_TIMEOUT,
    });

    if (!result.ok) {
      const error = result.error;
      throw new Error(`[${error.code}] ${error.message}`);
    }

    return result.value ?? null;
  };
}

/**
 * Creates a validation script handler bound to the given browser adapter.
 *
 * The returned function validates raw params with Zod, calls the adapter's
 * executeValidation method, and returns a structured validation report.
 */
export function createExecuteValidationHandler(adapter: IBrowserAdapter) {
  return async (params: unknown): Promise<ValidationResult> => {
    const parsed = ExecuteValidationParamsSchema.safeParse(params);

    if (!parsed.success) {
      throw new Error(`Invalid executeValidation params: ${parsed.error.issues.map((i: { message: string }) => i.message).join(', ')}`);
    }

    const { script, timeout } = parsed.data;

    const result = await adapter.executeValidation({
      script,
      timeout: timeout ?? DEFAULT_VALIDATION_TIMEOUT,
    });

    if (!result.ok) {
      const error = result.error;
      throw new Error(`[${error.code}] ${error.message}`);
    }

    return result.value;
  };
}
