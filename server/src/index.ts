import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { createApp } from './node-app.ts';

const port = Number(process.env.PORT ?? 8787);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT 必须是 1～65535 的整数');
// 打包后 web/ 和 server.mjs 同目录；开发时没有这个目录，前端由 Vite 提供。
const webRoot = process.env.WEB_ROOT ?? fileURLToPath(new URL('./web', import.meta.url));
const { app, db } = createApp({ webRoot: existsSync(webRoot) ? webRoot : undefined });
// 默认只监听本机，公网流量经 nginx 反代进来；X-Forwarded-For 的信任也依赖这一点。
// 容器里没有宿主机的 nginx 同网段可达性，必须显式设 HOST=0.0.0.0 才能被反向代理访问。
// 放宽监听面等于放弃「只有本机能直连」这层保护，所以要么设 HOST，要么保持默认。
const hostname = process.env.HOST ?? '127.0.0.1';
if (hostname !== '127.0.0.1') {
  console.warn(`正在监听 ${hostname}，不再是仅本机。确认前面有反向代理再这么做。`);
}
const server = serve({ fetch: app.fetch, port, hostname }, info => console.log(`API listening on http://${info.address}:${info.port}`));

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => server.close(() => {
    db.close();
    process.exit(0);
  }));
}
