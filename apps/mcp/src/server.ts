import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { buildMcpContext } from './context.js';
import { registerAllTools } from './registerTools.js';

async function main(): Promise<void> {
  const ctx = buildMcpContext();
  const server = new McpServer(
    { name: 'caveat', version: '0.0.0' },
    { capabilities: { tools: {} } },
  );
  registerAllTools(server, ctx);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // On SIGINT/SIGTERM: close db before exiting
  const shutdown = (): void => {
    try {
      ctx.db.close();
    } catch {
      // ignore
    }
    process.exit(0);
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`[caveat:error] ${msg}\n`);
  process.exit(1);
});
