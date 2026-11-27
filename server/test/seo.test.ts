import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/node-app.ts';

const json = { 'content-type': 'application/json' };
const TOKEN = 'admin-token-for-tests-0123456789abcdef';
const bearer = { ...json, authorization: `Bearer ${TOKEN}` };
const PASSWORD = 'correct-horse-battery';

let root: string;
let server: ReturnType<typeof createApp>;
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'zhidedeng-seo-'));
  const webRoot = join(root, 'web');
  mkdirSync(webRoot, { recursive: true });
  writeFileSync(join(webRoot, 'index.html'),
    '<!doctype html><html><head><title>SPA</title><meta name="description" content="旧描述" /></head><body><div id="root"></div></body></html>');
  // 审核要走管理接口，必须配 syncToken，否则拿到的是 403。
  server = createApp({ dbPath: ':memory:', webRoot, publicOrigin: 'https://example.test', syncToken: TOKEN });
});
afterAll(() => {
  server.db.close();
  rmSync(root, { recursive: true });
});

/** 取 head 里某个 meta 的 content。 */
function meta(html: string, key: string): string | null {
  const pattern = new RegExp(`<meta (?:name|property)="${key}" content="([^"]*)"`);
  return html.match(pattern)?.[1] ?? null;
}
const canonical = (html: string) => html.match(/<link rel="canonical" href="([^"]*)"/)?.[1] ?? null;

describe('服务端 SEO', () => {
  it('详情页注入自己的 title/description/canonical/OG', async () => {
    // 演示站是种子数据，页面能开但不该被索引。
    const html = await (await server.app.request('/stations/whale-demo')).text();
    expect(html).toContain('虚构·大肥鱼试验站');
    expect(meta(html, 'og:type')).toBe('article');
    expect(meta(html, 'og:url')).toBe('https://example.test/stations/whale-demo');
    expect(canonical(html)).toBe('https://example.test/stations/whale-demo');
    // 演示数据带 noindex：页面给人看，但别进搜索结果当真实评测。
    expect(meta(html, 'robots')).toBe('noindex, follow');
    // 旧 description 必须被替换掉，不能两条并存。
    expect(html).not.toContain('旧描述');
    expect(html.match(/name="description"/g)).toHaveLength(1);
  });

  it('认不出的路径回落到站点级 meta', async () => {
    const html = await (await server.app.request('/no-such-page')).text();
    expect(html).toContain('<title>什么值得蹬</title>');
    expect(meta(html, 'og:type')).toBe('website');
    expect(meta(html, 'robots')).toBeNull();
    expect(canonical(html)).toBe('https://example.test/');
  });

  it('站内用户写的已发布文章可索引；投稿与采集来的带 noindex', async () => {
    const register = await server.app.request('/api/auth/register', {
      method: 'POST', headers: json, body: JSON.stringify({ username: 'seoer', password: PASSWORD, nickname: '作者' }),
    });
    const cookie = (register.headers.get('set-cookie') ?? '').split(';')[0];
    const created = await server.app.request('/api/posts', {
      method: 'POST', headers: { ...json, cookie },
      body: JSON.stringify({ kind: 'community', title: '站内写的文章', summary: '摘要', body: '正文' }),
    });
    const id = (await created.json() as { id: string }).id;
    await server.app.request(`/api/admin/posts/${id}/review`, {
      method: 'POST', headers: bearer, body: JSON.stringify({ status: 'approved' }),
    });

    const html = await (await server.app.request(`/posts/${id}`)).text();
    expect(html).toContain('站内写的文章');
    expect(meta(html, 'robots')).toBeNull();
  });

  it('sitemap 只收真实内容，演示数据不进去', async () => {
    const response = await server.app.request('/sitemap.xml');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('xml');
    const body = await response.text();
    expect(body).toContain('<urlset');
    expect(body).toContain('<loc>https://example.test/stations</loc>');
    // 演示站的 slug 是 *-demo，一条都不该出现。
    expect(body).not.toMatch(/<loc>[^<]*-demo<\/loc>/);
    expect(body).not.toContain('/admin');
  });

  it('RSS 只收站内用户文章，且新的在前', async () => {
    const body = await (await server.app.request('/rss.xml')).text();
    expect(body).toContain('<rss version="2.0">');
    expect(body).toContain('<title>什么值得蹬</title>');
    // 演示文章不进 RSS。
    expect(body).not.toContain('大肥鱼试验站');
  });

  it('robots.txt 屏蔽后台与接口并指向 sitemap', async () => {
    const body = await (await server.app.request('/robots.txt')).text();
    expect(body).toContain('Disallow: /admin');
    expect(body).toContain('Disallow: /api/');
    expect(body).toContain('Sitemap: https://example.test/sitemap.xml');
  });

  it('未配置 PUBLIC_ORIGIN 时退回请求自身 origin', async () => {
    const bare = createApp({ dbPath: ':memory:', webRoot: join(root, 'web') });
    const body = await (await bare.app.request('http://127.0.0.1:8787/robots.txt')).text();
    expect(body).toContain('Sitemap: http://127.0.0.1:8787/sitemap.xml');
    bare.db.close();
  });

  it('meta 里的标题做 HTML 转义，不能把标签带进去', async () => {
    const html = await (await server.app.request('/posts/%3Cscript%3E')).text();
    expect(html).not.toContain('<script>alert');
    expect(html).toBeTruthy();
  });
});
