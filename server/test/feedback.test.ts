import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/node-app.ts';

const PASSWORD = 'correct-horse-battery';
const TOKEN = 'x'.repeat(32);
let server: ReturnType<typeof createApp>;
let clock: Date;

beforeEach(() => {
  clock = new Date('2026-11-25T02:00:00.000Z');
  server = createApp({ dbPath: ':memory:', syncToken: TOKEN, now: () => clock });
});

async function account(username: string) {
  const registered = await server.app.request('/api/auth/register', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password: PASSWORD }),
  });
  expect(registered.status).toBe(200);
  const cookie = registered.headers.get('set-cookie')!.split(';')[0];
  return {
    call: (method: string, path: string, body?: unknown) => server.app.request(path, {
      method, headers: { 'content-type': 'application/json', cookie },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  };
}

/** 站点只能通过目录导入创建（没有「手动建站」的接口），这里走同一条路。 */
async function importStations(slugs: string[]) {
  const body = {
    // 导入的 slug 必须带 sub- 前缀，url 必填——这是目录导入的既有契约。
    stations: slugs.map(slug => ({
      slug: `sub-${slug}`, name: `站 ${slug}`, description: '测试站',
      url: `https://${slug}.example.com/`, rechargeThreshold: null, paymentMethods: [], offers: [],
    })),
    posts: [],
  };
  const response = await server.app.request('/api/admin/import', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify(body),
  });
  expect(response.status).toBe(200);
}

async function withStation() {
  await importStations(['real-station']);
  return 'sub-real-station';
}

describe('站点一句话反馈', () => {
  it('能发、能看、能删自己的；别人删不了', async () => {
    const slug = await withStation();
    const alice = await account('alice');
    const posted = await alice.call('POST', '/api/feedback', { stationSlug: slug, verdict: 'slow', content: '晚上有点慢' });
    expect(posted.status).toBe(200);
    const created = await posted.json() as { id: string; mine: boolean; verdict: string; verified: boolean };
    expect(created).toMatchObject({ mine: true, verdict: 'slow' });
    // 「未经平台核实」必须是响应里的可断言事实，不只是页面文案。
    expect(created.verified).toBe(false);

    const bob = await account('bob');
    const listed = await (await bob.call('GET', `/api/feedback?stationSlug=${slug}`)).json() as {
      items: Array<{ id: string; content: string; mine: boolean; author: { nickname: string } }>; total: number;
    };
    expect(listed.total).toBe(1);
    expect(listed.items[0]).toMatchObject({ content: '晚上有点慢', mine: false });
    expect(listed.items[0].author.nickname).toBe('alice');

    // 别人删不了，而且是 404 而不是 403——不区分「不存在」会让 id 变成探针。
    expect((await bob.call('DELETE', `/api/feedback/${created.id}`)).status).toBe(404);
    expect((await alice.call('DELETE', `/api/feedback/${created.id}`)).status).toBe(200);
    expect((await (await alice.call('GET', `/api/feedback?stationSlug=${slug}`)).json() as { total: number }).total).toBe(0);
  });

  it('同一个站一天只能留一条；换站可以（但撞每日总配额）', async () => {
    const slug = await withStation();
    const alice = await account('alice');
    expect((await alice.call('POST', '/api/feedback', { stationSlug: slug, verdict: 'works', content: '还行' })).status).toBe(200);
    const again = await alice.call('POST', '/api/feedback', { stationSlug: slug, verdict: 'works', content: '再来一条' });
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ error: { code: 'ALREADY_FEEDBACK' } });
  });

  it('每天 20 条封顶，第二天恢复', async () => {
    const slug = await withStation();
    const alice = await account('alice');
    // 造 20 个站，一天之内每个站各留一条。
    // 导入是全量替换，所以要一次导完。
    await importStations(['real-station', ...Array.from({ length: 20 }, (_, index) => `station-${index}`)]);
    for (let index = 0; index < 20; index++) {
      const other = `sub-station-${index}`;
      // 每条之间推进 61 分钟：严格大于一小时窗口，专测每日配额。
      // 之前用 13 分钟，其实一直是在撞「每小时 5 条」，根本没测到每天 20 条。
      clock = new Date(clock.getTime() + 3_660_000);
      expect((await alice.call('POST', '/api/feedback', { stationSlug: other, verdict: 'works', content: `第 ${index} 条` })).status).toBe(200);
    }
    const blocked = await alice.call('POST', '/api/feedback', { stationSlug: slug, verdict: 'works', content: '第 21 条' });
    expect(blocked.status).toBe(429);
    expect(await blocked.json()).toMatchObject({ error: { code: 'RATE_LIMITED' } });

    clock = new Date(clock.getTime() + 86_400_000);
    expect((await alice.call('POST', '/api/feedback', { stationSlug: slug, verdict: 'works', content: '第二天' })).status).toBe(200);
  });

  it('删掉自己那条不会把配额退回来（否则提交→删除可以无限刷）', async () => {
    const slug = await withStation();
    const alice = await account('alice');
    const posted = await alice.call('POST', '/api/feedback', { stationSlug: slug, verdict: 'works', content: '第一条' });
    expect(posted.status).toBe(200);
    const { id } = await posted.json() as { id: string };
    expect((await alice.call('DELETE', `/api/feedback/${id}`)).status).toBe(200);
    // 删完之后列表里没有了……注意要同时断言 items 与 total：
    // 只断言 total 的话，行查询漏加 deletedAt 过滤（items 里仍有墓碑）也不会被发现。
    const afterDelete = await (await alice.call('GET', `/api/feedback?stationSlug=${slug}`)).json() as {
      items: Array<{ id: string }>; total: number;
    };
    expect(afterDelete.total).toBe(0);
    expect(afterDelete.items).toEqual([]);
    // ……但同一天同一站不能再发：额度没有因为删除而恢复。
    const again = await alice.call('POST', '/api/feedback', { stationSlug: slug, verdict: 'works', content: '删除后再发' });
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ error: { code: 'ALREADY_FEEDBACK' } });
  });

  it('删两次是幂等的，不报错也不改时间', async () => {
    const slug = await withStation();
    const alice = await account('alice');
    const { id } = await (await alice.call('POST', '/api/feedback', { stationSlug: slug, verdict: 'slow', content: 'x' })).json() as { id: string };
    expect((await alice.call('DELETE', `/api/feedback/${id}`)).status).toBe(200);
    clock = new Date(clock.getTime() + 3_600_000);
    expect((await alice.call('DELETE', `/api/feedback/${id}`)).status).toBe(200);
  });

  it('一小时 5 条封顶（不同站点也拦）', async () => {
    // 导入是全量替换：真实站和 5 个提速站必须在同一批里。
    await importStations(['real-station', ...Array.from({ length: 5 }, (_, index) => `fast-${index}`)]);
    const alice = await account('alice');
    for (let index = 0; index < 5; index++) {
      const other = `sub-fast-${index}`;
      expect((await alice.call('POST', '/api/feedback', { stationSlug: other, verdict: 'works', content: `第 ${index} 条` })).status).toBe(200);
    }
    expect((await alice.call('POST', '/api/feedback', { stationSlug: 'sub-real-station', verdict: 'works', content: '第 6 条' })).status).toBe(429);
  });

  it('演示站不能留反馈；内容为空被拒', async () => {
    // 演示模式下 seeded 的站 source='demo'：对虚构样例留「挂了」没有意义。
    const seeded = createApp({ dbPath: ':memory:', syncToken: TOKEN, siteMode: 'demo', now: () => clock });
    const registered = await seeded.app.request('/api/auth/register', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'bob', password: PASSWORD }),
    });
    const cookie = registered.headers.get('set-cookie')!.split(';')[0];
    const call = (body: unknown) => seeded.app.request('/api/feedback', {
      method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify(body),
    });
    const stations = await (await seeded.app.request('/api/stations?pageSize=1')).json() as { items: Array<{ slug: string; source: string }> };
    expect(stations.items[0].source).toBe('demo');
    const demo = await call({ stationSlug: stations.items[0].slug, verdict: 'works', content: 'x' });
    expect(demo.status).toBe(400);
    expect(await demo.json()).toMatchObject({ error: { message: '演示站点不需要反馈' } });
  });
});

describe('游客能读，不能写', () => {
  it('未登录也能看到别人留下的一句话反馈（列表不是私有数据）', async () => {
    const slug = await withStation();
    const alice = await account('alice');
    expect((await alice.call('POST', '/api/feedback', { stationSlug: slug, verdict: 'works', content: '能用' })).status).toBe(200);

    // 完全不带 cookie。
    const anonymous = await server.app.request(`/api/feedback?stationSlug=${slug}`);
    expect(anonymous.status).toBe(200);
    const listed = await anonymous.json() as { items: Array<{ content: string; mine: boolean }>; total: number };
    expect(listed.total).toBe(1);
    expect(listed.items[0]).toMatchObject({ content: '能用', mine: false });
  });

  it('未登录不能发、不能删', async () => {
    const slug = await withStation();
    expect((await server.app.request('/api/feedback', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ stationSlug: slug, verdict: 'works', content: 'x' }),
    })).status).toBe(401);
    expect((await server.app.request('/api/feedback/whatever', { method: 'DELETE' })).status).toBe(401);
  });
});
