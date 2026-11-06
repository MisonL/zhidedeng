import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/node-app.ts';

let root: string;
let webRoot: string;
let server: ReturnType<typeof createApp>;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'zhidedeng-web-'));
  webRoot = join(root, 'web');
  mkdirSync(join(webRoot, 'assets'), { recursive: true });
  mkdirSync(join(webRoot, 'banners'));
  writeFileSync(join(webRoot, 'index.html'), '<!doctype html><title>SPA</title>');
  writeFileSync(join(webRoot, 'assets', 'app-abc.js'), 'console.log(1)');
  writeFileSync(join(webRoot, 'banners', 'a.webp'), 'webp');
  writeFileSync(join(root, 'secret.txt'), 'top secret');
  server = createApp({ dbPath: ':memory:', webRoot });
});
afterAll(() => {
  server.db.close();
  rmSync(root, { recursive: true });
});

describe('托管前端', () => {
  it.each(['/', '/stations/whale-demo', '/login?next=%2Fme', '/posts/post-1'])('%s 回退到 index.html，不缓存', async path => {
    const response = await server.app.request(path);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('<title>SPA</title>');
    expect(response.headers.get('content-type')).toContain('text/html');
    expect(response.headers.get('cache-control')).toBe('no-cache');
  });

  it('assets 长缓存', async () => {
    const response = await server.app.request('/assets/app-abc.js');
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
  });

  it('assets 里不存在的文件是 404，不回退成页面', async () => {
    expect((await server.app.request('/assets/missing.js')).status).toBe(404);
  });

  it('其他静态文件短缓存', async () => {
    const response = await server.app.request('/banners/a.webp');
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('public, max-age=3600');
  });

  it.each(['/api/missing', '/api'])('%s 仍返回 JSON 404', async path => {
    const response = await server.app.request(path);
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
  });

  it('API 正常工作', async () => {
    expect((await server.app.request('/api/vendors')).status).toBe(200);
    expect((await server.app.request('/api/health')).status).toBe(200);
  });

  it.each(['/../secret.txt', '/%2e%2e/secret.txt', '/assets/../../secret.txt', '/assets/%2e%2e/%2e%2e/secret.txt'])('%s 读不到 web 目录之外的文件', async path => {
    const text = await (await server.app.request(path)).text();
    expect(text).not.toContain('top secret');
  });

  it('非 GET 请求不回退页面', async () => {
    const response = await server.app.request('/stations', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(response.status).toBe(404);
  });
});
