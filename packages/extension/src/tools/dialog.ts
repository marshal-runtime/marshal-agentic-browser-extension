/**
 * Dialog tool handler.
 *
 * Routes handleDialog and getDialogInfo commands to the browser adapter's
 * dialog management methods. Uses CDP {@link Page.javascriptDialogOpening}
 * for detection and {@link Page.handleJavaScriptDialog} for response.
 */

import type { IBrowserAdapter } from '@agentic-browser/shared';
import type { DialogResponseData } from '@agentic-browser/shared';
import { HandleDialogParamsSchema, GetDialogInfoParamsSchema } from '@agentic-browser/shared';

/**
 * Creates a handleDialog command handler bound to the given browser adapter.
 *
 * Validates raw params with Zod, calls `adapter.handleDialog()`, then
 * returns current dialog info including type and message.
 */
export function createHandleDialogHandler(adapter: IBrowserAdapter) {
  return async (params: unknown): Promise<DialogResponseData> => {
    const parsed = HandleDialogParamsSchema.safeParse(params);

    if (!parsed.success) {
      throw new Error(
        `Invalid handleDialog params: ${parsed.error.issues.map((i) => i.message).join(', ')}`,
      );
    }

    const dialogResult = await adapter.getDialogInfo();

    if (!dialogResult.ok) {
      throw new Error(`[${dialogResult.error.code}] ${dialogResult.error.message}`);
    }

    const dialogInfo = dialogResult.value;
    const dialogType = dialogInfo?.type ?? 'alert';
    const dialogMessage = dialogInfo?.message ?? '';
    const defaultPrompt = dialogInfo?.defaultPrompt;

    const result = await adapter.handleDialog({
      accept: parsed.data.action === 'accept',
      promptText: parsed.data.promptText,
    });

    if (!result.ok) {
      throw new Error(`[${result.error.code}] ${result.error.message}`);
    }

    return {
      dialogType,
      message: dialogMessage,
      defaultPrompt,
      handled: true,
    };
  };
}

/**
 * Creates a getDialogInfo command handler bound to the given browser adapter.
 *
 * Returns information about the currently open dialog, or indicates no
 * dialog is present.
 */
export function createGetDialogInfoHandler(adapter: IBrowserAdapter) {
  return async (params: unknown): Promise<DialogResponseData> => {
    const parsed = GetDialogInfoParamsSchema.safeParse(params);

    if (!parsed.success) {
      throw new Error(
        `Invalid getDialogInfo params: ${parsed.error.issues.map((i) => i.message).join(', ')}`,
      );
    }

    const result = await adapter.getDialogInfo();

    if (!result.ok) {
      throw new Error(`[${result.error.code}] ${result.error.message}`);
    }

    const dialogInfo = result.value;

    if (!dialogInfo) {
      return {
        dialogType: 'alert',
        message: '',
        handled: false,
      };
    }

    return {
      dialogType: dialogInfo.type,
      message: dialogInfo.message,
      defaultPrompt: dialogInfo.defaultPrompt,
      handled: false,
    };
  };
}
