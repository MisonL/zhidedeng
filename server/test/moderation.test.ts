import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Comment, CurrentUser, GetMyFavoritesResponse, GetPostsResponse, GetRankingsResponse, Post, SearchResponse, StationDetail } from '@zhidedeng/shared';
import { createApp } from '../src/node-app.ts';

const json = { 'content-type': 'application/json' };
const TOKEN = 'admin-token-for-tests-0123456789abcdef';
const bearer = { ...json, authorization: `Bearer ${TOKEN}` };

let clock: Date;
let server: ReturnType<typeof createApp>;
beforeEach(() => {
  clock = new Date('2026-11-06T01:00:00Z');
  server = createApp({ dbPath: ':memory:', now: () => clock, syncToken: TOKEN });
});
afterEach(() => server.db.close());

async function account(username: string) {
  const registered = await server.app.request('/api/auth/register', { method: 'POST', headers: json, body: JSON.stringify({ username, password: 'correct-horse-battery' }) });
  expect(registered.status).toBe(200);
  const headers = { ...json, cookie: registered.headers.get('set-cookie')!.split(';')[0] };
  return {
    call: (method: string, path: string, body?: unknown) => server.app.request(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }),
    get: async <T,>(path: string) => await (await server.app.request(path, { headers })).json() as T,
  };
}

const anonymous = {
  call: (method: string, path: string, body?: unknown) => server.app.request(path, { method, headers: json, body: body === undefined ? undefined : JSON.stringify(body) }),
  get: async <T,>(path: string) => await (await server.app.request(path)).json() as T,
};

const admin = (path: string, body?: unknown, method = 'POST') => server.app.request(path, { method, headers: bearer, body: body === undefined ? undefined : JSON.stringify(body) });

const newPost = (title: string, extra: object = {}) => ({ kind: 'community', title, summary: `${title}摘要`, body: `${title}正文`, stationSlug: 'whale-demo', modelSlug: 'gpt-4-1', ...extra });

async function submit(author: Awaited<ReturnType<typeof account>>, title: string) {
  const response = await author.call('POST', '/api/posts', newPost(title));
  expect(response.status).toBe(200);
  return await response.json() as Post;
}

describe('投稿审核', () => {
  it('新投稿是 pending，作者在我的分享里看得到，详情也能看', async () => {
    const a = await account('alice');
    const post = await submit(a, '待审帖');
    expect(post.status).toBe('pending');
    const mine = await a.get<GetPostsResponse>('/api/me/posts');
    expect(mine.items.map(p => [p.id, p.status])).toEqual([[post.id, 'pending']]);
    expect((await a.call('GET', `/api/posts/${post.id}`)).status).toBe(200);
    expect((await a.get<CurrentUser>('/api/me')).shareCount).toBe(1);
  });

  it('种子和群友提交视为 approved', async () => {
    expect((await anonymous.get<Post>('/api/posts/post-1')).status).toBe('approved');
    const { items } = await anonymous.get<GetPostsResponse>('/api/posts?pageSize=50');
    // every 对空数组恒为真——没有条目时这个断言等于什么都没测。
    expect(items.length).toBeGreaterThan(0);
    expect(items.every(p => p.status === 'approved')).toBe(true);
  });

  it('他人的 pending 内容在任何读接口都不泄露', async () => {
    const a = await account('alice');
    const b = await account('bobby');
    const post = await submit(a, '秘密待审帖');
    const before = await anonymous.get<GetPostsResponse>('/api/posts?pageSize=50');
    const expertBefore = await anonymous.get<GetRankingsResponse>('/api/rankings?tab=expert&pageSize=50');

    for (const reader of [b, anonymous]) {
      expect((await reader.call('GET', `/api/posts/${post.id}`)).status).toBe(404);
      expect((await reader.call('GET', `/api/comments?targetType=post&targetId=${post.id}`)).status).toBe(404);
      for (const path of [
        '/api/posts?pageSize=50', '/api/posts?sort=hot&pageSize=50', '/api/posts?kind=community&pageSize=50',
        '/api/posts?station=whale-demo&pageSize=50', '/api/posts?model=gpt-4-1&pageSize=50', '/api/posts?vendor=openai&pageSize=50',
        `/api/posts?q=${encodeURIComponent('秘密待审帖')}`, `/api/search?q=${encodeURIComponent('秘密待审帖')}`,
        '/api/rankings?tab=community&pageSize=50', '/api/rankings?tab=expert&pageSize=50',
      ]) {
        const text = JSON.stringify(await reader.get(path));
        expect(text, path).not.toContain('秘密待审帖');
        expect(text, path).not.toContain(post.id);
      }
    }
    expect((await anonymous.get<GetPostsResponse>('/api/posts?pageSize=50')).total).toBe(before.total);
    expect(await anonymous.get<GetRankingsResponse>('/api/rankings?tab=expert&pageSize=50')).toEqual(expertBefore);
    const searched = await b.get<SearchResponse>(`/api/search?q=${encodeURIComponent('秘密待审帖')}`);
    expect(searched.posts).toEqual([]);
  });

  it('作者自己的公开列表、搜索和榜单里也不出现 pending，只在我的分享里', async () => {
    const a = await account('alice');
    await submit(a, '秘密待审帖');
    for (const path of ['/api/posts?pageSize=50', `/api/search?q=${encodeURIComponent('秘密待审帖')}`, '/api/rankings?tab=community&pageSize=50']) {
      expect(JSON.stringify(await a.get(path)), path).not.toContain('秘密待审帖');
    }
  });

  it('他人不能对 pending 投票、收藏、评论', async () => {
    const a = await account('alice');
    const b = await account('bobby');
    const post = await submit(a, '待审帖');
    const target = { targetType: 'post', targetId: post.id };
    expect((await b.call('PUT', '/api/votes', { ...target, value: 'up' })).status).toBe(404);
    expect((await b.call('PUT', '/api/favorites', { ...target, favorited: true })).status).toBe(404);
    expect((await b.call('POST', '/api/comments', { ...target, content: '越权' })).status).toBe(404);
  });

  it('通过后对所有人公开，榜单和搜索都有', async () => {
    const a = await account('alice');
    const post = await submit(a, '已通过的帖子');
    expect((await admin(`/api/admin/posts/${post.id}/review`, { status: 'approved' })).status).toBe(200);
    expect(await anonymous.get<Post>(`/api/posts/${post.id}`)).toMatchObject({ status: 'approved', author: { handle: 'alice' }, source: 'user' });
    expect((await anonymous.get<GetPostsResponse>(`/api/posts?q=${encodeURIComponent('已通过的帖子')}`)).total).toBe(1);
    const expert = await anonymous.get<GetRankingsResponse>('/api/rankings?tab=expert&pageSize=50');
    expect(JSON.stringify(expert)).toContain('alice');
  });

  it('拒绝后只有作者可见，我的分享标 rejected', async () => {
    const a = await account('alice');
    const post = await submit(a, '被拒帖');
    expect((await admin(`/api/admin/posts/${post.id}/review`, { status: 'rejected' })).status).toBe(200);
    expect((await anonymous.call('GET', `/api/posts/${post.id}`)).status).toBe(404);
    expect((await a.get<GetPostsResponse>('/api/me/posts')).items[0].status).toBe('rejected');
  });

  it('撤下已公开的帖子后，别人的收藏列表不崩也不计数', async () => {
    const a = await account('alice');
    const b = await account('bobby');
    const post = await submit(a, '会被撤下的帖子');
    await admin(`/api/admin/posts/${post.id}/review`, { status: 'approved' });
    await b.call('PUT', '/api/favorites', { targetType: 'post', targetId: post.id, favorited: true });
    expect((await b.get<CurrentUser>('/api/me')).favoriteCount).toBe(1);
    await admin(`/api/admin/posts/${post.id}/review`, { status: 'rejected' });
    const favorites = await b.call('GET', '/api/me/favorites');
    expect(favorites.status).toBe(200);
    expect((await favorites.json() as GetMyFavoritesResponse).total).toBe(0);
    expect((await b.get<CurrentUser>('/api/me')).favoriteCount).toBe(0);
  });

  it('管理接口能列出待审投稿', async () => {
    const a = await account('alice');
    const post = await submit(a, '待审帖');
    const response = await admin('/api/admin/posts?status=pending', undefined, 'GET');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ items: [{ id: post.id, title: '待审帖', authorHandle: 'alice', status: 'pending' }] });
  });
});

describe('评论', () => {
  it('登录后发布即公开，别的账号和匿名都看得到，可以互相回复', async () => {
    const a = await account('alice');
    const b = await account('bobby');
    const target = { targetType: 'post', targetId: 'post-1' };
    const comment = await (await a.call('POST', '/api/comments', { ...target, content: 'A 的评论' })).json() as Comment;
    const reply = await b.call('POST', '/api/comments', { ...target, parentId: comment.id, content: 'B 回复 A' });
    expect(reply.status).toBe(200);
    const list = await anonymous.get<{ items: Comment[] }>('/api/comments?targetType=post&targetId=post-1');
    const found = list.items.find(c => c.id === comment.id)!;
    expect(found.author.handle).toBe('alice');
    expect(found.replies.map(r => r.content)).toEqual(['B 回复 A']);
  });

  it('每账号每分钟最多 5 条，超过返回 429，下一分钟恢复，不影响别的账号', async () => {
    const a = await account('alice');
    const b = await account('bobby');
    const send = (who: typeof a) => who.call('POST', '/api/comments', { targetType: 'post', targetId: 'post-1', content: '刷屏' });
    for (let index = 0; index < 5; index++) expect((await send(a)).status).toBe(200);
    const limited = await send(a);
    expect(limited.status).toBe(429);
    expect(await limited.json()).toMatchObject({ error: { code: 'RATE_LIMITED' } });
    expect((await send(b)).status).toBe(200);
    clock = new Date(clock.getTime() + 61_000);
    expect((await send(a)).status).toBe(200);
  });

  it('管理接口隐藏评论后：列表、计数都没有，回复随之消失，不能再回复；可以恢复', async () => {
    const a = await account('alice');
    const b = await account('bobby');
    const target = { targetType: 'station', targetId: 'whale-demo' };
    const before = (await anonymous.get<StationDetail>('/api/stations/whale-demo')).commentCount;
    const comment = await (await a.call('POST', '/api/comments', { ...target, content: '违规内容' })).json() as Comment;
    await b.call('POST', '/api/comments', { ...target, parentId: comment.id, content: '回复违规内容' });
    expect((await anonymous.get<StationDetail>('/api/stations/whale-demo')).commentCount).toBe(before + 2);

    expect((await admin(`/api/admin/comments/${comment.id}/hide`, { hidden: true })).status).toBe(200);

    const text = JSON.stringify(await anonymous.get('/api/comments?targetType=station&targetId=whale-demo'));
    expect(text).not.toContain('违规内容');
    expect((await anonymous.get<StationDetail>('/api/stations/whale-demo')).commentCount).toBe(before);
    expect((await b.call('POST', '/api/comments', { ...target, parentId: comment.id, content: '再回复' })).status).toBe(400);

    expect((await admin(`/api/admin/comments/${comment.id}/hide`, { hidden: false })).status).toBe(200);
    expect(JSON.stringify(await anonymous.get('/api/comments?targetType=station&targetId=whale-demo'))).toContain('违规内容');
  });

  it('隐藏回复只影响那条回复', async () => {
    const a = await account('alice');
    const target = { targetType: 'station', targetId: 'whale-demo' };
    const comment = await (await a.call('POST', '/api/comments', { ...target, content: '主评论' })).json() as Comment;
    const reply = await (await a.call('POST', '/api/comments', { ...target, parentId: comment.id, content: '违规回复' })).json() as Comment;
    await admin(`/api/admin/comments/${reply.id}/hide`, { hidden: true });
    const text = JSON.stringify(await anonymous.get('/api/comments?targetType=station&targetId=whale-demo'));
    expect(text).toContain('主评论');
    expect(text).not.toContain('违规回复');
  });
});

describe('管理接口鉴权', () => {
  const routes: [string, string, unknown][] = [
    ['POST', '/api/admin/import', { stations: [], posts: [] }],
    ['GET', '/api/admin/posts?status=pending', undefined],
    ['POST', '/api/admin/posts/post-1/review', { status: 'rejected' }],
    ['POST', '/api/admin/comments/x/hide', { hidden: true }],
  ];

  it.each(routes)('%s %s：无 token 401，错 token 403，普通登录用户也不行', async (method, path, body) => {
    const send = (headers: Record<string, string>) => server.app.request(path, { method, headers: { ...json, ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    expect((await send({})).status).toBe(401);
    expect((await send({ authorization: 'Bearer wrong' })).status).toBe(403);
    const a = await account('alice');
    expect((await a.call(method, path, body)).status).toBe(401);
    expect((await anonymous.get<Post>('/api/posts/post-1')).status).toBe('approved');
  });

  it('未配置 SYNC_TOKEN 时一律拒绝', async () => {
    const closed = createApp({ dbPath: ':memory:', syncToken: '' });
    try {
      const response = await closed.app.request('/api/admin/import', { method: 'POST', headers: bearer, body: '{"stations":[],"posts":[]}' });
      expect(response.status).toBe(403);
    } finally {
      closed.db.close();
    }
  });

  it('审核不存在的对象返回 404，非法状态返回 400', async () => {
    expect((await admin('/api/admin/posts/missing/review', { status: 'approved' })).status).toBe(404);
    expect((await admin('/api/admin/comments/missing/hide', { hidden: true })).status).toBe(404);
    expect((await admin('/api/admin/posts/post-1/review', { status: 'whatever' })).status).toBe(400);
  });

  it('普通写路径不能写入站点数据', async () => {
    const a = await account('alice');
    const before = (await anonymous.get<GetPostsResponse>('/api/posts?pageSize=50')).total;
    await a.call('POST', '/api/posts', newPost('普通投稿'));
    expect((await anonymous.get<GetPostsResponse>('/api/posts?pageSize=50')).total).toBe(before);
    expect((await anonymous.call('GET', '/api/stations/sub-a-com')).status).toBe(404);
  });
});

describe('导入接口', () => {
  const submission = {
    stations: [{ slug: 'sub-a-com', name: '示例站', description: 'd', url: 'https://a.com/', rechargeThreshold: null, paymentMethods: [], offers: [{ modelSlug: 'o3', rate: 0.5 }] }],
    posts: [{ recordId: 'rec1', stationSlug: 'sub-a-com', title: 't', summary: 's', body: 'b', authorName: '群友', publishedAt: '2026-11-04T08:00:00.000Z' }],
  };

  it('导入后所有人可见；不碰账号、投票、评论、投稿；撤销后消失，收藏隐藏，重新通过后恢复', async () => {
    const a = await account('alice');
    await a.call('PATCH', '/api/me', { nickname: 'A' });
    await a.call('POST', '/api/me/checkin', {});
    const own = await submit(a, '我的投稿');
    await a.call('POST', '/api/comments', { targetType: 'station', targetId: 'whale-demo', content: 'A 的评论' });
    await a.call('PUT', '/api/votes', { targetType: 'station', targetId: 'whale-demo', value: 'down' });
    const me = await a.get<CurrentUser>('/api/me');

    expect((await admin('/api/admin/import', submission)).status).toBe(200);
    expect(await anonymous.get<StationDetail>('/api/stations/sub-a-com')).toMatchObject({ lowestRate: 0.5, source: 'submission' });
    expect(await a.get<CurrentUser>('/api/me')).toEqual(me);
    expect((await a.call('GET', `/api/posts/${own.id}`)).status).toBe(200);
    expect((await a.get<StationDetail>('/api/stations/whale-demo')).currentUserVote).toBe('down');

    await a.call('PUT', '/api/favorites', { targetType: 'station', targetId: 'sub-a-com', favorited: true });
    await a.call('PUT', '/api/favorites', { targetType: 'post', targetId: 'feishu-rec1', favorited: true });
    await a.call('POST', '/api/comments', { targetType: 'station', targetId: 'sub-a-com', content: 'B 站评论' });

    expect(await (await admin('/api/admin/import', submission)).json()).toMatchObject({ changed: false });
    expect((await anonymous.get<GetPostsResponse>('/api/posts?station=sub-a-com')).total).toBe(1);

    expect((await admin('/api/admin/import', { stations: [], posts: [] })).status).toBe(200);
    expect((await anonymous.call('GET', '/api/stations/sub-a-com')).status).toBe(404);
    expect((await anonymous.call('GET', '/api/posts/feishu-rec1')).status).toBe(404);
    const favorites = await a.call('GET', '/api/me/favorites');
    expect(favorites.status).toBe(200);
    expect((await favorites.json() as GetMyFavoritesResponse).total).toBe(0);
    expect((await a.get<CurrentUser>('/api/me')).favoriteCount).toBe(0);

    await admin('/api/admin/import', submission);
    expect((await a.get<StationDetail>('/api/stations/sub-a-com')).favorited).toBe(true);
    expect((await a.get<CurrentUser>('/api/me')).favoriteCount).toBe(2);
    expect(JSON.stringify(await anonymous.get('/api/comments?targetType=station&targetId=sub-a-com'))).toContain('B 站评论');
  });

  it('导入请求体过大返回 413，普通接口上限更小', async () => {
    const big = 'x'.repeat(9 * 1024 * 1024);
    expect((await server.app.request('/api/admin/import', { method: 'POST', headers: { ...bearer, 'content-length': String(big.length) }, body: big })).status).toBe(413);
    const a = await account('alice');
    const large = 'x'.repeat(600 * 1024);
    const response = await a.call('POST', '/api/posts', { ...newPost('t'), body: large });
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ error: { code: 'PAYLOAD_TOO_LARGE' } });
  });
});

describe('GET /api/health', () => {
  it('不需要登录，也不写库', async () => {
    const response = await server.app.request('/api/health');
    expect(response.status).toBe(200);
    // checks 里会逐项列出检查了什么，方便排障时判断是哪一层坏了。
    expect(await response.json()).toEqual({ status: 'ok', checks: { database: 'ok' } });
    expect(response.headers.get('set-cookie')).toBeNull();
  });
});

describe('GET /api/health 的静态资源检查', () => {
  it('前端入口缺失时返回 503，不再谎报健康', async () => {
    // 容器里只查 SELECT 1 的话，前端没挂上时健康检查照样通过，
    // deploy.sh 会报「部署完成」，用户打开却是白屏。
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'health-'));
    try {
      const bare = createApp({ dbPath: ':memory:', webRoot: dir });
      const response = await bare.app.request('/api/health');
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ status: 'degraded', checks: { frontend: 'missing' } });
      bare.db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
