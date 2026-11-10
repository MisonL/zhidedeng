import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { API_ROUTES } from '@zhidedeng/shared';
import type { ApiContracts, ApiRouteName, Post } from '@zhidedeng/shared';
import { createApp, openStore } from '../src/node-app.ts';
import { reviewSubmission } from '../src/submissions.ts';

let clock = new Date('2026-11-03T15:59:00Z');
let server: ReturnType<typeof createApp>;
let cookie = '';
const signIn = () => request('register', { username: 'tester', password: 'correct-horse-battery', nickname: '试蹬员' });
beforeEach(() => {
  cookie = '';
  clock = new Date('2026-11-03T15:59:00Z');
  server = createApp({ dbPath: ':memory:', now: () => clock });
});
afterEach(() => server.db.close());

async function request<K extends ApiRouteName>(name: K, input?: ApiContracts[K]['request']) {
  const route = API_ROUTES[name];
  let path: string = route.path;
  const args = { ...input } as Record<string, unknown>;
  for (const key of ['slug', 'id']) {
    if (!path.includes(`:${key}`)) continue;
    path = path.replace(`:${key}`, encodeURIComponent(String(args[key])));
    delete args[key];
  }
  const headers: Record<string, string> = cookie ? { cookie } : {};
  const init: RequestInit = { method: route.method, headers };
  if (route.method === 'GET') {
    path += `?${new URLSearchParams(Object.entries(args).map(([key, value]) => [key, String(value)]))}`;
  } else {
    headers['content-type'] = 'application/json';
    init.body = JSON.stringify(args);
  }
  const response = await server.app.request(path, init);
  const setCookie = response.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  return { status: response.status, data: await response.json() as ApiContracts[K]['response'] };
}

async function ok<K extends ApiRouteName>(name: K, input?: ApiContracts[K]['request']) {
  const result = await request(name, input);
  expect(result.status).toBeGreaterThanOrEqual(200);
  expect(result.status).toBeLessThan(300);
  expect(result.data).not.toHaveProperty('error');
  return result.data as Exclude<ApiContracts[K]['response'], { error: unknown }>;
}

describe('seed and read endpoints', () => {
  it('GET vendors returns the ordered eleven vendors with 2–4 models each', async () => {
    const vendors = await ok('getVendors');
    expect(vendors.items.map(v => v.name)).toEqual(['OpenAI', 'Anthropic', 'Google', 'DeepSeek', 'xAI', 'Meta', '阿里通义', '字节豆包', '月之暗面', '智谱AI', 'MiniMax']);
    expect(vendors.total).toBe(11);
    vendors.items.forEach(v => expect(v.models.length).toBeGreaterThanOrEqual(2));
    vendors.items.forEach(v => expect(v.models.length).toBeLessThanOrEqual(4));
  });

  it('lists and filters models, returns price-sorted model detail', async () => {
    const models = await ok('getModels', { vendor: 'openai', q: 'GPT', pageSize: 100 });
    expect(models.items.length).toBeGreaterThan(0);
    expect(models.items.every(m => m.vendor === 'openai')).toBe(true);
    const model = await ok('getModel', { slug: models.items[0].slug });
    expect(model.offers.length).toBeGreaterThan(0);
    expect(model.offers.map(o => o.rate)).toEqual(model.offers.map(o => o.rate).sort((a, b) => a - b));
  });

  it('lists at least 12 clearly fictional stations with 6–15 offers each and sorts filters', async () => {
    const stations = await ok('getStations', { pageSize: 100, sort: 'rate' });
    expect(stations.total).toBeGreaterThanOrEqual(12);
    expect(stations.items.map(s => s.lowestRate)).toEqual(stations.items.map(s => s.lowestRate).sort((a, b) => a! - b!));
    for (const s of stations.items) {
      expect(s.description).toContain('虚构');
      const detail = await ok('getStation', { slug: s.slug });
      expect(detail.offers.length).toBeGreaterThanOrEqual(6);
      expect(detail.offers.length).toBeLessThanOrEqual(15);
    }
    const filtered = await ok('getStations', { vendor: 'openai', q: '蹬', sort: 'uptime' });
    expect(filtered.items.length).toBeGreaterThan(0);
    expect(filtered.items.every(s => s.name.includes('蹬'))).toBe(true);
    expect(filtered.items.map(s => s.uptime)).toEqual(filtered.items.map(s => s.uptime).sort((a, b) => b! - a!));
  });

  it('seeds at least forty recent articles across four kinds with varied interactions', async () => {
    const posts = await ok('getPosts', { pageSize: 100 });
    expect(posts.total).toBeGreaterThanOrEqual(40);
    expect(new Set(posts.items.map(p => p.kind)).size).toBe(4);
    expect(new Set(posts.items.map(p => p.votes.upRatio)).size).toBeGreaterThan(2);
    posts.items.forEach(p => {
      expect(p.stationSlug).not.toBeNull();
      expect(Date.parse(p.publishedAt)).toBeLessThanOrEqual(clock.getTime());
      expect(Date.parse(p.publishedAt)).toBeGreaterThan(clock.getTime() - 30 * 86400000);
    });
    const first = posts.items[0];
    expect(await ok('getPost', { id: first.id })).toEqual(first);
    const filtered = await ok('getPosts', { kind: first.kind, station: first.stationSlug!, model: first.modelSlug!, vendor: 'openai', sort: 'hot', q: first.title.slice(0, 2) });
    expect(filtered.items.every(p => p.kind === first.kind && p.stationSlug === first.stationSlug)).toBe(true);
    const page = await ok('getPosts', { page: 2, pageSize: 3 });
    expect(page.items).toHaveLength(3);
    expect(page.page).toBe(2);
    expect(page.total).toBe(posts.total);
    expect((await ok('getPosts', { pageSize: 101 })).pageSize).toBe(50);
  });

  it('returns current user, favorites, own posts, banners and hot searches', async () => {
    await signIn();
    const me = await ok('getMe');
    expect(me).toMatchObject({ handle: 'tester', nickname: '试蹬员', checkedInToday: false });
    expect((await ok('getMyFavorites')).total).toBe(me.favoriteCount);
    expect((await ok('getMyPosts')).total).toBe(me.shareCount);
    const banners = await ok('getBanners');
    expect(banners.items.map(b => b.image)).toEqual(['/banners/whale.webp', '/banners/pedal.webp', '/banners/compass.webp']);
    const linked = await server.app.request(`/api${banners.items[0].href}`);
    expect(linked.status).toBe(200);
    expect((await linked.json() as Post).kind).toBe('review');
    expect((await ok('getHotSearches')).items).toContain('DeepSeek');
  });

  it('seeds posts whose station names match stationSlug', async () => {
    const { items: stations } = await ok('getStations', { pageSize: 50 });
    const nameOf = (station: { name: string }) => station.name.replace('虚构·', '');
    const { items: posts } = await ok('getPosts', { pageSize: 50 });
    expect(posts).toHaveLength(48);
    for (const post of posts) {
      const own = nameOf(stations.find(s => s.slug === post.stationSlug)!);
      for (const text of [post.summary, (await ok('getPost', { id: post.id })).body]) {
        expect(text).toContain(own);
        for (const other of stations.map(nameOf).filter(name => name !== own)) expect(text).not.toContain(other);
      }
    }
  });

  it('seeds the flagship post and short banner copy consistently', async () => {
    const post = await ok('getPost', { id: 'post-1' });
    expect(post.stationSlug).toBe('whale-demo');
    expect((await ok('getModel', { slug: post.modelSlug! })).vendor).toBe('deepseek');
    const { items: banners } = await ok('getBanners');
    expect(banners[0].description).toBe('DeepSeek · 大肥鱼');
    for (const { description } of banners) {
      expect(description.length).toBeLessThanOrEqual(14);
      expect(description).not.toMatch(/虚构|演示/);
    }
  });

  it.each(['model', 'community', 'expert'] as const)('returns %s rankings with 6–12 entries', async tab => {
    const ranking = await ok('getRankings', { tab });
    expect(ranking.tab).toBe(tab);
    expect(ranking.items.length).toBeGreaterThanOrEqual(6);
    expect(ranking.items.length).toBeLessThanOrEqual(12);
    expect(ranking.items.map(i => i.rank)).toEqual(ranking.items.map((_, i) => i + 1));
  });

  it('searches model, station and article text with bounded groups and literal query safety', async () => {
    expect((await ok('search', { q: 'GPT' })).models.length).toBeGreaterThan(0);
    const stations = await ok('search', { q: '蹬蹬' });
    expect(stations.stations.length).toBeGreaterThan(0);
    expect(stations.posts.length).toBeGreaterThan(0);
    for (const items of Object.values(await ok('search', { q: 'a' }))) expect(items.length).toBeLessThanOrEqual(10);
    expect(await ok('search', { q: "' OR 1=1 --" })).toEqual({ models: [], stations: [], posts: [] });
  });

  it('ranks live user-earned votes and community discussion after writes', async () => {
    await signIn();
    const before = await ok('getRankings', { tab: 'expert' });
    if (before.tab !== 'expert') throw new Error('排行榜类型错误');
    const author = (await ok('getPost', { id: 'post-1' })).author.handle;
    const count = before.items.find(item => item.user.handle === author)!.upCount;
    await ok('putVote', { targetType: 'post', targetId: 'post-1', value: 'up' });
    const after = await ok('getRankings', { tab: 'expert' });
    if (after.tab !== 'expert') throw new Error('排行榜类型错误');
    expect(after.items.find(item => item.user.handle === author)!.upCount).toBe(count + 1);
    expect(after.items.map(item => item.upCount)).toEqual(after.items.map(item => item.upCount).sort((a, b) => b - a));
    const community = await ok('getRankings', { tab: 'community' });
    if (community.tab !== 'community') throw new Error('排行榜类型错误');
    const last = community.items.at(-1)!.post;
    for (let index = 0; index < 20; index++) {
      clock = new Date(clock.getTime() + 13_000);
      await ok('createComment', { targetType: 'post', targetId: last.id, content: `虚构讨论 ${index}` });
    }
    const promoted = await ok('getRankings', { tab: 'community' });
    if (promoted.tab !== 'community') throw new Error('排行榜类型错误');
    expect(promoted.items[0].post.id).toBe(last.id);
  });

  it('hot sorting promotes a fresh upvoted post and penalizes its changed downvote', async () => {
    await signIn();
    const input = { kind: 'community' as const, summary: '排序行为测试', body: '虚构测试内容' };
    // 站内发帖现在先进投稿队列，审核通过才物化到 entities。
    const approve = (id: string) => reviewSubmission(openStore(server.db), clock, id, { status: 'approved' });
    const older = await ok('createPost', { ...input, title: '较早的热门讨论' });
    expect(approve(older.id).status).toBe('approved');
    await ok('putVote', { targetType: 'post', targetId: older.id, value: 'up' });
    clock = new Date(clock.getTime() + 2 * 86400000);
    const fresh = await ok('createPost', { ...input, title: '新的热门讨论' });
    expect(approve(fresh.id).status).toBe('approved');
    await ok('putVote', { targetType: 'post', targetId: fresh.id, value: 'up' });
    expect((await ok('getPosts', { sort: 'hot' })).items[0].id).toBe(fresh.id);
    await ok('putVote', { targetType: 'post', targetId: fresh.id, value: 'down' });
    expect((await ok('getPosts', { sort: 'hot' })).items[0].id).not.toBe(fresh.id);
    expect((await ok('getPosts', { sort: 'latest' })).items[0].id).toBe(fresh.id);
  });
});

describe('writes and boundary validation', () => {
  beforeEach(signIn);

  it('updates only current user profile', async () => {
    const me = await ok('updateMe', { nickname: '试蹬员', bio: '先小额试用' });
    expect(me).toMatchObject({ handle: 'tester', nickname: '试蹬员', bio: '先小额试用' });
    expect(await ok('getMe')).toEqual(me);
  });

  it('creates posts preserving the exact markdown and updates my shares', async () => {
    const count = (await ok('getMyPosts')).total;
    const body = '  # 小额试用\n\n<script>alert(1)</script>\n**原样**  ';
    const post = await ok('createPost', { kind: 'review', title: '蹬蹬云试用记录', summary: '纯虚构演示', body, stationSlug: 'dengdeng-demo', modelSlug: 'gpt-4-1' });
    expect(post.body).toBe(body);
    expect(post.author.handle).toBe('tester');
    expect((await ok('getPost', { id: post.id })).body).toBe(body);
    expect((await ok('getMyPosts')).total).toBe(count + 1);
  });

  it.each(['post', 'station'] as const)('supports %s votes, changes and withdrawals without duplicates', async targetType => {
    const targetId = targetType === 'post' ? 'post-1' : 'dengdeng-demo';
    const base = await ok('putVote', { targetType, targetId, value: null });
    const up = await ok('putVote', { targetType, targetId, value: 'up' });
    expect(up.votes.up).toBe(base.votes.up + 1);
    expect((await ok('putVote', { targetType, targetId, value: 'up' })).votes).toEqual(up.votes);
    const down = await ok('putVote', { targetType, targetId, value: 'down' });
    expect(down.votes).toMatchObject({ up: base.votes.up, down: base.votes.down + 1 });
    expect((await ok('putVote', { targetType, targetId, value: null })).votes).toEqual(base.votes);
  });

  it.each(['post', 'station'] as const)('sets and unsets %s favorites idempotently', async targetType => {
    const targetId = targetType === 'post' ? 'post-1' : 'dengdeng-demo';
    const base = await ok('putFavorite', { targetType, targetId, favorited: false });
    const on = await ok('putFavorite', { targetType, targetId, favorited: true });
    expect(on.favoriteCount).toBe(base.favoriteCount + 1);
    expect(await ok('putFavorite', { targetType, targetId, favorited: true })).toEqual(on);
    const favorites = await ok('getMyFavorites', { pageSize: 100 });
    expect(favorites.items.some(f => f.targetType === targetType && f.targetId === targetId)).toBe(true);
    expect((await ok('putFavorite', { targetType, targetId, favorited: false })).favoriteCount).toBe(base.favoriteCount);
  });

  it('creates comments and one-level replies scoped to their target', async () => {
    const target = { targetType: 'post' as const, targetId: 'post-1' };
    const comment = await ok('createComment', { ...target, content: '建议先验证流式响应' });
    expect(comment.parentId).toBeNull();
    const reply = await ok('createComment', { ...target, parentId: comment.id, content: '赞同，记得看晚高峰' });
    expect(reply.parentId).toBe(comment.id);
    const list = await ok('getComments', target);
    expect(list.items.find(c => c.id === comment.id)?.replies).toContainEqual(reply);
    expect((await request('createComment', { ...target, parentId: reply.id, content: '不允许第三层' })).status).toBe(400);
    expect((await request('createComment', { targetType: 'station', targetId: 'dengdeng-demo', parentId: comment.id, content: '不能跨对象回复' })).status).toBe(400);
    expect((await ok('createComment', { targetType: 'station', targetId: 'dengdeng-demo', content: '虚构体验' })).parentId).toBeNull();
  });

  it('checks in once per Shanghai day, continues across midnight and resets after a gap', async () => {
    const initial = (await ok('getMe')).tokens;
    expect(await ok('checkIn')).toMatchObject({ date: '2026-11-03', streak: 1, tokensAwarded: 11, tokens: initial + 11 });
    expect(await request('checkIn')).toMatchObject({ status: 409, data: { error: { code: 'ALREADY_CHECKED_IN' } } });
    clock = new Date('2026-11-03T16:01:00Z');
    expect(await ok('getMe')).toMatchObject({ checkedInToday: false, streak: 1 });
    expect(await ok('checkIn')).toMatchObject({ date: '2026-11-04', streak: 2, tokensAwarded: 12 });
    for (let day = 5; day <= 11; day++) {
      clock = new Date(`2026-11-${day.toString().padStart(2, '0')}T01:00:00Z`);
      expect((await ok('checkIn')).tokensAwarded).toBe(10 + Math.min(day - 2, 7));
    }
    clock = new Date('2026-11-14T00:00:00Z');
    expect((await ok('getMe')).streak).toBe(0);
    expect(await ok('checkIn')).toMatchObject({ streak: 1, tokensAwarded: 11 });
  });

  it.each([
    ['PATCH', '/api/me', { nickname: '' }],
    ['PATCH', '/api/me', { tokens: 999999 }],
    ['POST', '/api/posts', { kind: 'invalid', title: '', body: '', summary: '' }],
    ['POST', '/api/posts', { kind: 'deal', title: 'test', summary: 'test', body: 'test', modelSlug: 'missing' }],
    ['PUT', '/api/votes', { targetType: 'post', targetId: 'post-1', value: 1 }],
    ['PUT', '/api/votes', { targetType: 'post', targetId: '   ', value: 'up' }],
    ['PUT', '/api/favorites', { targetType: 'post', targetId: 'post-1', favorited: 'true' }],
    ['POST', '/api/comments', { targetType: 'post', targetId: 'post-1', content: 'a'.repeat(2001) }],
    ['POST', '/api/comments', { targetType: 'post', targetId: 'post-1', content: '   ' }],
    ['POST', '/api/me/checkin', { tokens: 999 }],
    ['GET', '/api/posts?kind=wrong'], ['GET', '/api/posts?page=0'],
    ['GET', '/api/stations?sort=wrong'], ['GET', '/api/rankings?tab=wrong'], ['GET', '/api/comments?targetType=other&targetId=x'],
  ])('rejects invalid input %s %s with a uniform 400 error', async (method, path, body?: unknown) => {
    const response = await server.app.request(path, { method, headers: { 'content-type': 'application/json', cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: 'INVALID_INPUT', message: expect.any(String) } });
  });

  it('accepts check-in with no JSON body', async () => {
    const response = await server.app.request('/api/me/checkin', { method: 'POST', headers: { 'content-type': 'application/json', cookie } });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ streak: 1, tokensAwarded: 11 });
  });

  it('rejects malformed JSON and returns uniform 404 for absent resources and targets', async () => {
    const malformed = await server.app.request('/api/posts', { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: '{broken' });
    expect(malformed.status).toBe(400);
    for (const path of ['/api/models/missing', '/api/stations/missing', '/api/posts/missing', '/api/missing']) {
      const response = await server.app.request(path);
      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
    }
    expect((await request('putVote', { targetType: 'post', targetId: 'missing', value: 'up' })).status).toBe(404);
    expect((await request('putFavorite', { targetType: 'station', targetId: 'missing', favorited: true })).status).toBe(404);
    expect((await request('getComments', { targetType: 'post', targetId: 'missing' })).status).toBe(404);
    expect((await request('createComment', { targetType: 'post', targetId: 'missing', content: '目标不存在' })).status).toBe(404);
  });
});
