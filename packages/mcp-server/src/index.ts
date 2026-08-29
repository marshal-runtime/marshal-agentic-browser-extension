#!/usr/bin/env node

import { loadConfig } from './config/server-config.js';
import { createServer } from './server.js';
import { connectStdioTransport } from './transport/stdio.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const { server, client } = createServer(config);

  client.connect();

  const cleanup = await connectStdioTransport(server);

  const shutdown = async (): Promise<void> => {
    client.disconnect();
    await cleanup();
  };

  process.on('SIGINT', () => {
    void shutdown().then(() => process.exit(0));
  });

  process.on('SIGTERM', () => {
    void shutdown().then(() => process.exit(0));
  });
}

process.on('uncaughtException', (error: Error) => {
  process.stderr.write(`Uncaught exception: ${error.message}\n`);
  process.exit(1);
});

process.on('unhandledRejection', (reason: unknown) => {
  const message = reason instanceof Error ? reason.message : String(reason);
  process.stderr.write(`Unhandled rejection: ${message}\n`);
  process.exit(1);
});

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Failed to start MCP server: ${message}\n`);
  process.exit(1);
});
