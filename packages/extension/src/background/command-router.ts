/**
 * Command router that validates incoming commands with Zod schemas,
 * dispatches to registered handlers by command name, and returns
 * structured responses with execution timing metadata.
 *
 * Supports sequential batch execution with per-step checkpointing
 * and resume capability.
 */

import type { z } from 'zod';
import { Logger } from '../infrastructure/logger.js';
import { checkpointManager } from '../infrastructure/index.js';
import type { StepResult } from '../infrastructure/index.js';
import { CommandRequestSchema } from '@agentic-browser/shared';
import type {
  CommandName,
  CommandRequest,
  CommandResponse,
  CommandResponseError,
  CommandResponseMetadata,
  BrowserRequestContext,
} from '@agentic-browser/shared';
import {
  BrowserSessionScopeError,
  type BrowserCommandScope,
  type ScopedCommandResult,
} from './browser-session-scope.js';

const logger = Logger.getInstance();

/** Error code for Zod validation failures on command parameters. */
const INVALID_PARAMS = 'INVALID_PARAMS';

/** Error code for commands that have no registered handler. */
const UNKNOWN_COMMAND = 'UNKNOWN_COMMAND';

/** Error code for unexpected handler execution failures. */
const INTERNAL_ERROR = 'INTERNAL_ERROR';

/** Error code returned when the batch overall timeout is exceeded. */
const BATCH_TIMEOUT = 'BATCH_TIMEOUT';

/** Execution mode for batch command processing. */
export type BatchExecutionMode = 'best-effort' | 'strict';

/** A single command entry within a batch. */
export interface BatchCommand {
  readonly command: CommandName;
  readonly params?: Record<string, unknown>;
}

/** Options controlling batch execution behaviour. */
export interface BatchOptions {
  readonly mode: BatchExecutionMode;
  readonly timeoutMs?: number;
  readonly checkpointId?: string;
  readonly context?: BrowserRequestContext;
}

/** Result of a single step within a batch execution. */
export interface BatchStepResult {
  readonly stepIndex: number;
  readonly command: CommandName;
  readonly response: CommandResponse;
}

/** Aggregate result returned by executeBatch / resumeBatch. */
export interface BatchResult {
  readonly checkpointId: string;
  readonly completed: boolean;
  readonly steps: BatchStepResult[];
  readonly totalDuration: number;
}

/** Registration entry pairing a Zod schema with a handler function. */
interface CommandHandlerEntry<T = unknown> {
  readonly schema: z.ZodType<T>;
  readonly handler: (params: T) => Promise<unknown>;
}

/**
 * Routes incoming {@link CommandRequest} messages to registered handlers.
 *
 * Each handler is registered with a Zod schema for parameter validation.
 * The router validates the incoming parameters against the schema before
 * dispatching to the handler, and wraps the result in a structured
 * {@link CommandResponse}.
 */
export class CommandRouter {
  private readonly handlers = new Map<string, CommandHandlerEntry>();
  private initialized = false;

  constructor(private readonly browserScope?: BrowserCommandScope) {}

  /**
   * Registers a handler for a specific command name.
   *
   * @param command - The command name to handle.
   * @param schema - Zod schema for validating the command parameters.
   * @param handler - Async function that processes the validated parameters.
   */
  registerHandler<T>(
    command: CommandName,
    schema: z.ZodType<T>,
    handler: (params: T) => Promise<unknown>,
  ): void {
    if (this.handlers.has(command)) {
      logger.warn('Overwriting existing handler', { command });
    }

    this.handlers.set(command, {
      schema,
      handler: handler as (params: unknown) => Promise<unknown>,
    });

    logger.debug('Handler registered', { command });
  }

  /**
   * Initializes the command router.
   *
   * Call after all handlers are registered. Logs the number of
   * registered handlers and marks the router as ready.
   */
  init(): void {
    this.initialized = true;
    logger.info('CommandRouter initialized', {
      handlerCount: this.handlers.size,
    });
  }

  /**
   * Routes a command request to the appropriate handler.
   *
   * Validates the request envelope, looks up the handler by command name,
   * validates the parameters against the handler's Zod schema, executes
   * the handler, and returns a structured {@link CommandResponse}.
   *
   * @param request - The untrusted incoming command request.
   * @returns A structured response with success/error status and metadata.
   */
  async route(request: unknown): Promise<CommandResponse> {
    const startTime = performance.now();
    const envelopeResult = CommandRequestSchema.safeParse(request);

    if (!envelopeResult.success) {
      const requestId =
        typeof request === 'object' &&
        request !== null &&
        'id' in request &&
        typeof request.id === 'string'
          ? request.id
          : 'unknown';
      return this.buildErrorResponse(
        requestId,
        INVALID_PARAMS,
        'Invalid command request envelope',
        envelopeResult.error.issues,
        startTime,
      );
    }

    const validatedRequest = envelopeResult.data;
    logger.debug('Routing command', {
      id: validatedRequest.id,
      command: validatedRequest.command,
    });
    const entry = this.handlers.get(validatedRequest.command);

    if (!entry) {
      return this.buildErrorResponse(
        validatedRequest.id,
        UNKNOWN_COMMAND,
        `No handler registered for command: ${validatedRequest.command}`,
        undefined,
        startTime,
        validatedRequest.context,
      );
    }

    const paramResult = entry.schema.safeParse(validatedRequest.params);

    if (!paramResult.success) {
      return this.buildErrorResponse(
        validatedRequest.id,
        INVALID_PARAMS,
        'Command parameter validation failed',
        paramResult.error.issues,
        startTime,
        validatedRequest.context,
      );
    }

    try {
      const execution: ScopedCommandResult<unknown> = this.browserScope
        ? await this.browserScope.run(validatedRequest, (params) =>
            entry.handler(params ?? paramResult.data),
          )
        : { data: await entry.handler(paramResult.data) };
      return this.buildSuccessResponse(
        validatedRequest.id,
        execution.data,
        startTime,
        validatedRequest.context,
        execution,
      );
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      const code = err instanceof BrowserSessionScopeError ? err.code : INTERNAL_ERROR;
      logger.error('Handler execution failed', {
        command: validatedRequest.command,
        error: message,
      });

      return this.buildErrorResponse(
        validatedRequest.id,
        code,
        message,
        undefined,
        startTime,
        validatedRequest.context,
      );
    }
  }

  /** Returns whether the router has been initialized. */
  isInitialized(): boolean {
    return this.initialized;
  }

  /** Returns the number of registered handlers. */
  handlerCount(): number {
    return this.handlers.size;
  }

  /**
   * Executes an array of commands sequentially with per-step results.
   *
   * @param commands - Ordered list of commands to execute.
   * @param options - Execution mode, optional timeout, and checkpoint ID.
   * @returns Aggregate result with per-step responses and completion status.
   */
  async executeBatch(commands: BatchCommand[], options: BatchOptions): Promise<BatchResult> {
    const startTime = performance.now();
    const checkpointId = options.checkpointId ?? crypto.randomUUID();
    const steps: BatchStepResult[] = [];
    let completed = true;

    logger.debug('Batch execution started', {
      checkpointId,
      commandCount: commands.length,
      mode: options.mode,
    });

    const deadline =
      options.timeoutMs !== undefined ? performance.now() + options.timeoutMs : undefined;

    for (let i = 0; i < commands.length; i++) {
      if (deadline !== undefined && performance.now() >= deadline) {
        logger.warn('Batch timeout exceeded', { checkpointId, stepsCompleted: i });
        completed = false;
        break;
      }

      const batchCmd = commands[i]!;
      const request: CommandRequest = {
        id: `${checkpointId}:${i}`,
        command: batchCmd.command,
        params: batchCmd.params ?? {},
        timestamp: Date.now(),
        context: options.context,
      };

      const response = await this.route(request);

      steps.push({ stepIndex: i, command: batchCmd.command, response });

      await checkpointManager.saveCheckpoint(
        checkpointId,
        i,
        steps.map((s) => this.toStepResult(s)),
        { taskName: 'batch' },
      );

      if (!response.success && options.mode === 'strict') {
        logger.debug('Strict mode: halting batch on step failure', {
          checkpointId,
          failedStep: i,
        });
        completed = false;
        break;
      }
    }

    const totalDuration = performance.now() - startTime;

    logger.debug('Batch execution finished', {
      checkpointId,
      completed,
      stepsExecuted: steps.length,
      totalDuration,
    });

    return { checkpointId, completed, steps, totalDuration };
  }

  /**
   * Resumes a previously checkpointed batch execution, skipping
   * steps that were already completed successfully.
   *
   * @param checkpointId - ID of the checkpoint to resume from.
   * @param commands - The full ordered list of commands in the batch.
   * @param options - Execution mode and optional timeout.
   * @returns Aggregate result including both prior and newly executed steps.
   */
  async resumeBatch(
    checkpointId: string,
    commands: BatchCommand[],
    options: Omit<BatchOptions, 'checkpointId'>,
  ): Promise<BatchResult> {
    const startTime = performance.now();
    const previousResults = await checkpointManager.resumeFromCheckpoint(checkpointId);

    const completedIndices = new Set(
      previousResults.filter((r) => r.status === 'success').map((r) => r.stepIndex),
    );

    const steps: BatchStepResult[] = [];
    let completed = true;

    logger.debug('Batch resume started', {
      checkpointId,
      commandCount: commands.length,
      skipping: completedIndices.size,
    });

    const deadline =
      options.timeoutMs !== undefined ? performance.now() + options.timeoutMs : undefined;

    for (let i = 0; i < commands.length; i++) {
      if (completedIndices.has(i)) {
        const prior = previousResults.find((r) => r.stepIndex === i)!;
        steps.push({
          stepIndex: i,
          command: commands[i]!.command,
          response: {
            id: `${checkpointId}:${i}`,
            success: true,
            data: prior.data,
            metadata: {
              duration: 0,
              timestamp: prior.timestamp,
              context: options.context,
            },
          },
        });
        continue;
      }

      if (deadline !== undefined && performance.now() >= deadline) {
        logger.warn('Batch resume timeout exceeded', {
          checkpointId,
          stepsCompleted: steps.length,
        });
        completed = false;
        break;
      }

      const batchCmd = commands[i]!;
      const request: CommandRequest = {
        id: `${checkpointId}:${i}`,
        command: batchCmd.command,
        params: batchCmd.params ?? {},
        timestamp: Date.now(),
        context: options.context,
      };

      const response = await this.route(request);

      steps.push({ stepIndex: i, command: batchCmd.command, response });

      await checkpointManager.saveCheckpoint(
        checkpointId,
        i,
        steps.map((s) => this.toStepResult(s)),
        { taskName: 'batch' },
      );

      if (!response.success && options.mode === 'strict') {
        logger.debug('Strict mode: halting resumed batch on step failure', {
          checkpointId,
          failedStep: i,
        });
        completed = false;
        break;
      }
    }

    const totalDuration = performance.now() - startTime;

    logger.debug('Batch resume finished', {
      checkpointId,
      completed,
      stepsExecuted: steps.length,
      totalDuration,
    });

    return { checkpointId, completed, steps, totalDuration };
  }

  /** Converts a BatchStepResult to a StepResult for checkpoint persistence. */
  private toStepResult(step: BatchStepResult): StepResult {
    return {
      stepIndex: step.stepIndex,
      status: step.response.success ? 'success' : 'failure',
      data: step.response.success ? step.response.data : undefined,
      error: step.response.success ? undefined : step.response.error?.message,
      timestamp: step.response.metadata?.timestamp ?? Date.now(),
    };
  }

  private buildMetadata(
    startTime: number,
    commandId?: string,
    context?: BrowserRequestContext,
    execution?: Pick<
      ScopedCommandResult<unknown>,
      'activeTabId' | 'ownedTabIds' | 'browserContextId' | 'windowId'
    >,
  ): CommandResponseMetadata {
    return {
      duration: performance.now() - startTime,
      timestamp: Date.now(),
      commandId,
      context,
      activeTabId: execution?.activeTabId,
      ownedTabIds: execution?.ownedTabIds,
      browserContextId: execution?.browserContextId,
      windowId: execution?.windowId,
    };
  }

  private buildSuccessResponse(
    id: string,
    data: unknown,
    startTime: number,
    context?: BrowserRequestContext,
    execution?: Pick<
      ScopedCommandResult<unknown>,
      'activeTabId' | 'ownedTabIds' | 'browserContextId' | 'windowId'
    >,
  ): CommandResponse {
    return {
      id,
      success: true,
      data,
      metadata: this.buildMetadata(startTime, id, context, execution),
    };
  }

  private buildErrorResponse(
    id: string,
    code: string,
    message: string,
    details: unknown,
    startTime: number,
    context?: BrowserRequestContext,
  ): CommandResponse {
    const error: CommandResponseError =
      details !== undefined ? { code, message, details } : { code, message };

    return {
      id,
      success: false,
      error,
      metadata: this.buildMetadata(startTime, id, context),
    };
  }
}
