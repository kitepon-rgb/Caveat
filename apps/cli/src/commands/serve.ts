export interface ServeOptions {
  port: number;
}

export async function runServe(opts: ServeOptions): Promise<void> {
  const { startServer } = await import('@caveat/web');
  const { port, host } = startServer({ port: opts.port });
  process.stdout.write(`[caveat] web portal: http://${host}:${port}/\n`);
  process.stdout.write('[caveat] press Ctrl+C to stop\n');
}
