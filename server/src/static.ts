import { serveStatic } from '@hono/node-server/serve-static';
import type { Hono } from 'hono';
import type { Env } from 'hono/types';

const NO_CACHE = 'no-cache';
const IMMUTABLE = 'public, max-age=31536000, immutable';
const SHORT = 'public, max-age=3600';

/** 托管 web/dist：assets 带内容哈希可以长缓存，index.html 不缓存，其他路径回退到 SPA。API 的 404 不受影响。 */
export function mountWeb<E extends Env>(app: Hono<E>, webRoot: string) {
  const file = serveStatic({ root: webRoot });
  const page = serveStatic({ root: webRoot, path: 'index.html' });
  const notFound = async () => {};

  app.on(['GET', 'HEAD'], '*', async (c, next) => {
    const { path } = c.req;
    if (path === '/api' || path.startsWith('/api/')) return next();

    const found = await file(c, notFound);
    if (found) {
      const cache = path.startsWith('/assets/') ? IMMUTABLE : path === '/' || path.endsWith('index.html') ? NO_CACHE : SHORT;
      found.headers.set('cache-control', cache);
      return found;
    }
    if (path.startsWith('/assets/')) return next();

    const fallback = await page(c, next);
    fallback?.headers.set('cache-control', NO_CACHE);
    return fallback;
  });
}
