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

  it('未登录不能读通知', async () => {
    expect((await server.app.request('/api/me/notifications')).status).toBe(401);
  });
});
