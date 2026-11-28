import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { serveStatic } from '@hono/node-server/serve-static';
import type { Hono } from 'hono';
import type { Env } from 'hono/types';
import type { Store } from './database.ts';
import { injectMeta, pageMeta, robotsTxt, rssXml, sitemapXml } from './seo.ts';

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

/**
 * 托管 web/dist：assets 带内容哈希可以长缓存，index.html 不缓存，其他路径回退到 SPA。
 * API 的 404 不受影响。
 *
 * 回退到 SPA 时**改写 index.html 的 head**：单页应用的每个详情页在搜索引擎和社交
 * 预览里都只能是同一句「什么值得蹬」，等于把 2 万个页面压成 1 个。所以这里按路径
 * 注入 title/description/canonical/OG。只有真实内容进索引，演示与未核实内容带 noindex。
 */
export function mountWeb<E extends Env>(app: Hono<E>, webRoot: string, store: Store, publicOrigin?: string) {
  const file = serveStatic({ root: webRoot });
  const notFound = async () => {};
  // 读一次缓存起来：index.html 只有一个，且只在构建时变；每次请求都读盘没必要。
  const shell = () => readFileSync(join(webRoot, 'index.html'), 'utf8');

  // 引擎入口。放在静态文件之前，否则 `/sitemap.xml` 会先被 serveStatic 找一遍再回退成 SPA。
  app.get('/sitemap.xml', c => {
    const body = sitemapXml(store, originOf(c.req.url, publicOrigin));
    return c.body(body, 200, { 'content-type': 'application/xml; charset=utf-8', 'cache-control': SHORT });
  });
  app.get('/rss.xml', c => {
    const body = rssXml(store, originOf(c.req.url, publicOrigin));
    return c.body(body, 200, { 'content-type': 'application/rss+xml; charset=utf-8', 'cache-control': SHORT });
  });
  app.get('/robots.txt', c => c.body(robotsTxt(originOf(c.req.url, publicOrigin)), 200, {
    'content-type': 'text/plain; charset=utf-8', 'cache-control': SHORT,
  }));

  app.on(['GET', 'HEAD'], '*', async (c, next) => {
    const { path } = c.req;
    if (path === '/api' || path.startsWith('/api/')) return next();

    // 首页与 /index.html 直接走注入分支，**绝不能先交给 serveStatic**：
    // 它会按磁盘上那份 index.html 设好 content-length，我们随后把正文换成
    // 注入了 meta 的更长版本，浏览器就会按旧长度截断（实测声明 1188、实发 1652，
    // 页面被切在半截）。所以先判 shell，再查静态文件。
    const isShell = path === '/' || path === '/index.html';
    if (!isShell) {
      const found = await file(c, notFound);
      if (found) {
        const cache = path.startsWith('/assets/') ? IMMUTABLE : SHORT;
        found.headers.set('cache-control', cache);
        for (const [name, value] of SECURITY_HEADERS) found.headers.set(name, value);
        return found;
      }
      // 带扩展名的路径是「文件请求」，不是 SPA 路由：给它回一个 200 的
      // HTML 壳子只会造成软 404（浏览器拿 HTML 当图片/脚本解析，搜索引擎
      // 把不存在的地址当成一个可索引页面）。直接交给 Hono 回 404。
      const last = path.split('/').at(-1) ?? '';
      if (last.includes('.') || path.startsWith('/assets/')) return next();
    }

    // 回退到 SPA（或首页壳子），带上这条路径对应的 meta。
    const meta = pageMeta(store, path);
    const html = injectMeta(shell(), meta, originOf(c.req.url, publicOrigin));
    const headers: Record<string, string> = { 'content-type': 'text/html; charset=utf-8', 'cache-control': NO_CACHE };
    for (const [name, value] of SECURITY_HEADERS) headers[name] = value;
    // HEAD 不需要正文，但 Hono 的 body 类型不收 null：给空串。
    // content-length 由 c.body 按实际字符串重新算（不要手动设）。
    return c.body(c.req.method === 'HEAD' ? '' : html, 200, headers);
  });
}

/**
 * 绝对 URL 的 origin。
 *
 * 域名还没定，所以不写死：优先 PUBLIC_ORIGIN（反代后面请求自身的 origin 是
 * 内网地址，写进 sitemap 就是错的），没配时退回请求的 origin，本地开发可用。
 */
function originOf(requestUrl: string, configured?: string): string {
  if (configured) return configured.replace(/\/$/, '');
  return new URL(requestUrl).origin;
}
