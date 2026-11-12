import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { createApp } from './node-app.ts';
import { purgeExpired } from './auth.ts';

const port = Number(process.env.PORT ?? 8787);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT 必须是 1～65535 的整数');
// 打包后 web/ 和 server.mjs 同目录；开发时没有这个目录，前端由 Vite 提供。
const webRoot = process.env.WEB_ROOT ?? fileURLToPath(new URL('./web', import.meta.url));
const { app, db, store } = createApp({ webRoot: existsSync(webRoot) ? webRoot : undefined });
// 默认只监听本机，公网流量经 nginx 反代进来；X-Forwarded-For 的信任也依赖这一点。
// 容器里没有宿主机的 nginx 同网段可达性，必须显式设 HOST=0.0.0.0 才能被反向代理访问。
// 放宽监听面等于放弃「只有本机能直连」这层保护，所以要么设 HOST，要么保持默认。
const hostname = process.env.HOST ?? '127.0.0.1';
if (hostname !== '127.0.0.1') {
  console.warn(`正在监听 ${hostname}，不再是仅本机。确认前面有反向代理再这么做。`);
}
// 过期数据清理：启动先跑一次（补上停机期间的欠账），之后每天一次。
// 放在 serve 之前是故意的：清理失败的库不该对外提供服务。
purgeExpired(store, new Date());
const purgeTimer = setInterval(() => {
  try { purgeExpired(store, new Date()); } catch (error) { console.error('清理过期数据失败', error); }
}, 24 * 60 * 60 * 1000);
purgeTimer.unref();

const server = serve({ fetch: app.fetch, port, hostname }, info => {
  console.log(`API listening on http://${info.address}:${info.port}`);
  // 监听非回环又没配可信反代：来源地址只能是网关，按 IP 的限流会退化成一个全站共用桶。
  if (hostname !== '127.0.0.1' && !process.env.TRUSTED_PROXIES) {
    console.warn('未配置 TRUSTED_PROXIES：所有请求的来源都会记成网关地址，按 IP 的限流与审计会失真。前面有反向代理时请填它的网段。');
  }
  // 生产环境靠 Secure cookie 保会话；请求若不是 https，cookie 会被浏览器丢弃，
  // 表现为「登录成功但立刻又变回未登录」。这里提前说清楚，别让人去猜。
  if (process.env.NODE_ENV === 'production' && process.env.TLS_ENABLED !== '1') {
    console.warn('生产环境未启用 TLS_ENABLED：会话 cookie 只在确认走 https 时才带 Secure。前面必须挂 HTTPS 反向代理并透传 X-Forwarded-Proto，否则登录态不被浏览器保存。');
  }
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => server.close(() => {
    db.close();
    process.exit(0);
  }));
}
