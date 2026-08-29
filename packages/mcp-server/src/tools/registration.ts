import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { BROWSER_TOOLS } from './browser-tools.js';

/**
 * Registers ListTools and CallTool request handlers on the low-level
 * MCP Server instance.
 *
 * - `tools/list` returns all browser tool definitions.
 * - `tools/call` dispatches to a stub handler (actual browser command
 *   dispatch is wired in a separate task).
 */
export function registerBrowserTools(server: Server): void {
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: BROWSER_TOOLS.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const tool = BROWSER_TOOLS.find((t) => t.name === name);

    if (!tool) {
      return {
        content: [{ type: 'text' as const, text: `Unknown tool: ${name}` }],
        isError: true,
      };
    }

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            tool: name,
            params: args ?? {},
            status: 'not_connected',
          }),
        },
      ],
    };
  });
}
