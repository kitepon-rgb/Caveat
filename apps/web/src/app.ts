import { Hono } from 'hono';
import type { WebContext } from './context.js';
import { createIndexRoute } from './routes/index.js';
import { createDetailRoute } from './routes/detail.js';
import { createCommunityRoute } from './routes/community.js';

export function createApp(ctx: WebContext): Hono {
  const app = new Hono();
  app.route('/', createIndexRoute(ctx));
  app.route('/', createDetailRoute(ctx));
  app.route('/', createCommunityRoute(ctx));
  return app;
}
