import { readFileSync } from 'node:fs';
import type { Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

/**
 * 把 SITE_NOTICE 注入 index.html 的 description。
 *
 * 这句话是站点对外的免责声明，同时写在 index.html 和 format.ts 里，改一处漏一处
 * 就会出现「页脚说三种来源、meta 只说两种」。用占位符 + 构建期替换，源码里只剩
 * 一份，且不需要为了取一句话把整个 format.ts 拉进来。
 */
function siteNoticeHtml(): Plugin {
  const source = readFileSync(new URL('./src/format.ts', import.meta.url), 'utf8');
  const match = /export const SITE_NOTICE = '([^']+)'/.exec(source);
  if (match === null) throw new Error('vite.config.ts: 没能从 src/format.ts 读到 SITE_NOTICE');
  const notice = match[1].replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  return {
    name: 'site-notice',
    transformIndexHtml: html => html.replaceAll('%SITE_NOTICE%', notice),
  };
}

export default defineConfig({
  plugins: [react(), siteNoticeHtml()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: { '/api': 'http://127.0.0.1:8787' },
  },
  test: {
    environment: 'jsdom',
    // test.env 在测试环境建立之前执行，用来定死 NODE_ENV：
    // 否则在 NODE_ENV=production 的 shell 里跑，react-dom 会载入生产版，
    // 没有 act()，所有渲染用例一起挂。
    env: { NODE_ENV: 'test' },
    setupFiles: './test/setup.ts',
    restoreMocks: true,
  },
});
