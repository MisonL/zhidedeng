import { serveStatic } from '@hono/node-server/serve-static';
import type { Hono } from 'hono';
import type { Env } from 'hono/types';

/**
 * 安全响应头。nginx 模板里给前端配了一整套，但容器直映射（docker-compose 里
 * 只有 `ports: 8788:8787`，前面没有 nginx）时一条都不会下发——那正是现在的部署方式。
 * 策略与 nginx 模板保持一致：只允许同源脚本、禁止被 iframe 嵌套、禁止 MIME 嗅探。
 * style-src 保留 'unsafe-inline' 是因为 React 的 style 属性会被转成内联样式。
 */
const SECURITY_HEADERS: ReadonlyArray<readonly [string, string]> = [
  ['content-security-policy', "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'"],
  ['x-content-type-options', 'nosniff'],
  ['x-frame-options', 'DENY'],
  ['referrer-policy', 'same-origin'],
];

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
      for (const [name, value] of SECURITY_HEADERS) found.headers.set(name, value);
      return found;
    }
    if (path.startsWith('/assets/')) return next();

    const fallback = await page(c, next);
    if (fallback) {
      fallback.headers.set('cache-control', NO_CACHE);
      for (const [name, value] of SECURITY_HEADERS) fallback.headers.set(name, value);
    }
    return fallback;
  });
}
