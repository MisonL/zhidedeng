import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/node-app.ts';

const PASSWORD = 'correct-horse-battery';
let server: ReturnType<typeof createApp>;

beforeEach(() => {
  server = createApp({ dbPath: ':memory:', syncToken: 'x'.repeat(32) });
});

async function account(username: string) {
  const registered = await server.app.request('/api/auth/register', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password: PASSWORD }),
  });
  expect(registered.status).toBe(200);
  return {
    me: await registered.json() as { handle: string },
    cookie: registered.headers.get('set-cookie')!.split(';')[0],
  };
}

describe('作者主页接口', () => {
  it('给出公开资料与统计；不存在的作者 404', async () => {
    const alice = await account('alice');
    const profile = await server.app.request(`/api/users/${alice.me.handle}`);
    expect(profile.status).toBe(200);
    expect(await profile.json()).toMatchObject({
      handle: alice.me.handle, shareCount: 0, upCount: 0,
    });
    // 注册时间来自 users 表，不能是 null——那是「有账号却查不到注册时间」。
    const body = await (await server.app.request(`/api/users/${alice.me.handle}`)).json() as { joinedAt: string | null };
    expect(body.joinedAt).toBeTruthy();

    // 拼错的 handle 必须是 404，而不是一个看起来正常的空主页。
    expect((await server.app.request('/api/users/nobody-here')).status).toBe(404);
  });

  it('按作者过滤文章：只出这个人的，别人的不出', async () => {
    const alice = await account('alice');
    const bob = await account('bob');
    const submit = async (cookie: string, title: string) => {
      const created = await server.app.request('/api/posts', {
        method: 'POST', headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ kind: 'community', title, summary: `摘要 ${title}`, body: `正文 ${title}` }),
      });
      expect(created.status).toBe(200);
      const { id } = await created.json() as { id: string };
      expect((await server.app.request(`/api/admin/posts/${id}/review`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${'x'.repeat(32)}` },
        body: JSON.stringify({ status: 'approved' }),
      })).status).toBe(200);
      return id;
    };
    await submit(alice.cookie, '爱丽丝的评测');
    await submit(bob.cookie, '鲍勃的评测');

    const onlyAlice = await (await server.app.request(`/api/posts?author=${alice.me.handle}`)).json() as { items: Array<{ title: string }>; total: number };
    expect(onlyAlice.total).toBe(1);
    expect(onlyAlice.items.map(item => item.title)).toEqual(['爱丽丝的评测']);

    const profile = await (await server.app.request(`/api/users/${alice.me.handle}`)).json() as { shareCount: number };
    expect(profile.shareCount).toBe(1);
  });

  it('作者被下架的文章不计入主页篇数', async () => {
    const alice = await account('alice');
    const created = await server.app.request('/api/posts', {
      method: 'POST', headers: { 'content-type': 'application/json', cookie: alice.cookie },
      body: JSON.stringify({ kind: 'community', title: '会被下架', summary: '摘要', body: '正文' }),
    });
    const { id } = await created.json() as { id: string };
    expect((await server.app.request(`/api/admin/posts/${id}/review`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${'x'.repeat(32)}` },
      body: JSON.stringify({ status: 'approved' }),
    })).status).toBe(200);
    expect((await (await server.app.request(`/api/users/${alice.me.handle}`)).json() as { shareCount: number }).shareCount).toBe(1);

    expect((await server.app.request(`/api/admin/posts/${id}/withdraw`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${'x'.repeat(32)}` },
      body: JSON.stringify({ note: '违规' }),
    })).status).toBe(200);
    // 下架之后主页不该还数着它，否则点进去 404。
    expect((await (await server.app.request(`/api/users/${alice.me.handle}`)).json() as { shareCount: number }).shareCount).toBe(0);
  });
});

describe('站点详情的社区最后确认', () => {
  it('列表和详情给出同一个时间（不能列表有、详情 null）', async () => {
    const admin = { 'content-type': 'application/json', authorization: `Bearer ${'x'.repeat(32)}` };
    const imported = await server.app.request('/api/admin/import', {
      method: 'POST', headers: admin,
      body: JSON.stringify({
        stations: [{
          slug: 'sub-time-station', name: '有时间线的站', description: 'd',
          url: 'https://t.example.com/', rechargeThreshold: null, paymentMethods: [], offers: [],
        }],
        posts: [],
      }),
    });
    expect(imported.status).toBe(200);
    const bob = await account('bob');
    expect((await server.app.request('/api/comments', {
      method: 'POST', headers: { 'content-type': 'application/json', cookie: bob.cookie },
      body: JSON.stringify({ targetType: 'station', targetId: 'sub-time-station', content: '刚充了 10 块，能用' }),
    })).status).toBe(200);

    const listed = await (await server.app.request('/api/stations?pageSize=50')).json() as {
      items: Array<{ slug: string; lastConfirmedAt: string | null }>;
    };
    const fromList = listed.items.find(item => item.slug === 'sub-time-station')!.lastConfirmedAt;
    expect(fromList).toBeTruthy();

    const detail = await (await server.app.request('/api/stations/sub-time-station')).json() as { lastConfirmedAt: string | null };
    // 详情页曾经是 null：getStation 没把预取表传进去，同一份数据两处不一致。
    expect(detail.lastConfirmedAt).toBe(fromList);
  });

  it('没有任何评论时是 null，不拿别的字段冒充', async () => {
    const admin = { 'content-type': 'application/json', authorization: `Bearer ${'x'.repeat(32)}` };
    await server.app.request('/api/admin/import', {
      method: 'POST', headers: admin,
      body: JSON.stringify({
        stations: [{
          slug: 'sub-quiet-station', name: '没人聊的站', description: 'd',
          url: 'https://q.example.com/', rechargeThreshold: null, paymentMethods: [], offers: [],
        }],
        posts: [],
      }),
    });
    const detail = await (await server.app.request('/api/stations/sub-quiet-station')).json() as { lastConfirmedAt: string | null };
    expect(detail.lastConfirmedAt).toBeNull();
  });
});
