import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { createApp } from './node-app.ts';

const port = Number(process.env.PORT ?? 8787);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT 必须是 1～65535 的整数');
// 打包后 web/ 和 server.mjs 同目录；开发时没有这个目录，前端由 Vite 提供。
const webRoot = process.env.WEB_ROOT ?? fileURLToPath(new URL('./web', import.meta.url));
const { app, db } = createApp({ webRoot: existsSync(webRoot) ? webRoot : undefined });
// 只监听本机，公网流量经 nginx 反代进来；X-Forwarded-For 的信任也依赖这一点。
const server = serve({ fetch: app.fetch, port, hostname: '127.0.0.1' }, info => console.log(`API listening on http://127.0.0.1:${info.port}`));

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => server.close(() => {
    db.close();
    process.exit(0);
  }));
}
