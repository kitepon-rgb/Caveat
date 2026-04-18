import { serve } from '@hono/node-server';
import { buildWebContext } from './context.js';
import { createApp } from './app.js';

export interface ServeOptions {
  port?: number;
  host?: string;
}

export function startServer(opts: ServeOptions = {}): {
  close: () => Promise<void>;
  port: number;
  host: string;
} {
  const ctx = buildWebContext();
  const app = createApp(ctx);
  const port = opts.port ?? 4242;
  const host = opts.host ?? '127.0.0.1';

  const server = serve({ fetch: app.fetch, port, hostname: host });
  process.stderr.write(`[caveat:web] listening on http://${host}:${port}\n`);

  return {
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          try {
            ctx.db.close();
          } catch {
            // ignore
          }
          resolve();
        });
      }),
    port,
    host,
  };
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}`) {
  const portEnv = process.env.PORT ? Number(process.env.PORT) : undefined;
  startServer({ port: portEnv });
}
