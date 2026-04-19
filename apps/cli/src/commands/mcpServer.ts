import { startMcpStdioServer } from '@caveat/mcp';

export async function runMcpServer(): Promise<void> {
  await startMcpStdioServer();
}
