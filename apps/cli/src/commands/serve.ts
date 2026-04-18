import { startServer } from '@caveat/web';

export interface ServeOptions {
  port: number;
}

export function runServe(opts: ServeOptions): void {
  const { port, host } = startServer({ port: opts.port });
  process.stdout.write(`[caveat] web portal: http://${host}:${port}/\n`);
  process.stdout.write('[caveat] press Ctrl+C to stop\n');
}
