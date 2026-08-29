import { randomUUID } from 'node:crypto';
import type { NativeMessagingClient } from '../transport/native-messaging-client.js';
import type {
  CommandName,
  CommandRequest,
  CommandResponse,
  CommandResponseError,
  CommandResponseMetadata,
  BrowserRequestContext,
} from '@agentic-browser/shared';
import { DEFAULT_TIMEOUT } from '@agentic-browser/shared';
import { BROWSER_TOOLS } from './browser-tools.js';

/**
 * Maps MCP tool names (e.g. `browser_navigate`) to extension
 * {@link CommandName} values (e.g. `navigate`).
 */
const TOOL_TO_COMMAND: Readonly<Record<string, CommandName>> = {
  browser_navigate: 'navigate',
  browser_click: 'click',
  browser_type: 'type',
  browser_select: 'select',
  browser_hover: 'hover',
  browser_scroll: 'scroll',
  browser_screenshot: 'captureScreenshot',
  browser_accessibility_tree: 'getAccessibilityTree',
  browser_get_html: 'getHTML',
  browser_extract_data: 'extractData',
  browser_create_tab: 'createTab',
  browser_close_tab: 'closeTab',
  browser_switch_tab: 'switchTab',
  browser_list_tabs: 'listTabs',
  browser_handle_dialog: 'handleDialog',
  browser_get_dialog_info: 'getDialogInfo',
  browser_wait_for_selector: 'waitForSelector',
  browser_wait_for_navigation: 'waitForNavigation',
  browser_wait_for_network_idle: 'waitForNetworkIdle',
  browser_wait_for_condition: 'waitForCondition',
  browser_execute_script: 'executeScript',
  browser_execute_script_file: 'executeScriptFile',
  browser_validate: 'executeValidation',
  browser_console: 'executeConsoleCommand',
  browser_modify_html: 'modifyHTML',
  browser_modify_css: 'modifyCSS',
  browser_connect_remote: 'connect',
  browser_disconnect_remote: 'disconnect',
  browser_get_storage: 'getStorage',
  browser_set_storage: 'setStorage',
  browser_clear_storage: 'clearStorage',
  browser_file_upload: 'uploadFile',
  browser_download: 'downloadStatus',
  browser_go_back: 'goBack',
  browser_go_forward: 'goForward',
  browser_reload: 'reload',
  browser_intercept_network: 'interceptNetwork',
  browser_bookmarks: 'listBookmarks',
  browser_history: 'searchHistory',
  browser_downloads: 'getDownloadItems',
  browser_get_metadata: 'getMetadata',
  browser_switch_backend: 'switchBackend',
  browser_list_tools: 'listTools',
  browser_emulate_device: 'emulateDevice',
  browser_undo_modification: 'undoModification',
  browser_revert_all: 'revertAll',
  browser_export_session: 'exportSession',
  browser_import_session: 'importSession',
};

/** Structured result returned by {@link ToolExecutor.execute}. */
export interface ToolExecutorResult {
  readonly success: boolean;
  readonly data?: unknown;
  readonly error?: CommandResponseError;
  readonly metadata?: CommandResponseMetadata;
}

/** Error thrown when an MCP tool call has invalid parameters. */
export class InvalidToolParametersError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidToolParametersError';
  }
}

/**
 * Routes MCP tool calls through Native Messaging to the browser
 * extension and returns structured responses.
 *
 * Each call is correlated with a unique request ID. The executor
 * registers a one-shot message handler on the {@link NativeMessagingClient},
 * sends the command, and resolves when a matching response arrives
 * or the timeout elapses.
 */
export class ToolExecutor {
  private readonly client: NativeMessagingClient;
  private readonly timeout: number;

  constructor(client: NativeMessagingClient, timeout = DEFAULT_TIMEOUT) {
    this.client = client;
    this.timeout = timeout;
  }

  /**
   * Executes an MCP tool call by routing it to the browser extension.
   *
   * @param toolName - MCP tool name (e.g. `browser_navigate`).
   * @param params - Tool parameters from the MCP request.
   * @returns Structured result with success, data, error, and metadata.
   * @throws {@link InvalidToolParametersError} when the tool name is
   *   unknown or required parameters are missing.
   */
  async execute(
    toolName: string,
    params: Record<string, unknown>,
    context?: BrowserRequestContext,
  ): Promise<ToolExecutorResult> {
    const command = TOOL_TO_COMMAND[toolName];

    if (!command) {
      throw new InvalidToolParametersError(`Unknown tool: ${toolName}`);
    }

    const toolDef = BROWSER_TOOLS.find((t) => t.name === toolName);
    if (toolDef) {
      const missing = this.findMissingRequired(toolDef.inputSchema, params);
      if (missing.length > 0) {
        throw new InvalidToolParametersError(`Missing required parameters: ${missing.join(', ')}`);
      }
    }

    const requestId = randomUUID();
    const request: CommandRequest = {
      id: requestId,
      command,
      params,
      timestamp: Date.now(),
      context,
    };

    return this.sendAndAwaitResponse(request);
  }

  private sendAndAwaitResponse(request: CommandRequest): Promise<ToolExecutorResult> {
    return new Promise<ToolExecutorResult>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      let dispose: (() => void) | null = null;

      const cleanup = (): void => {
        if (timer !== null) {
          clearTimeout(timer);
          timer = null;
        }
        if (dispose !== null) {
          dispose();
          dispose = null;
        }
      };

      dispose = this.client.onMessage((message: unknown) => {
        if (!isCommandResponse(message)) {
          return;
        }
        if (message.id !== request.id) {
          return;
        }
        if (!matchesRequestContext(request.context, message.metadata?.context)) {
          return;
        }

        cleanup();
        resolve({
          success: message.success,
          data: message.data,
          error: message.error,
          metadata: message.metadata,
        });
      });

      timer = setTimeout(() => {
        cleanup();
        resolve({
          success: false,
          error: {
            code: 'TIMEOUT',
            message: `Tool execution timed out after ${String(this.timeout)}ms`,
          },
        });
      }, this.timeout);

      try {
        this.client.send(request);
      } catch (err: unknown) {
        cleanup();
        const detail = err instanceof Error ? err.message : String(err);
        reject(new Error(`Failed to send command: ${detail}`));
      }
    });
  }

  private findMissingRequired(
    inputSchema: { required?: readonly string[] },
    params: Record<string, unknown>,
  ): string[] {
    const required = inputSchema.required;
    if (!required || required.length === 0) {
      return [];
    }
    return required.filter((name) => !(name in params));
  }
}

function matchesRequestContext(
  requestContext: BrowserRequestContext | undefined,
  responseContext: BrowserRequestContext | undefined,
): boolean {
  if (requestContext === undefined) {
    return true;
  }
  return (
    responseContext?.chatId === requestContext.chatId &&
    responseContext.executionId === requestContext.executionId &&
    responseContext.browserSessionId === requestContext.browserSessionId
  );
}

function isCommandResponse(value: unknown): value is CommandResponse {
  return (
    typeof value === 'object' &&
    value !== null &&
    'id' in value &&
    'success' in value &&
    typeof (value as CommandResponse).id === 'string' &&
    typeof (value as CommandResponse).success === 'boolean'
  );
}
