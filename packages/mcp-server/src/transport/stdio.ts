import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

/**
 * Creates a {@link StdioServerTransport} and connects it to the
 * provided MCP server. The transport reads JSON-RPC messages from
 * stdin and writes responses to stdout.
 *
 * @param server - The MCP server instance to connect.
 * @returns A cleanup function that closes the transport.
 */
export async function connectStdioTransport(
  server: McpServer,
): Promise<() => Promise<void>> {
  const transport = new StdioServerTransport();
  await server.connect(transport);

  return async () => {
    await server.close();
  };
}
