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

  it('哨兵作者（unknown / unknown-feishu）不会把通知派发给同名真人', async () => {
    const alice = await account('alice');
    // 直接造两条指向哨兵的流水：老数据里 'unknown' 就是这么写的。
    const insert = server.store.db.prepare('INSERT INTO post_events (postId, authorHandle, action, reason, title, at) VALUES (?,?,?,?,?,?)');
    insert.run('ghost-1', 'unknown', 'removed', null, '别人的文章标题', clock.toISOString());
    insert.run('ghost-2', 'unknown-feishu', 'removed', null, '别人的文章标题', clock.toISOString());

    // 真人注册 'unknown' 也读不到任何通知：哨兵行不派发。
    const squat = await account('unknown');
    expect((await notifications(squat)).items).toEqual([]);
    expect((await notifications(alice)).items).toEqual([]);
  });

  it('同一毫秒内「下架 → 恢复」，恢复排在前面', async () => {
    const alice = await account('alice');
    const post = await alice.call('POST', '/api/posts', { kind: 'community', title: '同毫秒', summary: 's', body: 'b' });
    const postId = (await post.json() as { id: string }).id;
    await server.app.request(`/api/admin/posts/${postId}/review`, {
      method: 'POST', headers: bearer, body: JSON.stringify({ status: 'approved' }),
    });
    // clock 不动：两条事件 at 完全相同，只能靠流水主键定序。
    await server.app.request(`/api/admin/posts/${postId}/withdraw`, { method: 'POST', headers: bearer });
    await server.app.request(`/api/admin/posts/${postId}/restore`, { method: 'POST', headers: bearer });

    const titles = (await notifications(alice)).items.filter(item => item.kind === 'post').map(item => item.title);
    expect(titles[0]).toContain('已恢复');
    expect(titles[1]).toContain('已下架');
  });

  it('举报评论时，通知链到评论所属的在线文章', async () => {
    const alice = await account('alice');
    const bob = await account('bob');
    const post = await alice.call('POST', '/api/posts', { kind: 'community', title: '带评论的文章', summary: 's', body: 'b' });
    const postId = (await post.json() as { id: string }).id;
    await server.app.request(`/api/admin/posts/${postId}/review`, {
      method: 'POST', headers: bearer, body: JSON.stringify({ status: 'approved' }),
    });
    const comment = await alice.call('POST', '/api/comments', { targetType: 'post', targetId: postId, content: '一句评论' });
    expect(comment.status).toBe(200);
    const commentId = (await comment.json() as { id: string }).id;
    const report = await bob.call('POST', '/api/reports', { targetType: 'comment', targetId: commentId, reason: '引战' });
    // 举报评论可能需要先存在（接口对评论目标有额外校验），先确认建出来了。
    expect(report.status).toBe(200);
    const reportId = (await report.json() as { id: string }).id;
    await server.app.request(`/api/admin/reports/${reportId}/resolve`, {
      method: 'POST', headers: bearer, body: JSON.stringify({ status: 'dismissed' }),
    });

    const item = (await notifications(bob)).items.find(entry => entry.kind === 'report')!;
    // 评论没有独立页面，回落到它所属的文章。
    expect(item.href).toBe(`/posts/${postId}`);
  });

  it('举报 status=dismissed 也算有结论', async () => {
    const alice = await account('alice');
    const bob = await account('bob');
    const post = await alice.call('POST', '/api/posts', { kind: 'community', title: '被驳回举报', summary: 's', body: 'b' });
    const postId = (await post.json() as { id: string }).id;
    await server.app.request(`/api/admin/posts/${postId}/review`, {
      method: 'POST', headers: bearer, body: JSON.stringify({ status: 'approved' }),
    });
    const report = await bob.call('POST', '/api/reports', { targetType: 'post', targetId: postId, reason: '不像广告' });
    const reportId = (await report.json() as { id: string }).id;
    await server.app.request(`/api/admin/reports/${reportId}/resolve`, {
      method: 'POST', headers: bearer, body: JSON.stringify({ status: 'dismissed' }),
    });
    const item = (await notifications(bob)).items.find(entry => entry.kind === 'report')!;
    expect(item.title).toBe('你举报的内容经核实没有问题');
  });

  it('重复下架只记一条流水', async () => {
    const alice = await account('alice');
    const post = await alice.call('POST', '/api/posts', { kind: 'community', title: '只下一次', summary: 's', body: 'b' });
    const postId = (await post.json() as { id: string }).id;
    await server.app.request(`/api/admin/posts/${postId}/review`, {
      method: 'POST', headers: bearer, body: JSON.stringify({ status: 'approved' }),
    });
    await server.app.request(`/api/admin/posts/${postId}/withdraw`, { method: 'POST', headers: bearer });
    // 第二次下架是 409，不能再记一条。
    const again = await server.app.request(`/api/admin/posts/${postId}/withdraw`, { method: 'POST', headers: bearer });
    expect(again.status).toBe(409);
    expect((await notifications(alice)).items.filter(item => item.kind === 'post')).toHaveLength(1);
  });

  it('未登录不能读通知', async () => {
    expect((await server.app.request('/api/me/notifications')).status).toBe(401);
  });
});
