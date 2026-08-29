/**
 * File operations tool handler.
 *
 * Validates incoming parameters via {@link FileOpsParamsSchema},
 * delegates file upload to CDP DOM.setFileInputFiles via the adapter,
 * and download operations to the chrome.downloads API.
 */

import type { IBrowserAdapter } from '@agentic-browser/shared';
import { FileOpsParamsSchema, ErrorCode } from '@agentic-browser/shared';

/** Response shape returned by the file-ops handler. */
interface FileOpsResult {
  readonly success: boolean;
  readonly action: string;
  readonly data?: unknown;
  readonly message?: string;
}

/** Extended adapter with file operation methods. */
interface FileOpsAdapter extends IBrowserAdapter {
  setFileInput(
    tabId: number,
    selector: string,
    filePaths: readonly string[],
  ): Promise<{ ok: boolean; error?: { code: string; message: string } }>;
  getDownloadStatus(
    downloadId: number,
  ): Promise<{
    ok: boolean;
    value?: { state: string; bytesReceived: number; totalBytes: number; filename: string };
    error?: { code: string; message: string };
  }>;
  startDownload(
    url: string,
  ): Promise<{
    ok: boolean;
    value?: { downloadId: number };
    error?: { code: string; message: string };
  }>;
}

/**
 * Creates a file operations handler bound to the given browser adapter.
 *
 * The returned function validates raw params with Zod and dispatches
 * to the appropriate file operation based on the action.
 */
export function createFileOpsHandler(adapter: IBrowserAdapter) {
  return async (params: unknown): Promise<FileOpsResult> => {
    const parsed = FileOpsParamsSchema.safeParse(params);

    if (!parsed.success) {
      throw new Error(
        `Invalid file-ops params: ${parsed.error.issues.map((i: { message: string }) => i.message).join(', ')}`,
      );
    }

    const { action } = parsed.data;

    switch (action) {
      case 'uploadFile':
        return uploadFile(adapter, parsed.data);
      case 'downloadStatus':
        return downloadStatus(adapter, parsed.data);
      case 'startDownload':
        return startDownload(adapter, parsed.data);
      default:
        throw new Error(`Unknown file-ops action: ${action as string}`);
    }
  };
}

async function uploadFile(
  adapter: IBrowserAdapter,
  data: { selector?: string; filePaths?: string[] },
): Promise<FileOpsResult> {
  if (!data.selector) {
    throw new Error('selector is required for uploadFile action');
  }
  if (!data.filePaths || data.filePaths.length === 0) {
    throw new Error('filePaths is required for uploadFile action');
  }

  const tabResult = await adapter.getActiveTab();
  if (!tabResult.ok) {
    throw new Error(`[${ErrorCode.TAB_NOT_FOUND}] No active tab found`);
  }

  const fileOpsAdapter = adapter as unknown as FileOpsAdapter;
  if (typeof fileOpsAdapter.setFileInput !== 'function') {
    throw new Error('Adapter does not support setFileInput');
  }

  const result = await fileOpsAdapter.setFileInput(
    tabResult.value.tabId,
    data.selector,
    data.filePaths,
  );

  if (!result.ok) {
    throw new Error(`[${result.error?.code}] ${result.error?.message}`);
  }

  return {
    success: true,
    action: 'uploadFile',
    message: `Set ${data.filePaths.length} file(s) on ${data.selector}`,
  };
}

async function downloadStatus(
  adapter: IBrowserAdapter,
  data: { downloadId?: number },
): Promise<FileOpsResult> {
  if (data.downloadId === undefined) {
    throw new Error('downloadId is required for downloadStatus action');
  }

  const fileOpsAdapter = adapter as unknown as FileOpsAdapter;
  if (typeof fileOpsAdapter.getDownloadStatus !== 'function') {
    throw new Error('Adapter does not support getDownloadStatus');
  }

  const result = await fileOpsAdapter.getDownloadStatus(data.downloadId);

  if (!result.ok) {
    throw new Error(`[${result.error?.code}] ${result.error?.message}`);
  }

  return {
    success: true,
    action: 'downloadStatus',
    data: result.value,
  };
}

async function startDownload(
  adapter: IBrowserAdapter,
  data: { url?: string },
): Promise<FileOpsResult> {
  if (!data.url) {
    throw new Error('url is required for startDownload action');
  }

  const fileOpsAdapter = adapter as unknown as FileOpsAdapter;
  if (typeof fileOpsAdapter.startDownload !== 'function') {
    throw new Error('Adapter does not support startDownload');
  }

  const result = await fileOpsAdapter.startDownload(data.url);

  if (!result.ok) {
    throw new Error(`[${result.error?.code}] ${result.error?.message}`);
  }

  return {
    success: true,
    action: 'startDownload',
    data: result.value,
  };
}

export type { FileOpsResult };
