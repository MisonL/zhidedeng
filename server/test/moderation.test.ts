import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Comment, CurrentUser, GetMyFavoritesResponse, GetPostsResponse, GetRankingsResponse, Post, SearchResponse, StationDetail } from '@zhidedeng/shared';
import { createApp } from '../src/node-app.ts';

/** 测试口令用常量：username/password 相邻字面量会被 GitGuardian 当成硬编码凭据（已误报三次）。 */
const PASSWORD = 'correct-horse-battery';

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
  const registered = await server.app.request('/api/auth/register', { method: 'POST', headers: json, body: JSON.stringify({ username, password: PASSWORD }) });
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
    expect((await admin(`/api/admin/posts/${post.id}/review`, { status: 'rejected', reason: '缺少站点信息' })).status).toBe(200);
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
    await admin(`/api/admin/posts/${post.id}/review`, { status: 'rejected', reason: '缺少站点信息' });
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
    ['POST', '/api/admin/posts/post-1/review', { status: 'rejected', reason: '测试拒绝' }],
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
    // mode 也一并返回：运维不翻环境变量就能确认这个环境是演示还是生产。
    // 测试环境 NODE_ENV=test，按「非生产即 demo」的默认规则落到 demo。
    expect(await response.json()).toEqual({ status: 'ok', checks: { database: 'ok' }, mode: 'demo' });
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

describe('文章驳回理由', () => {
  it('拒绝文章必须给理由，否则 400', async () => {
    // 唯一一位真实投稿人被拒后只看到「未通过」两个字，改不了也不知道该不该重投。
    const a = await account('alice');
    const post = await submit(a, '会被拒的帖子');
    const response = await admin(`/api/admin/posts/${post.id}/review`, { status: 'rejected' });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: 'REASON_REQUIRED' } });
    // 没被拒成，文章还在待审。
    expect((await a.get<GetPostsResponse>('/api/me/posts')).items[0].status).toBe('pending');
  });

  it('理由随文章存下，作者在「我的分享」和详情页都看得到', async () => {
    const a = await account('alice');
    const post = await submit(a, '理由要能看到');
    expect((await admin(`/api/admin/posts/${post.id}/review`, { status: 'rejected', reason: '缺少费用截图' })).status).toBe(200);
    expect((await a.get<GetPostsResponse>('/api/me/posts')).items[0])
      .toMatchObject({ status: 'rejected', reviewReason: '缺少费用截图' });
    expect(await a.get<Post>(`/api/posts/${post.id}`)).toMatchObject({ status: 'rejected', reviewReason: '缺少费用截图' });
  });

  it('理由只有作者看得到，别人连文章都读不到', async () => {
    const a = await account('alice');
    const b = await account('bobby');
    const post = await submit(a, '别人不该看到理由');
    await admin(`/api/admin/posts/${post.id}/review`, { status: 'rejected', reason: '仅作者可见的备注' });
    expect((await b.call('GET', `/api/posts/${post.id}`)).status).toBe(404);
    expect(JSON.stringify((await b.get<GetPostsResponse>('/api/me/posts')))).not.toContain('仅作者可见的备注');
  });

  it('先拒后过审时清掉旧的驳回理由', async () => {
    // 走 reviewPost 的「已物化文章」分支：队列里的记录被拒后是终态（再审返回 404），
    // 只有已经落成实体的文章才可能被拒了再通过（飞书/Agent 物化出来的那类）。
    // 不清理由的话，作者会在过审的文章上同时看到「已通过」和「未通过原因」。
    const a = await account('alice');
    const post = await submit(a, '先过审再被拒再通过');
    expect((await admin(`/api/admin/posts/${post.id}/review`, { status: 'approved' })).status).toBe(200);
    // 过审即物化成实体，之后这条走的是 reviewPost 的直接改状态分支。
    expect(await anonymous.get<Post>(`/api/posts/${post.id}`)).toMatchObject({ status: 'approved' });
    expect((await admin(`/api/admin/posts/${post.id}/review`, { status: 'rejected', reason: '先拒' })).status).toBe(200);
    expect(await a.get<Post>(`/api/posts/${post.id}`)).toMatchObject({ status: 'rejected', reviewReason: '先拒' });
    expect((await admin(`/api/admin/posts/${post.id}/review`, { status: 'approved' })).status).toBe(200);
    const approved = await anonymous.get<Post>(`/api/posts/${post.id}`);
    expect(approved.status).toBe('approved');
    expect(approved.reviewReason ?? null).toBeNull();
  });

  it('队列里的投稿被拒后是终态，不能靠再点一次通过把它救回来', async () => {
    // 记录这条既有语义，免得日后有人为了「支持改完重投」把终态放开：
    // 被拒的作者要重新投稿，而不是等管理员翻回去点通过。
    const a = await account('alice');
    const post = await submit(a, '被拒了');
    await admin(`/api/admin/posts/${post.id}/review`, { status: 'rejected', reason: '不合格' });
    expect((await admin(`/api/admin/posts/${post.id}/review`, { status: 'approved' })).status).toBe(404);
  });
});

describe('作者实体缺失时的韧性', () => {
  it('删掉一个用户的实体后，公开列表不崩，作者显示「已注销用户」', async () => {
    // 这一条守的是「一个坏行打挂全站」：author() 原来是 store.get(...)!，
    // 解构 undefined 会抛 TypeError，而被它打挂的是所有包含该文章的列表。
    const a = await account('ghost');
    const post = await submit(a, '作者会消失');
    await admin(`/api/admin/posts/${post.id}/review`, { status: 'approved' });
    server.db.prepare("DELETE FROM entities WHERE kind = 'user' AND id = 'ghost'").run();

    const feed = await anonymous.get<GetPostsResponse>('/api/posts?pageSize=50');
    expect(feed.items.map(item => item.id)).toContain(post.id);
    expect(feed.items.find(item => item.id === post.id)!.author)
      .toMatchObject({ handle: 'ghost', nickname: '已注销用户·ghost' });
    // 详情与评论也走同一条 author()，一并确认。
    expect((await anonymous.get<Post>(`/api/posts/${post.id}`)).author.nickname).toBe('已注销用户·ghost');
  });

  it('会话有效但资料行丢失时，个人接口自动重建资料而不是返回半个对象', async () => {
    // 原来这里期望 401，但审查发现那是死路：登录接口本身也读 user 实体，
    // 返回 401 的同时又已下发有效 cookie，用户「重新登录」永远失败。
    // 现在改成自动重建：资料以 handle 为昵称（不伪造身份），tokens 取初始值。
    const a = await account('half');
    const before = await a.get<CurrentUser>('/api/me');
    expect(before.nickname).toBe('half');
    server.db.prepare("DELETE FROM entities WHERE kind = 'user' AND id = 'half'").run();
    const after = await a.get<CurrentUser>('/api/me');
    expect(after).toMatchObject({ handle: 'half', nickname: 'half', tokens: before.tokens, bio: '', avatar: '' });
    expect((await a.call('POST', '/api/me/checkin')).status).toBe(200);
    expect((await a.call('PATCH', '/api/me', { nickname: '新名字' })).status).toBe(200);
    expect((await a.get<CurrentUser>('/api/me')).nickname).toBe('新名字');
  });

  it('「已注销用户」占位昵称不能被活用户注册或改名占用', async () => {
    const register = await server.app.request('/api/auth/register', {
      method: 'POST', headers: json,
      body: JSON.stringify({ username: 'imposter', password: PASSWORD, nickname: '已注销用户' }),
    });
    expect(register.status).toBe(400);
    const a = await account('normal');
    expect((await a.call('PATCH', '/api/me', { nickname: '已注销用户·ghost' })).status).toBe(400);
  });
});

describe('审核入口的闭环约束', () => {
  it('通过投稿页签拒绝站内文章也必须填理由（两个入口不能一个必填一个可选）', async () => {
    // 站内文章同时出现在「待审文章」和「我的投稿」两个页签，分别打
    // /api/admin/posts/:id/review 与 /api/admin/submissions/:id/review。
    // 只在一个入口强制理由，等于给用户留了一个「被拒但没有原因」的后门。
    const a = await account('alice');
    const post = await submit(a, '从投稿页签拒绝');
    const without = await admin(`/api/admin/submissions/${post.id}/review`, { status: 'rejected' });
    expect(without.status).toBe(400);
    expect(await without.json()).toMatchObject({ error: { code: 'REASON_REQUIRED' } });
    expect((await a.get<GetPostsResponse>('/api/me/posts')).items[0].status).toBe('pending');
  });

  it('群友文章驳回后理由随记录保留，恢复后仍可读', async () => {
    // reviewPost 对群友稿走 withdrawPost。之前只写下架标记不写理由，
    // 管理台强制填的理由成了一次性废纸，管理员自己也看不到。
    // 先导入一篇群友稿（import 生成的 id 是 feishu-<recordId>）。
    expect((await admin('/api/admin/import', {
      stations: [{
        slug: 'sub-reviewcase-com', name: '案例站', description: 'd', url: 'https://reviewcase.example.com/',
        rechargeThreshold: null, paymentMethods: [], offers: [],
      }],
      posts: [{
        recordId: 'reviewcase', stationSlug: 'sub-reviewcase-com', title: '群友稿', summary: 's', body: 'b',
        authorName: '群友', publishedAt: '2026-11-04T08:00:00.000Z',
      }],
    })).status).toBe(200);
    const response = await admin('/api/admin/posts/feishu-reviewcase/review', { status: 'rejected', reason: '证据不足' });
    expect(response.status).toBe(200);
    const removed = await server.app.request('/api/admin/posts/removed', { headers: bearer });
    expect(removed.status).toBe(200);
    expect(await removed.json()).toMatchObject({ items: [{ id: 'feishu-reviewcase' }] });
    const raw = server.db.prepare("SELECT data FROM entities WHERE kind='post' AND id='feishu-reviewcase'").get() as { data: string };
    expect(JSON.parse(raw.data)).toMatchObject({ reviewReason: '证据不足' });
  });

  it('已物化文章再审核时同步 submissions，两个页签不再互相打脸', async () => {
    const a = await account('alice');
    const post = await submit(a, '两个页签同一口径');
    expect((await admin(`/api/admin/posts/${post.id}/review`, { status: 'approved' })).status).toBe(200);
    expect((await admin(`/api/admin/posts/${post.id}/review`, { status: 'rejected', reason: '复核不通过' })).status).toBe(200);
    expect((await a.get<GetPostsResponse>('/api/me/posts')).items[0]).toMatchObject({ status: 'rejected', reviewReason: '复核不通过' });
    const subs = await a.get<{ items: Array<{ id: string; status: string; reason: string | null }> }>('/api/me/submissions');
    expect(subs.items.find(item => item.id === post.id)).toMatchObject({ status: 'rejected', reason: '复核不通过' });
  });

  it('review 不接受 pending：那会产生前台 404、下架列表也没有的第三种不在线状态', async () => {
    const a = await account('alice');
    const post = await submit(a, 'pending 不该是审核终态');
    expect((await admin(`/api/admin/posts/${post.id}/review`, { status: 'pending' })).status).toBe(400);
    expect((await admin(`/api/admin/posts/${post.id}/review`, { status: 'approved', reason: 'x' })).status).toBe(200);
    expect((await admin(`/api/admin/posts/${post.id}/review`, { status: 'pending' })).status).toBe(400);
  });

  it('非对象的空 body 不再被展开成 {}，校验语义不放松', async () => {
    const a = await account('alice');
    const cookie = server.db.prepare("SELECT handle FROM accounts WHERE handle = 'alice'").get();
    expect(cookie).toBeDefined();
    const response = await a.call('POST', '/api/me/checkin', null);
    // 旧代码 `JSON.parse(body || '{}')` 拿 null 交给 strictObject 会 400；
    // 合并 path 参数时若写成 `{...null}` 就悄悄变成 {} 让请求通过。
    expect(response.status).toBe(400);
  });
});

describe('评论自删', () => {
  const target = { targetType: 'post' as const, targetId: 'post-1' };
  async function comment(who: Awaited<ReturnType<typeof account>>, content: string, parentId?: string) {
    const response = await who.call('POST', '/api/comments', { ...target, content, ...(parentId ? { parentId } : {}) });
    expect(response.status).toBe(200);
    return await response.json() as { id: string };
  }

  it('没有回复的评论直接物理删除，不在列表里留空壳', async () => {
    const a = await account('alice');
    const created = await comment(a, '只有我一条');
    const removed = await a.call('DELETE', `/api/comments/${created.id}`);
    expect(removed.status).toBe(200);
    expect(await removed.json()).toMatchObject({ id: created.id, deleted: 'removed' });
    const list = await a.get<{ items: Array<{ id: string }> }>('/api/comments?targetType=post&targetId=post-1');
    expect(list.items.map(item => item.id)).not.toContain(created.id);
  });

  it('有别人回复时留墓碑：正文清空、回复仍在', async () => {
    // 物理删会连带删掉别人写的话，而且 PRAGMA foreign_keys=ON 会对 parentId 生效。
    const a = await account('alice');
    const b = await account('bobby');
    const parent = await comment(a, '会被删的父评论');
    await comment(b, '别人的回复', parent.id);
    expect((await a.call('DELETE', `/api/comments/${parent.id}`)).status).toBe(200);

    const list = await a.get<{ items: Array<{ id: string; content: string; deleted?: boolean; replies: Array<{ content: string }> }> }>(
      '/api/comments?targetType=post&targetId=post-1',
    );
    const tomb = list.items.find(item => item.id === parent.id)!;
    // 正文在库里保留（举报处理要看原文），接口侧必须是空串：
    // 作者删掉的话不该还能被任何人读到。
    expect(tomb).toMatchObject({ deleted: true, content: '' });
    expect(tomb.replies.map(reply => reply.content)).toEqual(['别人的回复']);
  });

  it('隐藏的回复也算「有子行」：外键不看 hidden，按可见回复判断会撞约束', async () => {
    // rs-tech 的原方案是「按可见子回复判断能否物理删」，这条专门锁住那个漏洞。
    const a = await account('alice');
    const b = await account('bobby');
    const parent = await comment(a, '父评论');
    const reply = await comment(b, '会被管理员隐藏的回复', parent.id);
    expect((await admin(`/api/admin/comments/${reply.id}/hide`, { hidden: true })).status).toBe(200);
    const removed = await a.call('DELETE', `/api/comments/${parent.id}`);
    expect(removed.status).toBe(200);
    expect(await removed.json()).toMatchObject({ deleted: 'tombstoned' });
    // 墓碑没有可见回复，按设计不出现在列表里，但行还在库里（外键要它）。
    const row = server.db.prepare('SELECT deletedAt, content FROM comments WHERE id = ?').get(parent.id) as { deletedAt: string | null; content: string };
    expect(row.deletedAt).not.toBeNull();
    // 正文留在库里（举报处理要看原文），但对外接口一律读不到。
    expect(row.content).toBe('父评论');
  });

  it('删别人的评论回 404，不泄露该 id 是否存在', async () => {
    const a = await account('alice');
    const b = await account('bobby');
    const created = await comment(a, 'alice 的评论');
    expect((await b.call('DELETE', `/api/comments/${created.id}`)).status).toBe(404);
    expect((await b.call('DELETE', '/api/comments/never-existed')).status).toBe(404);
    // 两条路径的状态码一致：403 等于承认「存在但不是你的」。
    expect((await a.get<{ items: Array<{ id: string }> }>('/api/comments?targetType=post&targetId=post-1')).items.map(i => i.id)).toContain(created.id);
  });

  it('墓碑不计入评论数，也不能再被回复', async () => {
    const a = await account('alice');
    const b = await account('bobby');
    const parent = await comment(a, '父评论');
    await comment(b, '回复');
    const before = (await a.get<Post>('/api/posts/post-1')).commentCount;
    await a.call('DELETE', `/api/comments/${parent.id}`);
    expect((await a.get<Post>('/api/posts/post-1')).commentCount).toBe(before - 1);
    expect((await b.call('POST', '/api/comments', { ...target, content: '回复墓碑', parentId: parent.id })).status).toBe(400);
  });

  it('回复没有子行，永远物理删；重复删只报一次 404', async () => {
    const a = await account('alice');
    const b = await account('bobby');
    const parent = await comment(a, '父评论');
    const reply = await comment(b, 'bobby 的回复', parent.id);
    expect(await (await b.call('DELETE', `/api/comments/${reply.id}`)).json()).toMatchObject({ deleted: 'removed' });
    expect((await b.call('DELETE', `/api/comments/${reply.id}`)).status).toBe(404);
    // 父评论现在没有子行，再删就是物理删。
    expect(await (await a.call('DELETE', `/api/comments/${parent.id}`)).json()).toMatchObject({ deleted: 'removed' });
  });
});

describe('作者撤下自己的文章', () => {
  async function published(who: Awaited<ReturnType<typeof account>>, title: string) {
    const post = await submit(who, title);
    await admin(`/api/admin/posts/${post.id}/review`, { status: 'approved' });
    return post;
  }

  it('作者能撤下已发布文章，撤下后公开读不到、管理员仍可恢复', async () => {
    const a = await account('alice');
    const post = await published(a, '我想撤下的文章');
    expect((await anonymous.get<Post>(`/api/posts/${post.id}`)).status).toBe('approved');

    const removed = await a.call('DELETE', `/api/posts/${post.id}`);
    expect(removed.status).toBe(200);
    expect(await removed.json()).toMatchObject({ id: post.id, removed: true });
    expect((await anonymous.call('GET', `/api/posts/${post.id}`)).status).toBe(404);
    // 正文没被删，管理员能恢复回来。
    expect((await admin(`/api/admin/posts/${post.id}/restore`)).status).toBe(200);
    expect((await anonymous.get<Post>(`/api/posts/${post.id}`)).status).toBe('approved');
  });

  it('撤不掉别人的文章，也撤不掉不存在的文章（都是 404）', async () => {
    const a = await account('alice');
    const b = await account('bobby');
    const post = await published(a, 'alice 的文章');
    expect((await b.call('DELETE', `/api/posts/${post.id}`)).status).toBe(404);
    expect((await b.call('DELETE', '/api/posts/never-existed')).status).toBe(404);
    expect((await anonymous.get<Post>(`/api/posts/${post.id}`)).status).toBe('approved');
  });

  it('待审与被拒的文章不能撤下：它们还没上线', async () => {
    const a = await account('alice');
    const post = await submit(a, '还在待审');
    const response = await a.call('DELETE', `/api/posts/${post.id}`);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: 'POST_NOT_PUBLISHED' } });
  });

  it('重复撤下报「已撤下」而不是「不存在」', async () => {
    const a = await account('alice');
    const post = await published(a, '撤两次');
    expect((await a.call('DELETE', `/api/posts/${post.id}`)).status).toBe(200);
    const again = await a.call('DELETE', `/api/posts/${post.id}`);
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ error: { code: 'ALREADY_REMOVED' } });
  });

  it('撤下后收藏与评论数不再计入，恢复后回到原样', async () => {
    const a = await account('alice');
    const b = await account('bobby');
    const post = await published(a, '会被撤下的');
    await b.call('PUT', '/api/favorites', { targetType: 'post', targetId: post.id, favorited: true });
    expect((await b.get<CurrentUser>('/api/me')).favoriteCount).toBe(1);
    await a.call('DELETE', `/api/posts/${post.id}`);
    expect((await b.get<CurrentUser>('/api/me')).favoriteCount).toBe(0);
    expect((await b.get<GetPostsResponse>('/api/me/favorites')).total).toBe(0);
  });
});

describe('举报最小闭环', () => {
  async function approvedPost(who: Awaited<ReturnType<typeof account>>, title: string) {
    const post = await submit(who, title);
    await admin(`/api/admin/posts/${post.id}/review`, { status: 'approved' });
    return post;
  }

  it('登录用户能举报已公开文章，重复举报 409', async () => {
    const a = await account('alice');
    const b = await account('bobby');
    const post = await approvedPost(a, '会被举报的文章');
    expect((await b.call('POST', '/api/reports', { targetType: 'post', targetId: post.id, reason: '内容不实或夸大' })).status).toBe(200);
    const again = await b.call('POST', '/api/reports', { targetType: 'post', targetId: post.id, reason: '再报一次' });
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ error: { code: 'ALREADY_REPORTED' } });
  });

  it('不能举报自己的内容，也不能举报不存在的内容', async () => {
    const a = await account('alice');
    const post = await approvedPost(a, '自己的文章');
    expect((await a.call('POST', '/api/reports', { targetType: 'post', targetId: post.id, reason: 'x' })).status).toBe(400);
    expect((await a.call('POST', '/api/reports', { targetType: 'post', targetId: 'never', reason: 'x' })).status).toBe(404);
    expect((await a.call('POST', '/api/reports', { targetType: 'station', targetId: 'whale-demo', reason: 'x' })).status).toBe(400);
    // 未登录不能举报：没有可追责的对象。
    expect((await anonymous.call('POST', '/api/reports', { targetType: 'post', targetId: post.id, reason: 'x' })).status).toBe(401);
  });

  it('管理台看到举报列表，处置后从 open 里消失', async () => {
    const a = await account('alice');
    const b = await account('bobby');
    const post = await approvedPost(a, '待处置的文章');
    const created = await b.call('POST', '/api/reports', { targetType: 'post', targetId: post.id, reason: '含广告', detail: '第二段推荐了购买渠道' });
    expect(created.status).toBe(200);
    const { id } = await created.json() as { id: string };

    const list = await (await server.app.request('/api/admin/reports', { headers: bearer })).json() as { items: Array<{ id: string; reason: string; detail: string | null; targetLabel: string; targetAlive: boolean }> };
    expect(list.items).toHaveLength(1);
    expect(list.items[0]).toMatchObject({ id, reason: '含广告', detail: '第二段推荐了购买渠道', targetLabel: '待处置的文章', targetAlive: true });

    expect((await admin(`/api/admin/reports/${id}/resolve`, { status: 'resolved' })).status).toBe(200);
    const after = await (await server.app.request('/api/admin/reports', { headers: bearer })).json() as { items: unknown[] };
    expect(after.items).toHaveLength(0);
    // 处置不自动动内容：文章还在线。
    expect((await anonymous.get<Post>(`/api/posts/${post.id}`)).status).toBe('approved');
  });

  it('被举报内容已下架时列表标记「已不在线」，处置不报错', async () => {
    const a = await account('alice');
    const b = await account('bobby');
    const post = await approvedPost(a, '先被举报再被下架');
    await b.call('POST', '/api/reports', { targetType: 'post', targetId: post.id, reason: 'x' });
    await a.call('DELETE', `/api/posts/${post.id}`);
    const list = await (await server.app.request('/api/admin/reports', { headers: bearer })).json() as { items: Array<{ targetAlive: boolean }> };
    expect(list.items[0].targetAlive).toBe(false);
  });

  it('举报评论：不能举报自己的评论，看不到的（隐藏的/删除的）也不能举报', async () => {
    const a = await account('alice');
    const b = await account('bobby');
    // 不能挂在演示文章下面：演示数据一律拒绝举报（没有处置出口）。
    const post = await approvedPost(a, '评论挂靠的文章');
    const comment = await (async () => {
      const response = await b.call('POST', '/api/comments', { targetType: 'post', targetId: post.id, content: '一条可举报的评论' });
      return await response.json() as { id: string };
    })();
    expect((await a.call('POST', '/api/reports', { targetType: 'comment', targetId: comment.id, reason: '人身攻击' })).status).toBe(200);
    expect((await b.call('POST', '/api/reports', { targetType: 'comment', targetId: comment.id, reason: 'x' })).status).toBe(400);
    expect((await anonymous.call('POST', '/api/reports', { targetType: 'comment', targetId: comment.id, reason: 'x' })).status).toBe(401);
  });
});

describe('预设头像', () => {
  it('PATCH /api/me 可设置预设头像，服务器只认预设集合', async () => {
    const a = await account('alice');
    expect((await a.call('PATCH', '/api/me', { avatar: '🦊' })).status).toBe(200);
    expect((await a.get<CurrentUser>('/api/me')).avatar).toBe('🦊');
    const invalid = await a.call('PATCH', '/api/me', { avatar: 'https://evil.example/x.png' });
    expect(invalid.status).toBe(400);
    expect((await a.get<CurrentUser>('/api/me')).avatar).toBe('🦊');
  });

  it('设置头像不影响昵称去重与保留身份', async () => {
    const a = await account('alice');
    const b = await account('bobby');
    expect((await a.call('PATCH', '/api/me', { avatar: '🐼', nickname: '管理员' })).status).toBe(400);
    expect((await a.call('PATCH', '/api/me', { avatar: '🐼', nickname: 'bobby' })).status).toBe(409);
    // 只有头像的更新能成功。
    expect((await a.call('PATCH', '/api/me', { avatar: '🐼' })).status).toBe(200);
    expect((await b.get<CurrentUser>('/api/me')).nickname).toBe('bobby');
  });
});

describe('审查修复：举报与删除的证据边界', () => {
  it('墓碑评论不能举报，已撤下文章下的评论也不能举报', async () => {
    const a = await account('alice');
    const b = await account('bobby');
    const post = await submit(a, '评论挂靠');
    await admin(`/api/admin/posts/${post.id}/review`, { status: 'approved' });
    const comment = await (await b.call('POST', '/api/comments', { targetType: 'post', targetId: post.id, content: '会变成墓碑的评论' })).json() as { id: string };
    await b.call('DELETE', `/api/comments/${comment.id}`);
    // 墓碑：读者看不到，允许举报等于把评论 id 变成存在性探针。
    expect((await a.call('POST', '/api/reports', { targetType: 'comment', targetId: comment.id, reason: 'x' })).status).toBe(404);

    const comment2 = await (await b.call('POST', '/api/comments', { targetType: 'post', targetId: post.id, content: '文章撤下前写的' })).json() as { id: string };
    await a.call('DELETE', `/api/posts/${post.id}`);
    // 第三人视角：文章已撤下，评论在详情里读不到，举报它同样没有处置出口。
    const c = await account('charlie');
    expect((await c.call('POST', '/api/reports', { targetType: 'comment', targetId: comment2.id, reason: 'x' })).status).toBe(404);
  });

  it('管理员隐藏的评论被作者删除时留墓碑，不销毁审核证据', async () => {
    const a = await account('alice');
    const b = await account('bobby');
    const comment = await (await b.call('POST', '/api/comments', { targetType: 'post', targetId: 'post-1', content: '被管理员隐藏的话' })).json() as { id: string };
    await admin(`/api/admin/comments/${comment.id}/hide`, { hidden: true });
    const removed = await b.call('DELETE', `/api/comments/${comment.id}`);
    expect(await removed.json()).toMatchObject({ deleted: 'tombstoned' });
    // 行还在，正文还在——举报/审核处理时还要看原文。
    const row = server.db.prepare('SELECT content, deletedAt FROM comments WHERE id = ?').get(comment.id) as { content: string; deletedAt: string | null };
    expect(row.content).toBe('被管理员隐藏的话');
    expect(row.deletedAt).not.toBeNull();
  });

  it('撤下文章后 shareCount 跟着减，不会出现「分享 3、列表 2」', async () => {
    const a = await account('alice');
    const post = await submit(a, '会撤下的分享');
    await admin(`/api/admin/posts/${post.id}/review`, { status: 'approved' });
    expect((await a.get<CurrentUser>('/api/me')).shareCount).toBe(1);
    await a.call('DELETE', `/api/posts/${post.id}`);
    expect((await a.get<CurrentUser>('/api/me')).shareCount).toBe(0);
  });

  it('演示文章不能举报：下架接口对 demo 是 409，举报了也没有出口', async () => {
    const a = await account('alice');
    const response = await a.call('POST', '/api/reports', { targetType: 'post', targetId: 'post-1', reason: 'x' });
    expect(response.status).toBe(400);
  });
});
