/**
 * Navigation history tool handler.
 *
 * Validates incoming parameters via {@link HistoryParamsSchema},
 * delegates to {@link IBrowserAdapter.goBack}, {@link IBrowserAdapter.goForward},
 * and {@link IBrowserAdapter.reload}.
 */

import type { IBrowserAdapter } from '@agentic-browser/shared';
import { HistoryParamsSchema } from '@agentic-browser/shared';

/** Response shape returned by the history handler. */
interface HistoryResult {
  readonly success: boolean;
  readonly action: string;
  readonly url?: string;
  readonly message?: string;
}

/**
 * Creates a navigation history handler bound to the given browser adapter.
 *
 * The returned function validates raw params with Zod and dispatches
 * to the appropriate history operation based on the action.
 */
export function createHistoryHandler(adapter: IBrowserAdapter) {
  return async (params: unknown): Promise<HistoryResult> => {
    const parsed = HistoryParamsSchema.safeParse(params);

    if (!parsed.success) {
      throw new Error(
        `Invalid history params: ${parsed.error.issues.map((i: { message: string }) => i.message).join(', ')}`,
      );
    }

    const { action } = parsed.data;

    switch (action) {
      case 'goBack':
        return goBack(adapter);
      case 'goForward':
        return goForward(adapter);
      case 'reload':
        return reloadPage(adapter, parsed.data.hard);
      default:
        throw new Error(`Unknown history action: ${action as string}`);
    }
  };
}

async function goBack(adapter: IBrowserAdapter): Promise<HistoryResult> {
  const result = await adapter.goBack();

  if (!result.ok) {
    throw new Error(`[${result.error.code}] ${result.error.message}`);
  }

  return {
    success: true,
    action: 'goBack',
    url: result.value,
  };
}

async function goForward(adapter: IBrowserAdapter): Promise<HistoryResult> {
  const result = await adapter.goForward();

  if (!result.ok) {
    throw new Error(`[${result.error.code}] ${result.error.message}`);
  }

  return {
    success: true,
    action: 'goForward',
    url: result.value,
  };
}

async function reloadPage(
  adapter: IBrowserAdapter,
  hard?: boolean,
): Promise<HistoryResult> {
  const result = await adapter.reload(hard);

  if (!result.ok) {
    throw new Error(`[${result.error.code}] ${result.error.message}`);
  }

  return {
    success: true,
    action: 'reload',
    url: result.value,
    message: hard ? 'Hard reload completed' : 'Soft reload completed',
  };
}

export type { HistoryResult };
