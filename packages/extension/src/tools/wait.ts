/**
 * Wait tool handler.
 *
 * Provides waitForElement, waitForNavigation, waitForNetworkIdle, and
 * waitForCondition commands. Element waits delegate to the browser adapter
 * which uses MutationObserver in the content script. Network idle detection
 * uses CDP network events via the adapter's sendCdpCommand.
 */

import type { IBrowserAdapter } from '@agentic-browser/shared';
import {
  WaitForSelectorParamsSchema,
  WaitForNavigationParamsSchema,
  WaitForNetworkIdleParamsSchema,
  WaitForConditionParamsSchema,
  ErrorCode,
  DEFAULT_WAIT_TIMEOUT,
  DEFAULT_POLLING_INTERVAL,
} from '@agentic-browser/shared';

/** Response data for wait operations. */
export interface WaitResponseData {
  readonly success: boolean;
  readonly url?: string;
}

const DEFAULT_NETWORK_IDLE_THRESHOLD = 500;

/** Creates a waitForElement command handler bound to the given browser adapter. */
export function createWaitForElementHandler(adapter: IBrowserAdapter) {
  return async (params: unknown): Promise<WaitResponseData> => {
    const parsed = WaitForSelectorParamsSchema.safeParse(params);

    if (!parsed.success) {
      throw new Error(
        `Invalid waitForElement params: ${parsed.error.issues.map((i) => i.message).join(', ')}`,
      );
    }

    const { selector, condition, timeout } = parsed.data;
    const effectiveTimeout = timeout ?? DEFAULT_WAIT_TIMEOUT;

    const result = await adapter.waitForSelector({
      selector,
      visible: condition === 'visible' ? true : undefined,
      hidden: condition === 'hidden' ? true : undefined,
      timeout: effectiveTimeout,
    });

    if (!result.ok) {
      throw new Error(`[${result.error.code}] ${result.error.message}`);
    }

    return { success: true };
  };
}

/** Creates a waitForNavigation command handler bound to the given browser adapter. */
export function createWaitForNavigationHandler(adapter: IBrowserAdapter) {
  return async (params: unknown): Promise<WaitResponseData> => {
    const parsed = WaitForNavigationParamsSchema.safeParse(params);

    if (!parsed.success) {
      throw new Error(
        `Invalid waitForNavigation params: ${parsed.error.issues.map((i) => i.message).join(', ')}`,
      );
    }

    const { waitUntil, timeout } = parsed.data;
    const effectiveTimeout = timeout ?? DEFAULT_WAIT_TIMEOUT;

    const result = await adapter.waitForNavigation({
      waitUntil: waitUntil ?? 'load',
      timeout: effectiveTimeout,
    });

    if (!result.ok) {
      throw new Error(`[${result.error.code}] ${result.error.message}`);
    }

    return { success: true, url: result.value };
  };
}

/** Creates a waitForNetworkIdle command handler bound to the given browser adapter. */
export function createWaitForNetworkIdleHandler(adapter: IBrowserAdapter) {
  return async (params: unknown): Promise<WaitResponseData> => {
    const parsed = WaitForNetworkIdleParamsSchema.safeParse(params);

    if (!parsed.success) {
      throw new Error(
        `Invalid waitForNetworkIdle params: ${parsed.error.issues.map((i) => i.message).join(', ')}`,
      );
    }

    const { idleThreshold, timeout } = parsed.data;
    const effectiveTimeout = timeout ?? DEFAULT_WAIT_TIMEOUT;
    const threshold = idleThreshold ?? DEFAULT_NETWORK_IDLE_THRESHOLD;

    const deadline = Date.now() + effectiveTimeout;
    let inFlightCount = 0;
    let lastActivityTime = Date.now();

    const enableResult = await adapter.sendCdpCommand({ method: 'Network.enable' });

    if (!enableResult.ok) {
      throw new Error(`[${enableResult.error.code}] ${enableResult.error.message}`);
    }

    try {
      await new Promise<void>((resolve, reject) => {
        const checkIdle = (): void => {
          const now = Date.now();

          if (now > deadline) {
            reject(new Error(`[${ErrorCode.TIMEOUT}] waitForNetworkIdle timed out after ${effectiveTimeout}ms`));
            return;
          }

          if (inFlightCount === 0 && now - lastActivityTime >= threshold) {
            resolve();
            return;
          }

          setTimeout(checkIdle, Math.min(100, threshold));
        };

        const pollNetworkState = async (): Promise<void> => {
          while (Date.now() < deadline) {
            if (inFlightCount === 0 && Date.now() - lastActivityTime >= threshold) {
              return;
            }

            const metricsResult = await adapter.sendCdpCommand({
              method: 'Runtime.evaluate',
              params: {
                expression: 'performance.getEntriesByType("resource").filter(e => !e.responseEnd).length',
                returnByValue: true,
              },
            });

            if (metricsResult.ok) {
              const value = (metricsResult.value as { result?: { value?: number } }).result?.value ?? 0;
              const previousCount = inFlightCount;
              inFlightCount = value;

              if (value > 0 || previousCount > 0) {
                lastActivityTime = Date.now();
              }
            }

            await sleep(Math.min(100, threshold));
          }
        };

        pollNetworkState().then(() => {
          checkIdle();
        }).catch(reject);
      });
    } finally {
      await adapter.sendCdpCommand({ method: 'Network.disable' });
    }

    return { success: true };
  };
}

/** Creates a waitForCondition command handler bound to the given browser adapter. */
export function createWaitForConditionHandler(adapter: IBrowserAdapter) {
  return async (params: unknown): Promise<WaitResponseData> => {
    const parsed = WaitForConditionParamsSchema.safeParse(params);

    if (!parsed.success) {
      throw new Error(
        `Invalid waitForCondition params: ${parsed.error.issues.map((i) => i.message).join(', ')}`,
      );
    }

    const { expression, pollingInterval, timeout } = parsed.data;
    const effectiveTimeout = timeout ?? DEFAULT_WAIT_TIMEOUT;
    const interval = pollingInterval ?? DEFAULT_POLLING_INTERVAL;

    const result = await adapter.waitForCondition({
      expression,
      pollingInterval: interval,
      timeout: effectiveTimeout,
    });

    if (!result.ok) {
      throw new Error(`[${result.error.code}] ${result.error.message}`);
    }

    return { success: true };
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
