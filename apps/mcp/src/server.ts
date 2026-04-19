import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { buildMcpContext, type McpContextOverrides } from './context.js';
import { registerAllTools } from './registerTools.js';

export async function startMcpStdioServer(
  overrides: McpContextOverrides = {},
): Promise<void> {
  const ctx = buildMcpContext(overrides);
  const server = new McpServer(
    { name: 'caveat', version: '0.0.0' },
    { capabilities: { tools: {} } },
  );
  registerAllTools(server, ctx);

  const transport = new StdioServerTransport();
  await server.connect(transport);

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

const invokedPath = process.argv[1]?.replace(/\\/g, '/') ?? '';
const thisPath = import.meta.url.startsWith('file://')
  ? import.meta.url.slice(7).replace(/^\/+([a-zA-Z]:)/, '$1')
  : '';
if (invokedPath && thisPath && invokedPath.toLowerCase() === thisPath.toLowerCase()) {
  startMcpStdioServer().catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[caveat:error] ${msg}\n`);
    process.exit(1);
  });
}
