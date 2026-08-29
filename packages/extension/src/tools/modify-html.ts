/**
 * Modify-HTML tool handler.
 *
 * Routes modifyText, addElement, removeElement, modifyAttribute,
 * undoLastHTML, and revertAllHTML actions to the browser adapter,
 * which delegates to the content script UI modification module
 * via the message bridge.
 */

import type { IBrowserAdapter } from '@agentic-browser/shared';
import { ModifyHTMLParamsSchema, UndoRevertParamsSchema } from '@agentic-browser/shared';

/** Response data returned by the modifyHTML handler. */
export interface ModifyHTMLResponseData {
  readonly action: string;
  readonly selector: string;
  readonly success: boolean;
}

/** Response data returned by the undo/revert HTML handler. */
export interface UndoRevertHTMLResponseData {
  readonly action: string;
  readonly success: boolean;
  readonly data?: unknown;
}

/**
 * Creates a modifyHTML command handler bound to the given browser adapter.
 *
 * The returned function validates raw params with Zod, routes to the
 * appropriate adapter method based on the `action` field, and returns
 * a structured response confirming the action.
 */
export function createModifyHTMLHandler(adapter: IBrowserAdapter) {
  return async (params: unknown): Promise<ModifyHTMLResponseData> => {
    const parsed = ModifyHTMLParamsSchema.safeParse(params);

    if (!parsed.success) {
      throw new Error(
        `Invalid modifyHTML params: ${parsed.error.issues.map((i) => i.message).join(', ')}`,
      );
    }

    const { action, selector } = parsed.data;

    switch (action) {
      case 'modifyText': {
        const text = parsed.data.text;
        if (text === undefined) {
          throw new Error('modifyText action requires "text" parameter');
        }
        const result = await adapter.setInnerHtml({ selector, html: text });
        if (!result.ok) {
          throw new Error(`[${result.error.code}] ${result.error.message}`);
        }
        return { action, selector, success: true };
      }

      case 'addElement': {
        const html = parsed.data.html;
        const position = parsed.data.position ?? 'beforeend';
        if (html === undefined) {
          throw new Error('addElement action requires "html" parameter');
        }
        const result = await adapter.insertAdjacentHtml({ selector, position, html });
        if (!result.ok) {
          throw new Error(`[${result.error.code}] ${result.error.message}`);
        }
        return { action, selector, success: true };
      }

      case 'removeElement': {
        const result = await adapter.setOuterHtml({ selector, html: '' });
        if (!result.ok) {
          throw new Error(`[${result.error.code}] ${result.error.message}`);
        }
        return { action, selector, success: true };
      }

      case 'modifyAttribute': {
        const attribute = parsed.data.attribute;
        const value = parsed.data.value;
        if (attribute === undefined) {
          throw new Error('modifyAttribute action requires "attribute" parameter');
        }
        const script = value === null
          ? `document.querySelector(${JSON.stringify(selector)})?.removeAttribute(${JSON.stringify(attribute)})`
          : `document.querySelector(${JSON.stringify(selector)})?.setAttribute(${JSON.stringify(attribute)}, ${JSON.stringify(value ?? '')})`;
        const result = await adapter.executeScript({ script });
        if (!result.ok) {
          throw new Error(`[${result.error.code}] ${result.error.message}`);
        }
        return { action, selector, success: true };
      }
    }
  };
}

/**
 * Creates an undoModification command handler for HTML modifications.
 *
 * Delegates undo/revert operations to the content script via executeScript.
 */
export function createUndoHTMLHandler(adapter: IBrowserAdapter) {
  return async (params: unknown): Promise<UndoRevertHTMLResponseData> => {
    const parsed = UndoRevertParamsSchema.safeParse(params);

    if (!parsed.success) {
      throw new Error(
        `Invalid undo/revert params: ${parsed.error.issues.map((i) => i.message).join(', ')}`,
      );
    }

    const { action } = parsed.data;

    switch (action) {
      case 'undoLastHTML': {
        const script = `
          if (typeof window.__agenticUndoLastModification === 'function') {
            return window.__agenticUndoLastModification('html');
          }
          return { undone: false, reason: 'Undo not available' };
        `;
        const result = await adapter.executeScript({ script });
        if (!result.ok) {
          throw new Error(`[${result.error.code}] ${result.error.message}`);
        }
        return { action, success: true, data: result.value };
      }

      case 'revertAllHTML': {
        const script = `
          if (typeof window.__agenticRevertAllModifications === 'function') {
            return window.__agenticRevertAllModifications('html');
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
        throw new Error(`Unsupported HTML undo/revert action: ${action}`);
    }
  };
}
