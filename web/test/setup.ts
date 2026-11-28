import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, beforeEach, vi } from 'vitest';

beforeEach(() => {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
  // 与新版 Chromium 一致：scrollTo 返回 Promise。
  window.scrollTo = (() => Promise.resolve()) as typeof window.scrollTo;
});

afterEach(() => {
  cleanup();
  // 清掉存储。`--no-isolate` 下同一个 worker 里的 jsdom 环境是复用的，
  // 上一个文件留下的 sessionStorage（比如审核台的管理密钥）会带到下一个文件：
  // admin.test.tsx 结尾留着 zdd.adminToken，agent-tokens.test.tsx 断言
  // 「什么都没存」就会假红，而且只在特定文件顺序下红——最难查的那种。
  localStorage.clear();
  sessionStorage.clear();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
