/**
 * Screenshot tool handler.
 *
 * Validates incoming parameters via {@link ScreenshotParamsSchema}, delegates
 * to {@link IBrowserAdapter.captureScreenshot} or
 * {@link IBrowserAdapter.captureFullPageScreenshot}, and returns the
 * base64-encoded image data with metadata.
 */

import type { IBrowserAdapter, ScreenshotResult } from '@agentic-browser/shared';
import { ScreenshotParamsSchema, ErrorCode } from '@agentic-browser/shared';

/**
 * Creates a screenshot command handler bound to the given browser adapter.
 *
 * The returned function validates raw params with Zod, calls the appropriate
 * adapter screenshot method based on the `fullPage` flag or `selector`, and returns the result.
 */
export function createScreenshotHandler(adapter: IBrowserAdapter) {
  return async (params: unknown): Promise<ScreenshotResult> => {
    const parsed = ScreenshotParamsSchema.safeParse(params);

    if (!parsed.success) {
      throw new Error(`Invalid screenshot params: ${parsed.error.issues.map((i) => i.message).join(', ')}`);
    }

    const { fullPage, format, quality, selector } = parsed.data;

    if (selector) {
      const result = await adapter.captureScreenshot({ selector, format, quality });

      if (!result.ok) {
        const error = result.error;
        throw new Error(`[${error.code}] ${error.message}`);
      }

      return result.value;
    }

    const result = fullPage
      ? await adapter.captureFullPageScreenshot({ format, quality })
      : await adapter.captureScreenshot({ format, quality, fullPage: false });

    if (!result.ok) {
      const error = result.error;
      throw new Error(`[${error.code}] ${error.message}`);
    }

    return result.value;
  };
}
