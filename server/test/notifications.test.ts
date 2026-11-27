import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { GetMyNotificationsResponse } from '@zhidedeng/shared';
import { createApp } from '../src/node-app.ts';

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
  const response = await server.app.request('/api/auth/register', {
    method: 'POST', headers: json, body: JSON.stringify({ username, password: PASSWORD, nickname: username }),
  });
  expect(response.status).toBe(200);
  const cookie = (response.headers.get('set-cookie') ?? '').split(';')[0];
  return {
    call: async (method: string, path: string, body?: unknown) => server.app.request(path, {
      method, headers: { ...json, cookie }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  };
}

async function notifications(who: { call: (m: string, p: string, b?: unknown) => Promise<Response> }, pageSize = 20) {
  const response = await who.call('GET', `/api/me/notifications?pageSize=${pageSize}`);
  expect(response.status).toBe(200);
  return await response.json() as GetMyNotificationsResponse;
}

describe('我的通知', () => {
  it('投稿被驳回时带出理由；被通过时没有理由但有链接', async () => {
    const alice = await account('alice');
    const rejected = await alice.call('POST', '/api/posts', {
      kind: 'community', title: '被拒的稿子', summary: '摘要', body: '正文',
    });
    const rejectedId = (await rejected.json() as { id: string }).id;
    await server.app.request(`/api/admin/posts/${rejectedId}/review`, {
      method: 'POST', headers: bearer, body: JSON.stringify({ status: 'rejected', reason: '用了真实站点名' }),
    });

    const approved = await alice.call('POST', '/api/posts', {
      kind: 'community', title: '通过的稿子', summary: '摘要', body: '正文',
    });
    const approvedId = (await approved.json() as { id: string }).id;
    await server.app.request(`/api/admin/posts/${approvedId}/review`, {
      method: 'POST', headers: bearer, body: JSON.stringify({ status: 'approved' }),
    });

    const list = await notifications(alice);
    const reject = list.items.find(item => item.title.includes('被拒的稿子'))!;
    expect(reject).toMatchObject({ kind: 'submission', detail: '用了真实站点名' });
    // 被驳回的没有线上文章，不能给链接（给了就是 404）。
    expect(reject.href).toBeNull();

    const pass = list.items.find(item => item.title.includes('通过的稿子'))!;
    expect(pass.detail).toBeNull();
    expect(pass.href).toBe(`/posts/${approvedId}`);
  });

  it('待审的投稿不算通知（还没有结论）', async () => {
    const alice = await account('alice');
    await alice.call('POST', '/api/posts', { kind: 'community', title: '还在排队', summary: 's', body: 'b' });
    expect((await notifications(alice)).items).toEqual([]);
  });

  it('举报被处置后通知举报人，备注带上；别人的举报不出现', async () => {
    const alice = await account('alice');
    const bob = await account('bob');
    const post = await alice.call('POST', '/api/posts', { kind: 'community', title: '一篇帖', summary: 's', body: 'b' });
    const postId = (await post.json() as { id: string }).id;
    await server.app.request(`/api/admin/posts/${postId}/review`, {
      method: 'POST', headers: bearer, body: JSON.stringify({ status: 'approved' }),
    });
    const report = await bob.call('POST', '/api/reports', {
      targetType: 'post', targetId: postId, reason: '广告',
    });
    const reportId = (await report.json() as { id: string }).id;

    // 还没处置 → 没有通知。
    expect((await notifications(bob)).items).toEqual([]);
    await server.app.request(`/api/admin/reports/${reportId}/resolve`, {
      method: 'POST', headers: bearer, body: JSON.stringify({ status: 'resolved', note: '已下架' }),
    });

    const bobs = await notifications(bob);
    expect(bobs.items[0]).toMatchObject({ kind: 'report', title: '你举报的内容已处理', detail: '已下架', href: `/posts/${postId}` });
    // 举报人之外的人看不到这条。
    expect((await notifications(alice)).items.some(item => item.kind === 'report')).toBe(false);
  });

  it('文章被下架时不带链接（详情页已 404），恢复后才给', async () => {
    const alice = await account('alice');
    const post = await alice.call('POST', '/api/posts', { kind: 'community', title: '我的文章', summary: 's', body: 'b' });
    const postId = (await post.json() as { id: string }).id;
    await server.app.request(`/api/admin/posts/${postId}/review`, {
      method: 'POST', headers: bearer, body: JSON.stringify({ status: 'approved' }),
    });

    clock = new Date(clock.getTime() + 60_000);
    await server.app.request(`/api/admin/posts/${postId}/withdraw`, { method: 'POST', headers: bearer });
    const afterRemove = (await notifications(alice)).items.filter(item => item.kind === 'post');
    expect(afterRemove[0]).toMatchObject({ title: '你的文章「我的文章」已下架', href: null });

    clock = new Date(clock.getTime() + 60_000);
    await server.app.request(`/api/admin/posts/${postId}/restore`, { method: 'POST', headers: bearer });
    const afterRestore = (await notifications(alice)).items.filter(item => item.kind === 'post');
    // 两条都在：恢复不会抹掉「被下架」那条历史。
    expect(afterRestore.map(item => item.title)).toEqual([
      '你的文章「我的文章」已恢复', '你的文章「我的文章」已下架',
    ]);
    expect(afterRestore[0].href).toBe(`/posts/${postId}`);
  });

  it('作者自己撤下的也记成文章通知', async () => {
    const alice = await account('alice');
    const post = await alice.call('POST', '/api/posts', { kind: 'community', title: '自己撤的', summary: 's', body: 'b' });
    const postId = (await post.json() as { id: string }).id;
    await server.app.request(`/api/admin/posts/${postId}/review`, {
      method: 'POST', headers: bearer, body: JSON.stringify({ status: 'approved' }),
    });
    expect((await alice.call('DELETE', `/api/posts/${postId}`)).status).toBe(200);

    const items = (await notifications(alice)).items.filter(item => item.kind === 'post');
    expect(items[0]).toMatchObject({ title: '你的文章「自己撤的」已下架', href: null });
  });

  it('新通知在前；同一时刻顺序稳定，翻页不重复不丢', async () => {
    const alice = await account('alice');
    for (let index = 0; index < 3; index++) {
      const post = await alice.call('POST', '/api/posts', {
        kind: 'community', title: `第 ${index} 篇`, summary: 's', body: 'b',
      });
      const id = (await post.json() as { id: string }).id;
      await server.app.request(`/api/admin/posts/${id}/review`, {
        method: 'POST', headers: bearer, body: JSON.stringify({ status: 'approved' }),
      });
    }
    // 让第三条明显更晚。
    clock = new Date(clock.getTime() + 60_000);
    const extra = await alice.call('POST', '/api/posts', { kind: 'community', title: '最新的', summary: 's', body: 'b' });
    const extraId = (await extra.json() as { id: string }).id;
    await server.app.request(`/api/admin/posts/${extraId}/review`, {
      method: 'POST', headers: bearer, body: JSON.stringify({ status: 'approved' }),
    });

    const all = (await notifications(alice, 50)).items;
    expect(all[0].title).toContain('最新的');

    // 同一时刻的（前三条）在两页里不重复也不丢。
    const first = (await notifications(alice, 2)).items.map(item => item.id);
    const secondResponse = await alice.call('GET', '/api/me/notifications?page=2&pageSize=2');
    const second = (await secondResponse.json() as GetMyNotificationsResponse).items.map(item => item.id);
    expect(new Set([...first, ...second]).size).toBe(4);
  });

  it('被替代（superseded）的投稿不算「未通过」', async () => {
    const alice = await account('alice');
    const submitted = await alice.call('POST', '/api/posts', { kind: 'community', title: '同一篇', summary: 's', body: 'b' });
    const id = (await submitted.json() as { id: string }).id;

    // 直接把它标成 superseded：走真实替代流程需要「同 originKey 两个版本」，
    // 而完全相同的提交会被幂等去重成同一条，构造不出来。这里测的是通知的过滤条件。
    server.store.db.prepare("UPDATE submissions SET status = 'superseded', reviewedAt = ?, reason = '被新版本替代' WHERE id = ?")
      .run(clock.toISOString(), id);

    expect((await notifications(alice)).items).toEqual([]);
  });

  it('通知里的链接只在目标此刻能打开时才给', async () => {
    const alice = await account('alice');
    const post = await alice.call('POST', '/api/posts', { kind: 'community', title: '会下架的', summary: 's', body: 'b' });
    const postId = (await post.json() as { id: string }).id;
    await server.app.request(`/api/admin/posts/${postId}/review`, {
      method: 'POST', headers: bearer, body: JSON.stringify({ status: 'approved' }),
    });
    // 通过时有链接。
    let items = (await notifications(alice)).items;
    expect(items.find(item => item.kind === 'submission')!.href).toBe(`/posts/${postId}`);

    // 下架之后，「已通过」那条投稿通知不该再指着一个 404。
    await server.app.request(`/api/admin/posts/${postId}/withdraw`, { method: 'POST', headers: bearer });
    items = (await notifications(alice)).items;
    expect(items.find(item => item.kind === 'submission')!.href).toBeNull();
  });

  it('文章改标题后，历史通知仍显示当时的标题（标题快照）', async () => {
    const alice = await account('alice');
    const post = await alice.call('POST', '/api/posts', { kind: 'community', title: '改名前', summary: 's', body: 'b' });
    const postId = (await post.json() as { id: string }).id;
    await server.app.request(`/api/admin/posts/${postId}/review`, {
      method: 'POST', headers: bearer, body: JSON.stringify({ status: 'approved' }),
    });
    await server.app.request(`/api/admin/posts/${postId}/withdraw`, { method: 'POST', headers: bearer });

    // 模拟文章随后被改名（导入/审核改稿）。
    const data = server.store.getWithRemoved('post', postId)!;
    server.store.put('post', postId, { ...data, title: '改名后' });

    const item = (await notifications(alice)).items.find(entry => entry.kind === 'post' && entry.title.includes('已下架'))!;
    expect(item.title).toContain('改名前');
    expect(item.title).not.toContain('改名后');
  });

  it('同一毫秒的两条文章事件不会共用同一个通知 id', async () => {
    const alice = await account('alice');
    const post = await alice.call('POST', '/api/posts', { kind: 'community', title: '同一秒', summary: 's', body: 'b' });
    const postId = (await post.json() as { id: string }).id;
    await server.app.request(`/api/admin/posts/${postId}/review`, {
      method: 'POST', headers: bearer, body: JSON.stringify({ status: 'approved' }),
    });
    // clock 不动：下架与恢复落在同一毫秒。
    await server.app.request(`/api/admin/posts/${postId}/withdraw`, { method: 'POST', headers: bearer });
    await server.app.request(`/api/admin/posts/${postId}/restore`, { method: 'POST', headers: bearer });

    const ids = (await notifications(alice)).items.filter(item => item.kind === 'post').map(item => item.id);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  });

  it('本人用 Agent 凭证提交的稿子也进通知', async () => {
    const alice = await account('alice');
    // 申请 Agent 凭证要求账号注册满 7 天，把钟往前拨。
    clock = new Date(clock.getTime() + 8 * 86_400_000);
    const token = await alice.call('POST', '/api/account/agent-tokens', { label: 'cli' });
    const { token: secret } = await token.json() as { token: string };
    const submitted = await server.app.request('/api/agent/posts', {
      method: 'POST',
      headers: { ...json, authorization: `Bearer ${secret}` },
      body: JSON.stringify({ title: 'Agent 写的', summary: 's', body: 'b', authorName: 'Agent 作者' }),
    });
    expect([200, 201]).toContain(submitted.status);
    // 响应把记录包在 submission 里（见 agent-api 的返回形状）。
    const body = await submitted.json() as { submission: { id: string } };
    const id = body.submission.id;

    await server.app.request(`/api/admin/submissions/${id}/review`, {
      method: 'POST', headers: bearer, body: JSON.stringify({ status: 'approved' }),
    });
    const items = (await notifications(alice)).items;
    const agentItem = items.find(item => item.kind === 'submission' && item.title.includes('Agent 写的'))!;
    expect(agentItem).toBeTruthy();
    // Agent 文章物化成 `sub-<投稿id>`，链接必须指向它，不能是投稿 id 本身。
    expect(agentItem.href).toBe(`/posts/sub-${id}`);
    expect((await server.app.request(`/api/posts/sub-${id}`)).status).toBe(200);
  });

  it('演示账号不产生通知（虚构数据没人会登录去看）', async () => {
    // 演示文章由 seed 写入，authorHandle 是 demo- 前缀的虚构账号。
    const demoPost = server.store.all('post').find(post => post.source === 'demo')!;
    // authorHandle 在 data JSON 里，不是列。
    const row = server.store.db.prepare('SELECT data FROM entities WHERE kind = ? AND id = ?').get('post', demoPost.id) as { data: string };
    const { authorHandle } = JSON.parse(row.data) as { authorHandle: string };
    expect(authorHandle.startsWith('demo-')).toBe(true);
    // 直接查那个 handle 的通知：没有账号，也就不该有任何事件。
    const count = Number(server.store.db.prepare('SELECT count(*) AS c FROM post_events WHERE authorHandle = ?').get(authorHandle)!.c);
    expect(count).toBe(0);
  });

  it('文章被改判驳回后，举报通知不再给链接（详情页 404）', async () => {
    const alice = await account('alice');
    const bob = await account('bob');
    const post = await alice.call('POST', '/api/posts', { kind: 'community', title: '先上线再驳回', summary: 's', body: 'b' });
    const postId = (await post.json() as { id: string }).id;
    await server.app.request(`/api/admin/posts/${postId}/review`, {
      method: 'POST', headers: bearer, body: JSON.stringify({ status: 'approved' }),
    });
    const report = await bob.call('POST', '/api/reports', { targetType: 'post', targetId: postId, reason: '广告' });
    const reportId = (await report.json() as { id: string }).id;

    // 把文章改判成驳回（相当于下架后又审核成 rejected）。
    await server.app.request(`/api/admin/posts/${postId}/review`, {
      method: 'POST', headers: bearer, body: JSON.stringify({ status: 'rejected', reason: '复核后认为不合规' }),
    });
    await server.app.request(`/api/admin/reports/${reportId}/resolve`, {
      method: 'POST', headers: bearer, body: JSON.stringify({ status: 'resolved' }),
    });

    const item = (await notifications(bob)).items.find(entry => entry.kind === 'report')!;
    expect(item.href).toBeNull();
  });

  it('同 hostname 的两个站点各归各的：/b 的投稿不会指到 /a', async () => {
    // 两个站同 hostname 不同路径，slug 由认领规则决定。
    const imported = await server.app.request('/api/admin/import', {
      method: 'POST', headers: bearer, body: JSON.stringify({
        stations: [
          { slug: 'sub-a', name: 'A 站', description: 'd', url: 'https://same.example.com/a', rechargeThreshold: null, paymentMethods: [], offers: [] },
          { slug: 'sub-b', name: 'B 站', description: 'd', url: 'https://same.example.com/b', rechargeThreshold: null, paymentMethods: [], offers: [] },
        ],
        posts: [],
      }),
    });
    expect(imported.status).toBe(200);
    // 直接造一条指向 /b 的站内站点投稿并审核通过，看通知链接落在哪个 slug。
    const alice = await account('alice');
    const suggested = await alice.call('POST', '/api/stations/suggest', {
      name: 'B 站更新', url: 'https://same.example.com/b', description: 'd', rechargeThreshold: null, paymentMethods: [], offers: [],
    });
    expect(suggested.status).toBe(200);
    const id = (await suggested.json() as { id: string }).id;
    await server.app.request(`/api/admin/submissions/${id}/review`, {
      method: 'POST', headers: bearer, body: JSON.stringify({ status: 'approved' }),
    });

    const item = (await notifications(alice)).items.find(entry => entry.kind === 'submission')!;
    // /b 的更新只能指向 /b 的服务站（sub-b），不能因为同 hostname 指到 /a。
    expect(item.href).toBe('/stations/sub-b');
  });

  it('站点下架后，「我的投稿」不再给出 404 链接', async () => {
    const alice = await account('alice');
    const suggested = await alice.call('POST', '/api/stations/suggest', {
      name: '会被下架的站', url: 'https://gone.example.com', description: 'd',
    });
    const id = (await suggested.json() as { id: string }).id;
    await server.app.request(`/api/admin/submissions/${id}/review`, {
      method: 'POST', headers: bearer, body: JSON.stringify({ status: 'approved' }),
    });
    // 上线时给链接。
    const before = await alice.call('GET', '/api/me/submissions');
    const beforeItem = (await before.json() as { items: Array<{ id: string; targetSlug: string | null }> }).items.find(item => item.id === id)!;
    expect(beforeItem.targetSlug).not.toBeNull();
    expect(beforeItem.targetSlug).toBe('sub-gone-example-com');

    // 站点下架之后，那个 slug 的详情页就是 404，不能再给。
    // 下架只有走管理流程一条路（批次 action=remove 还要先入队再审核），
    // 这里直接调软删除，测的只是「通知/我的投稿不再给死链」这一层。
    const slug = beforeItem.targetSlug!;
    server.store.markRemoved('station', slug, clock.toISOString());
    expect((await server.app.request(`/api/stations/${slug}`)).status).toBe(404);
    const after = await alice.call('GET', '/api/me/submissions');
    const afterItem = (await after.json() as { items: Array<{ id: string; targetSlug: string | null; withdrawn?: boolean }> }).items.find(item => item.id === id)!;
    expect(afterItem.targetSlug).toBeNull();
  });

  it('未登录不能读通知', async () => {
    expect((await server.app.request('/api/me/notifications')).status).toBe(401);
  });
});
