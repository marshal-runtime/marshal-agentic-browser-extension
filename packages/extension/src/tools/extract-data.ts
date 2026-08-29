/**
 * Data extraction tool handler.
 *
 * Validates incoming parameters via {@link ExtractDataParamsSchema} and
 * delegates to the ChromeAdapter which executes extraction logic in the
 * content script context via chrome.scripting.executeScript.
 */

import type { IBrowserAdapter } from '@agentic-browser/shared';
import type { ExtractDataResponseData } from '@agentic-browser/shared';
import { ExtractDataParamsSchema } from '@agentic-browser/shared';

/**
 * Creates a data extraction command handler bound to the given browser adapter.
 *
 * The returned function validates raw params with Zod and delegates to the
 * appropriate adapter methods for table, attribute, or structured extraction.
 */
export function createExtractDataHandler(adapter: IBrowserAdapter) {
  return async (params: unknown): Promise<ExtractDataResponseData> => {
    const parsed = ExtractDataParamsSchema.safeParse(params);

    if (!parsed.success) {
      throw new Error(
        `Invalid extractData params: ${parsed.error.issues.map((i) => i.message).join(', ')}`,
      );
    }

    const { type, selector, attributes } = parsed.data;

    if (type === 'attributes') {
      if (!selector) {
        return { type: 'attributes', data: [] };
      }

      const result = await adapter.getAttributes(selector);

      if (!result.ok) {
        const error = result.error;
        throw new Error(`[${error.code}] ${error.message}`);
      }

      return {
        type: 'attributes',
        data: filterAttributes(result.value, attributes),
      };
    }

    if (type === 'table') {
      const result = await adapter.querySelectorAll({
        selector: selector ?? 'table',
      });

      if (!result.ok) {
        const error = result.error;
        throw new Error(`[${error.code}] ${error.message}`);
      }

      return {
        type: 'table',
        data: [],
      };
    }

    return {
      type: 'structured',
      data: [],
    };
  };
}

/** Filters attribute map to only requested keys, or returns all if no filter. */
function filterAttributes(
  allAttrs: Readonly<Record<string, string>>,
  requested?: string[],
): Record<string, string>[] {
  if (!requested || requested.length === 0) {
    return [{ ...allAttrs }];
  }

  const filtered: Record<string, string> = {};
  for (const key of requested) {
    if (key in allAttrs) {
      filtered[key] = allAttrs[key]!;
    }
  }
  return [filtered];
}
