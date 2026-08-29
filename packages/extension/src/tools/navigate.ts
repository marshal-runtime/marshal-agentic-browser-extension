/**
 * Navigate tool handler.
 *
 * Validates incoming parameters via {@link NavigateParamsSchema}, delegates
 * to {@link IBrowserAdapter.navigate}, and returns the final URL, title,
 * and HTTP status on success.
 */

import type { IBrowserAdapter, NavigateResponseData } from '@agentic-browser/shared';
import { NavigateParamsSchema, ErrorCode, DEFAULT_NAVIGATION_TIMEOUT } from '@agentic-browser/shared';

/**
 * Creates a navigate command handler bound to the given browser adapter.
 *
 * The returned function validates raw params with Zod, calls
 * `adapter.navigate()`, and enriches the result with the page title.
 */
export function createNavigateHandler(adapter: IBrowserAdapter) {
  return async (params: unknown): Promise<NavigateResponseData> => {
    const parsed = NavigateParamsSchema.safeParse(params);

    if (!parsed.success) {
      throw new Error(`Invalid navigate params: ${parsed.error.issues.map((i) => i.message).join(', ')}`);
    }

    const { url, waitUntil, timeout } = parsed.data;

    const result = await adapter.navigate({
      url,
      waitUntil: waitUntil ?? 'load',
      timeout: timeout ?? DEFAULT_NAVIGATION_TIMEOUT,
    });

    if (!result.ok) {
      const error = result.error;
      throw new Error(`[${error.code}] ${error.message}`);
    }

    const finalUrl = result.value;

    const tabResult = await adapter.getActiveTab();
    const title = tabResult.ok ? tabResult.value.title : '';

    return {
      url: finalUrl,
      title,
      status: 200,
    };
  };
}
