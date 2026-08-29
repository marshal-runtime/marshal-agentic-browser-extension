/**
 * Modify-CSS tool handler.
 *
 * Routes setStyle, addClass, removeClass, injectStylesheet,
 * undoLastCSS, and revertAllCSS actions to the browser adapter,
 * which delegates to the content script UI modification module
 * via the message bridge.
 */

import type { IBrowserAdapter } from '@agentic-browser/shared';
import { ModifyCSSParamsSchema, UndoRevertParamsSchema } from '@agentic-browser/shared';

/** Response data returned by the modifyCSS handler. */
export interface ModifyCSSResponseData {
  readonly action: string;
  readonly selector?: string;
  readonly success: boolean;
  readonly data?: unknown;
}

/** Response data returned by the undo/revert CSS handler. */
export interface UndoRevertCSSResponseData {
  readonly action: string;
  readonly success: boolean;
  readonly data?: unknown;
}

/**
 * Creates a modifyCSS command handler bound to the given browser adapter.
 *
 * The returned function validates raw params with Zod, routes to the
 * appropriate adapter method based on the `action` field, and returns
 * a structured response confirming the action.
 */
export function createModifyCSSHandler(adapter: IBrowserAdapter) {
  return async (params: unknown): Promise<ModifyCSSResponseData> => {
    const parsed = ModifyCSSParamsSchema.safeParse(params);

    if (!parsed.success) {
      throw new Error(
        `Invalid modifyCSS params: ${parsed.error.issues.map((i) => i.message).join(', ')}`,
      );
    }

    const { action } = parsed.data;

    switch (action) {
      case 'setStyle': {
        const selector = parsed.data.selector;
        const styles = parsed.data.styles;
        if (!selector) {
          throw new Error('setStyle action requires "selector" parameter');
        }
        if (!styles || Object.keys(styles).length === 0) {
          throw new Error('setStyle action requires "styles" parameter');
        }
        const result = await adapter.modifyStyle({ selector, styles });
        if (!result.ok) {
          throw new Error(`[${result.error.code}] ${result.error.message}`);
        }
        return { action, selector, success: true };
      }

      case 'addClass': {
        const selector = parsed.data.selector;
        const className = parsed.data.className;
        if (!selector) {
          throw new Error('addClass action requires "selector" parameter');
        }
        if (!className) {
          throw new Error('addClass action requires "className" parameter');
        }
        const script = `document.querySelector(${JSON.stringify(selector)})?.classList.add(${JSON.stringify(className)})`;
        const result = await adapter.executeScript({ script });
        if (!result.ok) {
          throw new Error(`[${result.error.code}] ${result.error.message}`);
        }
        return { action, selector, success: true };
      }

      case 'removeClass': {
        const selector = parsed.data.selector;
        const className = parsed.data.className;
        if (!selector) {
          throw new Error('removeClass action requires "selector" parameter');
        }
        if (!className) {
          throw new Error('removeClass action requires "className" parameter');
        }
        const script = `document.querySelector(${JSON.stringify(selector)})?.classList.remove(${JSON.stringify(className)})`;
        const result = await adapter.executeScript({ script });
        if (!result.ok) {
          throw new Error(`[${result.error.code}] ${result.error.message}`);
        }
        return { action, selector, success: true };
      }

      case 'injectStylesheet': {
        const css = parsed.data.css;
        if (!css) {
          throw new Error('injectStylesheet action requires "css" parameter');
        }
        const result = await adapter.addStyleSheet({ css });
        if (!result.ok) {
          throw new Error(`[${result.error.code}] ${result.error.message}`);
        }
        return { action, success: true, data: { styleId: result.value } };
      }
    }
  };
}

/**
 * Creates an undoModification command handler for CSS modifications.
 *
 * Delegates undo/revert operations to the content script via executeScript.
 */
export function createUndoCSSHandler(adapter: IBrowserAdapter) {
  return async (params: unknown): Promise<UndoRevertCSSResponseData> => {
    const parsed = UndoRevertParamsSchema.safeParse(params);

    if (!parsed.success) {
      throw new Error(
        `Invalid undo/revert params: ${parsed.error.issues.map((i) => i.message).join(', ')}`,
      );
    }

    const { action } = parsed.data;

    switch (action) {
      case 'undoLastCSS': {
        const script = `
          if (typeof window.__agenticUndoLastModification === 'function') {
            return window.__agenticUndoLastModification('css');
          }
          return { undone: false, reason: 'Undo not available' };
        `;
        const result = await adapter.executeScript({ script });
        if (!result.ok) {
          throw new Error(`[${result.error.code}] ${result.error.message}`);
        }
        return { action, success: true, data: result.value };
      }

      case 'revertAllCSS': {
        const script = `
          if (typeof window.__agenticRevertAllModifications === 'function') {
            return window.__agenticRevertAllModifications('css');
          }
          return { reverted: 0 };
        `;
        const result = await adapter.executeScript({ script });
        if (!result.ok) {
          throw new Error(`[${result.error.code}] ${result.error.message}`);
        }
        return { action, success: true, data: result.value };
      }

      default:
        throw new Error(`Unsupported CSS undo/revert action: ${action}`);
    }
  };
}
