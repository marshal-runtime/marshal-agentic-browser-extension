/**
 * HTML retrieval tool handler.
 *
 * Validates incoming parameters via {@link GetHTMLParamsSchema}, delegates
 * to {@link IBrowserAdapter.getPageContent} or
 * {@link IBrowserAdapter.getOuterHtml}, and returns the HTML content
 * with metadata.
 */

import type { IBrowserAdapter } from '@agentic-browser/shared';
import type { HTMLResponseData } from '@agentic-browser/shared';
import { GetHTMLParamsSchema } from '@agentic-browser/shared';

/**
 * Creates an HTML retrieval command handler bound to the given browser adapter.
 *
 * The returned function validates raw params with Zod, calls the appropriate
 * adapter method based on whether a selector is provided, and returns the result.
 */
export function createGetHTMLHandler(adapter: IBrowserAdapter) {
  return async (params: unknown): Promise<HTMLResponseData> => {
    const parsed = GetHTMLParamsSchema.safeParse(params);

    if (!parsed.success) {
      throw new Error(
        `Invalid getHTML params: ${parsed.error.issues.map((i) => i.message).join(', ')}`,
      );
    }

    const { selector } = parsed.data;

    if (selector) {
      const result = await adapter.getOuterHtml(selector);

      if (!result.ok) {
        const error = result.error;
        throw new Error(`[${error.code}] ${error.message}`);
      }

      return {
        html: result.value,
        selector,
        length: result.value.length,
      };
    }

    const result = await adapter.getPageContent();

    if (!result.ok) {
      const error = result.error;
      throw new Error(`[${error.code}] ${error.message}`);
    }

    return {
      html: result.value,
      length: result.value.length,
    };
  };
}
