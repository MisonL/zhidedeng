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

  it('标题里的 $ 序列不会被当成替换引用展开', async () => {
    // String.replace 的替换串里 `$&` / `$'` / `$1` 是引用语法，而标题来自用户投稿。
    // 必须真的造一个带 $ 的标题：拿现成标题测，「不含 $&」永远成立，等于没测。
    const register = await server.app.request('/api/auth/register', {
      method: 'POST', headers: json, body: JSON.stringify({ username: 'dollar', password: PASSWORD, nickname: '$' }),
    });
    const cookie = (register.headers.get('set-cookie') ?? '').split(';')[0];
    const created = await server.app.request('/api/posts', {
      method: 'POST', headers: { ...json, cookie },
      body: JSON.stringify({ kind: 'community', title: "省 $& 实测：$' 与 $1 都不该被展开", summary: '摘要', body: '正文' }),
    });
    const id = (await created.json() as { id: string }).id;
    await server.app.request(`/api/admin/posts/${id}/review`, {
      method: 'POST', headers: bearer, body: JSON.stringify({ status: 'approved' }),
    });

    const html = await (await server.app.request(`/posts/${id}`)).text();
    // 标题原样出现在 <title> 与 og:title 里；$& 展开会把整段 head 复制进来。
    expect(html).toContain("省 $&amp; 实测：$&#39; 与 $1 都不该被展开");
    expect(html.match(/<head>/g)).toHaveLength(1);
  });

  it('列表页 canonical 自指，登录后页面 noindex', async () => {
    const stations = await (await server.app.request('/stations')).text();
    expect(canonical(stations)).toBe('https://example.test/stations');
    const rank = await (await server.app.request('/rank')).text();
    expect(canonical(rank)).toBe('https://example.test/rank');

    const me = await (await server.app.request('/me')).text();
    expect(meta(me, 'robots')).toBe('noindex, follow');
    const submit = await (await server.app.request('/submit')).text();
    expect(meta(submit, 'robots')).toBe('noindex, follow');
  });

  it('首页与 /index.html 的 content-length 与实际正文一致', async () => {
    // 曾经先交给 serveStatic（按磁盘上的短 index.html 设好长度），再换成注入后的
    // 长版本：声明 1188、实发 1652，页面被截断。
    for (const path of ['/', '/index.html']) {
      const response = await server.app.request(path);
      const body = await response.text();
      const header = response.headers.get('content-length');
      // 没有 content-length（分块传输）是允许的；一旦声明了，就必须与正文一致。
      if (header !== null) expect(Number(header)).toBe(new TextEncoder().encode(body).length);
      // 正文必须是完整的文档，不能被截在半截。
      expect(body.trimEnd().endsWith('</html>')).toBe(true);
    }
  });

  it('路由段大小写不敏感，但 id 段按原样查（含大写的 id 不能丢 meta）', async () => {
    // /ME 与 /me 是同一个页面，都要 noindex。
    expect(meta(await (await server.app.request('/ME')).text(), 'robots')).toBe('noindex, follow');
    expect(meta(await (await server.app.request('/Admin')).text(), 'robots')).toBe('noindex, follow');

    // id 段不能跟着小写：飞书导入的文章 id 是 `feishu-<originKey>`，
    // originKey 可能含大写。小写化会查不到那行，canonical 掉回首页、noindex 也丢。
    const data = server.store.get('post', 'post-1')!;
    const id = 'feishu-recABC';
    server.store.put('post', id, { ...data, id, title: '大写 id 的文章', source: 'submission' });
    const html = await (await server.app.request(`/posts/${id}`)).text();
    expect(html).toContain('大写 id 的文章');
    expect(canonical(html)).toBe(`https://example.test/posts/${id}`);
    // 投稿来源必须仍是 noindex——掉回首页 meta 时这条会一起丢。
    expect(meta(html, 'robots')).toBe('noindex, follow');
    server.store.markRemoved('post', id, new Date().toISOString());
  });

  it('畸形百分号编码不返回 500', async () => {
    // decodeURIComponent('%E0%A4%A') 抛 URIError。那是 400 级的输入错误，
    // 不该变成 500——不能因为有人在地址栏乱敲就整站报错。
    for (const path of ['/posts/%E0%A4%A', '/stations/%FF%FE', '/models/%ZZ']) {
      const response = await server.app.request(path);
      expect([200, 400]).toContain(response.status);
    }
  });

  it('RSS 里带控制字符的正文不会破坏 XML', async () => {
    const register = await server.app.request('/api/auth/register', {
      method: 'POST', headers: json, body: JSON.stringify({ username: 'ctrl', password: PASSWORD, nickname: '控制符' }),
    });
    const cookie = (register.headers.get('set-cookie') ?? '').split(';')[0];
    const created = await server.app.request('/api/posts', {
      method: 'POST', headers: { ...json, cookie },
      body: JSON.stringify({ kind: 'community', title: '控制符\u0001测试', summary: '摘要\u0007', body: '正文' }),
    });
    const id = (await created.json() as { id: string }).id;
    await server.app.request(`/api/admin/posts/${id}/review`, {
      method: 'POST', headers: bearer, body: JSON.stringify({ status: 'approved' }),
    });

    // 再加一条含 U+FFFE（非字符）与孤立代理项的：只清 C0 时这类仍会整份 feed 解析失败。
    const nasty = await server.app.request('/api/posts', {
      method: 'POST', headers: { ...json, cookie },
      body: JSON.stringify({ kind: 'community', title: '非字符\uFFFE测试', summary: '摘要', body: '正文' }),
    });
    const nastyId = (await nasty.json() as { id: string }).id;
    await server.app.request(`/api/admin/posts/${nastyId}/review`, {
      method: 'POST', headers: bearer, body: JSON.stringify({ status: 'approved' }),
    });

    const body = await (await server.app.request('/rss.xml')).text();
    // XML 1.0 明文禁止的字符一个都不能出现（C0 控制符 + 非字符）。
    expect(body).not.toMatch(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/);
    expect(body).toContain('控制符测试');
    expect(body).toContain('非字符测试');
    expect(body).toContain(id);
  });

  it('sitemap 与 RSS 的收录判据一致，且采集来的文章两边都不收', async () => {
    // 先造一篇「站内用户写的」（两边都该收），再造一篇 agent 来源的（两边都不该收）。
    const register = await server.app.request('/api/auth/register', {
      method: 'POST', headers: json, body: JSON.stringify({ username: 'collect', password: PASSWORD, nickname: '采集' }),
    });
    const cookie = (register.headers.get('set-cookie') ?? '').split(';')[0];
    const mine = await server.app.request('/api/posts', {
      method: 'POST', headers: { ...json, cookie },
      body: JSON.stringify({ kind: 'community', title: '本人写的', summary: 's', body: 'b' }),
    });
    const mineId = (await mine.json() as { id: string }).id;
    await server.app.request(`/api/admin/posts/${mineId}/review`, {
      method: 'POST', headers: bearer, body: JSON.stringify({ status: 'approved' }),
    });

    // 采集来源：直接把实体改成 source=agent，模拟 Agent 通道物化出来的文章。
    const data = server.store.get('post', mineId)!;
    server.store.put('post', mineId, { ...data, source: 'agent' });
    const sitemapAfter = await (await server.app.request('/sitemap.xml')).text();
    const rssAfter = await (await server.app.request('/rss.xml')).text();
    expect(sitemapAfter).not.toContain(mineId);
    expect(rssAfter).not.toContain(mineId);
    // 页面本身仍可打开，但带 noindex。
    const html = await (await server.app.request(`/posts/${mineId}`)).text();
    expect(meta(html, 'robots')).toBe('noindex, follow');

    // 改回 user 后两边都收，且双向一致。
    server.store.put('post', mineId, { ...data, source: 'user' });
    const sitemap = await (await server.app.request('/sitemap.xml')).text();
    const rss = await (await server.app.request('/rss.xml')).text();
    expect(sitemap).toContain(mineId);
    expect(rss).toContain(mineId);
  });
});
