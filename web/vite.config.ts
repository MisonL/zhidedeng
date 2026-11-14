import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
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
