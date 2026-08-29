import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerBrowserTools } from './tools/index.js';
import { ToolExecutor } from './tools/tool-executor.js';
import { NativeMessagingClient } from './transport/native-messaging-client.js';
import type { ServerConfig } from './config/server-config.js';

export interface CreateServerResult {
  readonly server: McpServer;
  readonly client: NativeMessagingClient;
  readonly executor: ToolExecutor;
}

/**
 * Creates a fully configured MCP server with tool registration,
 * a {@link NativeMessagingClient}, and a {@link ToolExecutor}.
 *
 * The returned server is ready to be connected to a transport.
 */
export function createServer(config: ServerConfig): CreateServerResult {
  const server = new McpServer(
    { name: config.serverName, version: config.serverVersion },
    { capabilities: { tools: {} } },
  );

  registerBrowserTools(server.server);

  const client = new NativeMessagingClient(config.nativeMessagingHostPath);
  const executor = new ToolExecutor(client, config.timeout);

  return { server, client, executor };
}
