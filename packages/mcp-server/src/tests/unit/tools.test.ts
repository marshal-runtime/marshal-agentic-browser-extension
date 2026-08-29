import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BROWSER_TOOLS } from '../../tools/browser-tools.js';
import { registerBrowserTools } from '../../tools/registration.js';
import { ToolExecutor, InvalidToolParametersError } from '../../tools/tool-executor.js';
import type { NativeMessagingClient } from '../../transport/native-messaging-client.js';

const EXPECTED_TOOL_NAMES = [
  'browser_navigate',
  'browser_click',
  'browser_type',
  'browser_select',
  'browser_hover',
  'browser_scroll',
  'browser_keyboard',
  'browser_screenshot',
  'browser_accessibility_tree',
  'browser_get_html',
  'browser_extract_data',
  'browser_create_tab',
  'browser_close_tab',
  'browser_switch_tab',
  'browser_list_tabs',
  'browser_list_targets',
  'browser_handle_dialog',
  'browser_get_dialog_info',
  'browser_wait_for_selector',
  'browser_wait_for_navigation',
  'browser_wait_for_network_idle',
  'browser_wait_for_condition',
  'browser_execute_script',
  'browser_execute_script_file',
  'browser_validate',
  'browser_console',
  'browser_modify_html',
  'browser_modify_css',
  'browser_connect_remote',
  'browser_disconnect_remote',
  'browser_get_storage',
  'browser_set_storage',
  'browser_clear_storage',
  'browser_file_upload',
  'browser_download',
  'browser_go_back',
  'browser_go_forward',
  'browser_reload',
  'browser_intercept_network',
  'browser_bookmarks',
  'browser_history',
  'browser_downloads',
  'browser_get_metadata',
  'browser_switch_backend',
  'browser_list_tools',
  'browser_emulate_device',
  'browser_undo_modification',
  'browser_revert_all',
  'browser_export_session',
  'browser_import_session',
];

describe('BROWSER_TOOLS definitions', () => {
  it('should define exactly 50 tools', () => {
    expect(BROWSER_TOOLS).toHaveLength(50);
  });

  it('should register all expected tool names', () => {
    const names = BROWSER_TOOLS.map((t) => t.name);
    expect(names).toEqual(EXPECTED_TOOL_NAMES);
  });

  it('should have descriptions for all tools', () => {
    for (const tool of BROWSER_TOOLS) {
      expect(tool.description).toBeTruthy();
      expect(typeof tool.description).toBe('string');
    }
  });

  it('should have valid JSON Schema inputSchema for all tools', () => {
    for (const tool of BROWSER_TOOLS) {
      expect(tool.inputSchema).toBeDefined();
      expect(tool.inputSchema.type).toBe('object');
      expect(tool.inputSchema.properties).toBeDefined();
    }
  });

  it('should mark required fields for tools that need them', () => {
    const navigateTool = BROWSER_TOOLS.find((t) => t.name === 'browser_navigate')!;
    expect(navigateTool.inputSchema.required).toContain('url');

    const clickTool = BROWSER_TOOLS.find((t) => t.name === 'browser_click')!;
    // click accepts either a selector or x,y coordinates — no single field is required
    expect(clickTool.inputSchema.required).toBeUndefined();

    const typeTool = BROWSER_TOOLS.find((t) => t.name === 'browser_type')!;
    expect(typeTool.inputSchema.required).toEqual(expect.arrayContaining(['selector', 'text']));
  });

  it('should not have required fields for tools that accept no required params', () => {
    const screenshotTool = BROWSER_TOOLS.find((t) => t.name === 'browser_screenshot')!;
    expect(screenshotTool.inputSchema.required).toBeUndefined();

    const listTabsTool = BROWSER_TOOLS.find((t) => t.name === 'browser_list_tabs')!;
    expect(listTabsTool.inputSchema.required).toBeUndefined();
  });
});

describe('registerBrowserTools', () => {
  let mockServer: { setRequestHandler: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    mockServer = {
      setRequestHandler: vi.fn(),
    };
  });

  it('should register ListTools and CallTool handlers', () => {
    registerBrowserTools(mockServer as unknown as Parameters<typeof registerBrowserTools>[0]);

    expect(mockServer.setRequestHandler).toHaveBeenCalledTimes(2);
  });

  it('should return all tools from ListTools handler', async () => {
    registerBrowserTools(mockServer as unknown as Parameters<typeof registerBrowserTools>[0]);

    const listToolsHandler = mockServer.setRequestHandler.mock.calls[0]![1] as () => Promise<{
      tools: Array<{ name: string; description: string; inputSchema: unknown }>;
    }>;
    const result = await listToolsHandler();

    expect(result.tools).toHaveLength(50);
    expect(result.tools[0]!.name).toBe('browser_navigate');
    expect(result.tools[0]!.description).toBeTruthy();
    expect(result.tools[0]!.inputSchema).toBeDefined();
  });

  it('should return error for unknown tool in CallTool handler', async () => {
    registerBrowserTools(mockServer as unknown as Parameters<typeof registerBrowserTools>[0]);

    const callToolHandler = mockServer.setRequestHandler.mock.calls[1]![1] as (request: {
      params: { name: string; arguments?: Record<string, unknown> };
    }) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>;

    const result = await callToolHandler({
      params: { name: 'nonexistent_tool' },
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('Unknown tool');
  });

  it('should return stub response for known tool in CallTool handler', async () => {
    registerBrowserTools(mockServer as unknown as Parameters<typeof registerBrowserTools>[0]);

    const callToolHandler = mockServer.setRequestHandler.mock.calls[1]![1] as (request: {
      params: { name: string; arguments?: Record<string, unknown> };
    }) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>;

    const result = await callToolHandler({
      params: { name: 'browser_navigate', arguments: { url: 'https://example.com' } },
    });

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0]!.text) as {
      tool: string;
      params: Record<string, unknown>;
      status: string;
    };
    expect(parsed.tool).toBe('browser_navigate');
    expect(parsed.params).toEqual({ url: 'https://example.com' });
    expect(parsed.status).toBe('not_connected');
  });
});

describe('ToolExecutor', () => {
  let mockClient: {
    onMessage: ReturnType<typeof vi.fn>;
    send: ReturnType<typeof vi.fn>;
  };
  let executor: ToolExecutor;

  beforeEach(() => {
    mockClient = {
      onMessage: vi.fn().mockReturnValue(vi.fn()),
      send: vi.fn(),
    };
    executor = new ToolExecutor(mockClient as unknown as NativeMessagingClient, 1000);
  });

  it('should throw InvalidToolParametersError for unknown tool', async () => {
    await expect(executor.execute('unknown_tool', {})).rejects.toThrow(InvalidToolParametersError);
    await expect(executor.execute('unknown_tool', {})).rejects.toThrow('Unknown tool');
  });

  it('should throw InvalidToolParametersError for missing required params', async () => {
    await expect(executor.execute('browser_navigate', {})).rejects.toThrow(
      InvalidToolParametersError,
    );
    await expect(executor.execute('browser_navigate', {})).rejects.toThrow(
      'Missing required parameters: url',
    );
  });

  it('should send command and resolve on matching response', async () => {
    mockClient.onMessage.mockImplementation((callback: (msg: unknown) => void) => {
      setTimeout(() => {
        const sentRequest = mockClient.send.mock.calls[0]![0] as { id: string };
        callback({
          id: sentRequest.id,
          success: true,
          data: { url: 'https://example.com' },
          metadata: { duration: 100, timestamp: Date.now() },
        });
      }, 10);
      return vi.fn();
    });

    const result = await executor.execute('browser_navigate', {
      url: 'https://example.com',
    });

    expect(result.success).toBe(true);
    expect(result.data).toEqual({ url: 'https://example.com' });
    expect(mockClient.send).toHaveBeenCalledWith(
      expect.objectContaining({
        command: 'navigate',
        params: { url: 'https://example.com' },
      }),
    );
  });

  it('should ignore non-matching response IDs', async () => {
    mockClient.onMessage.mockImplementation((callback: (msg: unknown) => void) => {
      setTimeout(() => {
        callback({ id: 'wrong-id', success: true, data: {} });
      }, 5);
      setTimeout(() => {
        const sentRequest = mockClient.send.mock.calls[0]![0] as { id: string };
        callback({
          id: sentRequest.id,
          success: true,
          data: { matched: true },
        });
      }, 15);
      return vi.fn();
    });

    const result = await executor.execute('browser_list_tabs', {});

    expect(result.success).toBe(true);
    expect(result.data).toEqual({ matched: true });
  });

  it('should ignore responses from a different Marshal browser session', async () => {
    const context = {
      chatId: 'chat-a',
      executionId: 'exec-a',
      browserSessionId: 'session-a',
    };
    mockClient.onMessage.mockImplementation((callback: (msg: unknown) => void) => {
      setTimeout(() => {
        const sentRequest = mockClient.send.mock.calls[0]![0] as { id: string };
        callback({
          id: sentRequest.id,
          success: true,
          data: { isolated: false },
          metadata: {
            duration: 1,
            timestamp: Date.now(),
            context: {
              chatId: 'chat-b',
              executionId: 'exec-b',
              browserSessionId: 'session-b',
            },
          },
        });
      }, 5);
      setTimeout(() => {
        const sentRequest = mockClient.send.mock.calls[0]![0] as { id: string };
        callback({
          id: sentRequest.id,
          success: true,
          data: { isolated: true },
          metadata: { duration: 2, timestamp: Date.now(), context },
        });
      }, 15);
      return vi.fn();
    });

    const result = await executor.execute('browser_list_tabs', {}, context);

    expect(result.data).toEqual({ isolated: true });
    expect(mockClient.send).toHaveBeenCalledWith(expect.objectContaining({ context }));
  });

  it('should resolve with timeout error when response does not arrive', async () => {
    vi.useFakeTimers();

    mockClient.onMessage.mockReturnValue(vi.fn());

    const promise = executor.execute('browser_list_tabs', {});

    await vi.advanceTimersByTimeAsync(1100);

    const result = await promise;
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('TIMEOUT');

    vi.useRealTimers();
  });

  it('should reject when client.send throws', async () => {
    mockClient.send.mockImplementation(() => {
      throw new Error('Connection lost');
    });

    await expect(executor.execute('browser_list_tabs', {})).rejects.toThrow(
      'Failed to send command: Connection lost',
    );
  });

  it('should ignore non-CommandResponse messages', async () => {
    mockClient.onMessage.mockImplementation((callback: (msg: unknown) => void) => {
      setTimeout(() => {
        callback('not an object');
        callback(null);
        callback({ no_id: true });
      }, 5);
      setTimeout(() => {
        const sentRequest = mockClient.send.mock.calls[0]![0] as { id: string };
        callback({ id: sentRequest.id, success: true, data: {} });
      }, 15);
      return vi.fn();
    });

    const result = await executor.execute('browser_list_tabs', {});

    expect(result.success).toBe(true);
  });

  it('should accept tools without required params', async () => {
    mockClient.onMessage.mockImplementation((callback: (msg: unknown) => void) => {
      setTimeout(() => {
        const sentRequest = mockClient.send.mock.calls[0]![0] as { id: string };
        callback({ id: sentRequest.id, success: true, data: {} });
      }, 10);
      return vi.fn();
    });

    const result = await executor.execute('browser_screenshot', {});

    expect(result.success).toBe(true);
    expect(mockClient.send).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'captureScreenshot' }),
    );
  });
});
