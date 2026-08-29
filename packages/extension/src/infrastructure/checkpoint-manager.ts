/**
 * Checkpoint manager for autonomous task state persistence.
 *
 * Saves step-level progress to `chrome.storage.local` with a 30-minute TTL
 * so that interrupted tasks can resume from the last completed step.
 */

import { Logger } from './logger.js';

const logger = Logger.getInstance();

/** Key prefix for checkpoint entries in chrome.storage.local. */
const CHECKPOINT_PREFIX = 'checkpoint:';

/** Default TTL in milliseconds (30 minutes). */
const DEFAULT_TTL_MS = 30 * 60 * 1000;

/** Diagnostic context attached to a checkpoint. */
export interface DiagnosticContext {
  readonly taskName?: string;
  readonly tabId?: number;
  readonly url?: string;
  readonly error?: string;
  [key: string]: unknown;
}

/** A single step result stored within a checkpoint. */
export interface StepResult {
  readonly stepIndex: number;
  readonly status: 'success' | 'failure' | 'skipped';
  readonly data?: unknown;
  readonly error?: string;
  readonly timestamp: number;
}

/** Serialised checkpoint data persisted to storage. */
export interface CheckpointData {
  readonly checkpointId: string;
  readonly stepIndex: number;
  readonly stepResults: StepResult[];
  readonly diagnosticContext: DiagnosticContext;
  readonly timestamp: number;
  readonly ttl: number;
}

/**
 * Manages task checkpoint persistence in `chrome.storage.local`.
 *
 * Provides save / retrieve / resume operations with automatic TTL-based
 * expiry and graceful handling of storage quota errors.
 */
class CheckpointManager {
  private static instance: CheckpointManager | undefined;

  private constructor() {}

  /** Returns the singleton CheckpointManager instance. */
  static getInstance(): CheckpointManager {
    if (!CheckpointManager.instance) {
      CheckpointManager.instance = new CheckpointManager();
    }
    return CheckpointManager.instance;
  }

  /**
   * Persists a checkpoint to `chrome.storage.local`.
   *
   * @param checkpointId - Unique identifier for the checkpoint.
   * @param stepIndex - Index of the current / last completed step.
   * @param stepResults - Array of results for all completed steps.
   * @param diagnosticContext - Contextual metadata for diagnostics.
   */
  async saveCheckpoint(
    checkpointId: string,
    stepIndex: number,
    stepResults: StepResult[],
    diagnosticContext: DiagnosticContext,
  ): Promise<void> {
    const data: CheckpointData = {
      checkpointId,
      stepIndex,
      stepResults,
      diagnosticContext,
      timestamp: Date.now(),
      ttl: DEFAULT_TTL_MS,
    };

    const storageKey = CHECKPOINT_PREFIX + checkpointId;

    try {
      await chrome.storage.local.set({ [storageKey]: data });
    } catch (error: unknown) {
      if (this.isQuotaError(error)) {
        logger.warn('Storage quota exceeded, evicting expired checkpoints', {
          checkpointId,
        });
        await this.evictExpired();

        try {
          await chrome.storage.local.set({ [storageKey]: data });
        } catch (retryError: unknown) {
          if (this.isQuotaError(retryError)) {
            logger.warn('Quota still exceeded, evicting oldest checkpoint', {
              checkpointId,
            });
            await this.evictOldest();
            await chrome.storage.local.set({ [storageKey]: data });
          } else {
            logger.error('Failed to save checkpoint after eviction', {
              checkpointId,
              error: String(retryError),
            });
          }
        }
      } else {
        logger.error('Failed to save checkpoint', {
          checkpointId,
          error: String(error),
        });
      }
    }
  }

  /**
   * Retrieves checkpoint data by ID.
   *
   * Returns `undefined` when the checkpoint does not exist or has expired.
   *
   * @param checkpointId - Identifier of the checkpoint to retrieve.
   */
  async getCheckpoint(checkpointId: string): Promise<CheckpointData | undefined> {
    const storageKey = CHECKPOINT_PREFIX + checkpointId;

    try {
      const result = await chrome.storage.local.get(storageKey);
      const data = result[storageKey] as CheckpointData | undefined;

      if (!data) {
        return undefined;
      }

      if (this.isExpired(data)) {
        await this.removeCheckpoint(storageKey);
        return undefined;
      }

      return data;
    } catch (error: unknown) {
      logger.warn('Failed to retrieve checkpoint', {
        checkpointId,
        error: String(error),
      });
      return undefined;
    }
  }

  /**
   * Returns all completed step results for a checkpoint, enabling task resume.
   *
   * @param checkpointId - Identifier of the checkpoint to resume from.
   * @returns The stored step results array, or an empty array when the
   *          checkpoint is missing or expired.
   */
  async resumeFromCheckpoint(checkpointId: string): Promise<StepResult[]> {
    const data = await this.getCheckpoint(checkpointId);

    if (!data) {
      return [];
    }

    return data.stepResults;
  }

  /**
   * Removes all expired checkpoints from storage.
   */
  async cleanup(): Promise<void> {
    await this.evictExpired();
  }

  /** Checks whether a checkpoint has exceeded its TTL. */
  private isExpired(data: CheckpointData): boolean {
    return Date.now() - data.timestamp > data.ttl;
  }

  /** Determines whether an error is a storage quota exceeded error. */
  private isQuotaError(error: unknown): boolean {
    if (error instanceof DOMException && error.name === 'QuotaExceededError') {
      return true;
    }
    const message = String(error).toLowerCase();
    return message.includes('quota') || message.includes('exceeded');
  }

  /** Removes expired checkpoint entries from `chrome.storage.local`. */
  private async evictExpired(): Promise<void> {
    const checkpoints = await this.getAllCheckpoints();
    const keysToRemove: string[] = [];

    for (const [key, data] of checkpoints) {
      if (this.isExpired(data)) {
        keysToRemove.push(key);
      }
    }

    if (keysToRemove.length > 0) {
      await this.removeCheckpoints(keysToRemove);
    }
  }

  /** Removes the oldest checkpoint to free storage space. */
  private async evictOldest(): Promise<void> {
    const checkpoints = await this.getAllCheckpoints();

    if (checkpoints.length === 0) {
      return;
    }

    checkpoints.sort(([, a], [, b]) => a.timestamp - b.timestamp);
    const oldest = checkpoints[0]!;
    await this.removeCheckpoint(oldest[0]);
  }

  /** Returns all checkpoint entries from `chrome.storage.local`. */
  private async getAllCheckpoints(): Promise<[string, CheckpointData][]> {
    try {
      const all = await chrome.storage.local.get(null);
      const entries: [string, CheckpointData][] = [];

      for (const [key, value] of Object.entries(all)) {
        if (key.startsWith(CHECKPOINT_PREFIX) && value && typeof value === 'object') {
          entries.push([key, value as CheckpointData]);
        }
      }

      return entries;
    } catch (error: unknown) {
      logger.warn('Failed to enumerate checkpoints', { error: String(error) });
      return [];
    }
  }

  /** Removes a single checkpoint entry by its storage key. */
  private async removeCheckpoint(storageKey: string): Promise<void> {
    try {
      await chrome.storage.local.remove(storageKey);
    } catch (error: unknown) {
      logger.warn('Failed to remove checkpoint', {
        storageKey,
        error: String(error),
      });
    }
  }

  /** Removes multiple checkpoint entries by storage key. */
  private async removeCheckpoints(storageKeys: string[]): Promise<void> {
    try {
      await chrome.storage.local.remove(storageKeys);
    } catch (error: unknown) {
      logger.warn('Failed to remove checkpoints', {
        count: storageKeys.length,
        error: String(error),
      });
    }
  }
}

/** Singleton checkpoint manager instance. */
const checkpointManager = CheckpointManager.getInstance();

export { CheckpointManager, checkpointManager };
