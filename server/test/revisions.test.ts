import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/node-app.ts';

const PASSWORD = 'correct-horse-battery';
const json = { 'content-type': 'application/json' };
const TOKEN = 'admin-token-for-tests-0123456789abcdef';
const bearer = { ...json, authorization: `Bearer ${TOKEN}` };

let clock: Date;
let server: ReturnType<typeof createApp>;
beforeEach(() => {
  clock = new Date('2026-11-07T02:00:00Z');
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
    call: (method: string, path: string, body?: unknown) => server.app.request(path, {
      method, headers: { ...json, cookie }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  };
}
type Caller = Awaited<ReturnType<typeof account>>;

/** 造一篇已上线的文章，返回它的 id 与当前版本。 */
async function published(who: Caller, title = '初版标题') {
  const created = await who.call('POST', '/api/posts', { kind: 'community', title, summary: '初版摘要', body: '初版正文' });
  expect(created.status).toBe(200);
  const id = (await created.json() as { id: string }).id;
  const reviewed = await server.app.request(`/api/admin/posts/${id}/review`, {
    method: 'POST', headers: bearer, body: JSON.stringify({ status: 'approved' }),
  });
  expect(reviewed.status).toBe(200);
  return id;
}
const postOf = async (id: string) => (await (await server.app.request(`/api/posts/${id}`)).json()) as
  { title: string; body: string; contentVersion?: number; publishedAt: string; revisedAt?: string | null };
const revisionOf = async (who: Caller, id: string) => await (await who.call('GET', `/api/posts/${id}/revision`)).json() as {
  revision: { submissionId: string; status: string; payload: { title: string }; reviewReason: string | null } | null;
};

describe('编辑已发布文章', () => {
  it('提交修改后线上仍是旧版，作者能看到待审状态', async () => {
    const alice = await account('alice');
    const id = await published(alice);
    const before = await postOf(id);

    const submitted = await alice.call('PUT', `/api/posts/${id}/revision`, {
      kind: 'community', title: '改过的标题', summary: '改过的摘要', body: '改过的正文', baseVersion: 1,
    });
    expect(submitted.status).toBe(200);

    // 关键断言：**内容**没变，而不是只看 status。只看 status 的话，
    // 物化没生效也照样绿——那正是这个功能最核心的保证。
    const after = await postOf(id);
    expect(after.title).toBe(before.title);
    expect(after.body).toBe(before.body);
    expect(after.contentVersion ?? 1).toBe(1);

    // 作者视角：读得到自己那一版，且状态是 pending。
    const mine = await revisionOf(alice, id);
    expect(mine.revision?.status).toBe('pending');
    expect(mine.revision?.payload.title).toBe('改过的标题');
  });

  it('审核通过后内容切换、版本 +1，publishedAt 不变', async () => {
    const alice = await account('alice');
    const id = await published(alice);
    const before = await postOf(id);
    const submitted = await alice.call('PUT', `/api/posts/${id}/revision`, {
      kind: 'community', title: '改过的标题', summary: '改过的摘要', body: '改过的正文', baseVersion: 1,
    });
    const submissionId = (await submitted.json() as { submissionId: string }).submissionId;
    clock = new Date(clock.getTime() + 60_000);
    await server.app.request(`/api/admin/posts/${submissionId}/review`, {
      method: 'POST', headers: bearer, body: JSON.stringify({ status: 'approved' }),
    });

    const after = await postOf(id);
    expect(after.title).toBe('改过的标题');
    expect(after.body).toBe('改过的正文');
    expect(after.contentVersion).toBe(2);
    // publishedAt 必须严格等于编辑前那个字符串：改一篇老文不该让它重新上榜、
    // 跳进 RSS 最新、把 sitemap 的 lastmod 往后推。
    expect(after.publishedAt).toBe(before.publishedAt);
    expect(after.revisedAt).toBeTruthy();
  });

  it('驳回后线上内容逐字段不变，作者能看到理由', async () => {
    const alice = await account('alice');
    const id = await published(alice);
    const before = await postOf(id);
    const submitted = await alice.call('PUT', `/api/posts/${id}/revision`, {
      kind: 'community', title: '会被拒的标题', summary: '摘要', body: '正文', baseVersion: 1,
    });
    const submissionId = (await submitted.json() as { submissionId: string }).submissionId;
    clock = new Date(clock.getTime() + 60_000);
    await server.app.request(`/api/admin/posts/${submissionId}/review`, {
      method: 'POST', headers: bearer, body: JSON.stringify({ status: 'rejected', reason: '正文里写了绝对价格' }),
    });

    const after = await postOf(id);
    expect(after.title).toBe(before.title);
    expect(after.body).toBe(before.body);
    expect(after.contentVersion ?? 1).toBe(1);

    const mine = await revisionOf(alice, id);
    expect(mine.revision?.status).toBe('rejected');
    expect(mine.revision?.reviewReason).toBe('正文里写了绝对价格');
    // 驳回后预填的是被拒那一版，不是线上版。
    expect(mine.revision?.payload.title).toBe('会被拒的标题');
  });

  it('同一篇同时只能有一版待审；版本落后会被拒', async () => {
    const alice = await account('alice');
    const id = await published(alice);
    const body = { kind: 'community', title: '第一次改', summary: 's', body: 'b', baseVersion: 1 };
    expect((await alice.call('PUT', `/api/posts/${id}/revision`, body)).status).toBe(200);
    const again = await alice.call('PUT', `/api/posts/${id}/revision`, { ...body, title: '第二次改' });
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ error: { code: 'REVISION_PENDING' } });

    // 撤回之后再提交就通了。
    expect((await alice.call('DELETE', `/api/posts/${id}/revision`)).status).toBe(200);
    expect((await alice.call('PUT', `/api/posts/${id}/revision`, { ...body, title: '撤回后再改' })).status).toBe(200);

    // 反过来：先让一版通过把 contentVersion 推到 2，再用 baseVersion=1 提交。
    const pending = await revisionOf(alice, id);
    clock = new Date(clock.getTime() + 60_000);
    await server.app.request(`/api/admin/posts/${pending.revision!.submissionId}/review`, {
      method: 'POST', headers: bearer, body: JSON.stringify({ status: 'approved' }),
    });
    const stale = await alice.call('PUT', `/api/posts/${id}/revision`, { ...body, baseVersion: 1 });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ error: { code: 'STALE_REVISION' } });
  });

  it('别人不能编辑、撤回我的文章，也读不到我的修改', async () => {
    const alice = await account('alice');
    const bob = await account('bob');
    const id = await published(alice);
    const body = { kind: 'community', title: '改', summary: 's', body: 'b', baseVersion: 1 };
    expect((await bob.call('PUT', `/api/posts/${id}/revision`, body)).status).toBe(404);
    expect((await bob.call('GET', `/api/posts/${id}/revision`)).status).toBe(404);
    expect((await bob.call('DELETE', `/api/posts/${id}/revision`)).status).toBe(404);
    expect((await alice.call('PUT', `/api/posts/${id}/revision`, body)).status).toBe(200);
    expect((await bob.call('DELETE', `/api/posts/${id}/revision`)).status).toBe(404);
  });

  it('编辑稿不出现在「我的投稿」里，也不会变成一篇新文章', async () => {
    const alice = await account('alice');
    const id = await published(alice);
    const submitted = await alice.call('PUT', `/api/posts/${id}/revision`, {
      kind: 'community', title: '改过的标题', summary: 's', body: 'b', baseVersion: 1,
    });
    const submissionId = (await submitted.json() as { submissionId: string }).submissionId;

    const submissions = await (await alice.call('GET', '/api/me/submissions?pageSize=50')).json() as { items: Array<{ id: string }> };
    expect(submissions.items.map(item => item.id)).not.toContain(submissionId);
    // 用队列 id 也读不到「一篇文章」——**以作者身份**试，否则匿名请求必然 401/404，
    // 这条断言就永远成立、删掉过滤也照样绿。
    expect((await alice.call('GET', `/api/posts/${submissionId}`)).status).toBe(404);

    // 「我的分享」仍只有原来那一篇，并且带着待审修改的标记。
    const mine = await (await alice.call('GET', '/api/me/posts?pageSize=50')).json() as {
      items: Array<{ id: string; pendingRevision?: { id: string } | null }>;
    };
    expect(mine.items.filter(item => item.id === id)).toHaveLength(1);
    expect(mine.items.find(item => item.id === id)!.pendingRevision?.id).toBe(submissionId);
  });

  it('文章下架后待审修改自动作废，并说明原因', async () => {
    const alice = await account('alice');
    const id = await published(alice);
    await alice.call('PUT', `/api/posts/${id}/revision`, {
      kind: 'community', title: '改到一半', summary: 's', body: 'b', baseVersion: 1,
    });
    await server.app.request(`/api/admin/posts/${id}/withdraw`, { method: 'POST', headers: bearer });

    const mine = await revisionOf(alice, id);
    expect(mine.revision?.status).toBe('rejected');
    expect(mine.revision?.reviewReason).toContain('作废');
  });

  it('编辑结果进通知，链接指回原来那篇文章', async () => {
    const alice = await account('alice');
    const id = await published(alice);
    const submitted = await alice.call('PUT', `/api/posts/${id}/revision`, {
      kind: 'community', title: '改过的标题', summary: 's', body: 'b', baseVersion: 1,
    });
    const submissionId = (await submitted.json() as { submissionId: string }).submissionId;
    clock = new Date(clock.getTime() + 60_000);
    await server.app.request(`/api/admin/posts/${submissionId}/review`, {
      method: 'POST', headers: bearer, body: JSON.stringify({ status: 'approved' }),
    });

    const notices = await (await alice.call('GET', '/api/me/notifications?pageSize=50')).json() as {
      items: Array<{ kind: string; title: string; href: string | null }>;
    };
    const notice = notices.items.find(item => item.title.includes('文章修改'))!;
    expect(notice.title).toContain('已上线');
    expect(notice.href).toBe(`/posts/${id}`);
  });

  it('举报被判不成立后：内容没改仍然拦住，改过一版就允许再报', async () => {
    const alice = await account('alice');
    const bob = await account('bob');
    const id = await published(alice);
    const report = await bob.call('POST', '/api/reports', { targetType: 'post', targetId: id, reason: '像广告' });
    const reportId = (await report.json() as { id: string }).id;
    await server.app.request(`/api/admin/reports/${reportId}/resolve`, {
      method: 'POST', headers: bearer, body: JSON.stringify({ status: 'dismissed', note: '看过，没问题' }),
    });

    // 没改动：仍然拦住。这一半和另一半都要有，只测「改过能再报」的话，
    // 把整个判断删掉也照样绿。
    const blocked = await bob.call('POST', '/api/reports', { targetType: 'post', targetId: id, reason: '还是像广告' });
    expect(blocked.status).toBe(409);
    expect(await blocked.json()).toMatchObject({ error: { code: 'ALREADY_DISMISSED' } });

    // 作者改一版并通过 → 版本涨了 → 同一人可以再报。
    const submitted = await alice.call('PUT', `/api/posts/${id}/revision`, {
      kind: 'community', title: '新版标题', summary: 's', body: '广告味更浓的正文', baseVersion: 1,
    });
    const submissionId = (await submitted.json() as { submissionId: string }).submissionId;
    clock = new Date(clock.getTime() + 60_000);
    await server.app.request(`/api/admin/posts/${submissionId}/review`, {
      method: 'POST', headers: bearer, body: JSON.stringify({ status: 'approved' }),
    });
    const again = await bob.call('POST', '/api/reports', { targetType: 'post', targetId: id, reason: '改完还是广告' });
    expect(again.status).toBe(200);
  });

  it('详情页只对作者挂 pendingRevision，读者拿不到', async () => {
    const alice = await account('alice');
    const bob = await account('bob');
    const id = await published(alice);
    await alice.call('PUT', `/api/posts/${id}/revision`, {
      kind: 'community', title: '改', summary: 's', body: 'b', baseVersion: 1,
    });
    const mine = await (await alice.call('GET', `/api/posts/${id}`)).json() as { pendingRevision?: { id: string } | null };
    expect(mine.pendingRevision?.id).toBeTruthy();
    // 读者拿到这个字段会以为线上内容要变了，而他们看到的就是最终版本。
    const other = await (await bob.call('GET', `/api/posts/${id}`)).json() as { pendingRevision?: unknown };
    expect(other.pendingRevision ?? null).toBeNull();
    const anon = await (await server.app.request(`/api/posts/${id}`)).json() as { pendingRevision?: unknown };
    expect(anon.pendingRevision ?? null).toBeNull();
  });

  it('「分享 N」不把待审编辑算成一篇', async () => {
    const alice = await account('alice');
    const id = await published(alice);
    const before = (await (await alice.call('GET', '/api/me')).json() as { shareCount: number }).shareCount;
    await alice.call('PUT', `/api/posts/${id}/revision`, {
      kind: 'community', title: '改', summary: 's', body: 'b', baseVersion: 1,
    });
    expect((await (await alice.call('GET', '/api/me')).json() as { shareCount: number }).shareCount).toBe(before);
  });

  it('审核通过之后再读修改，拿到的是 null 而不是一条 approved 行', async () => {
    const alice = await account('alice');
    const id = await published(alice);
    const submitted = await alice.call('PUT', `/api/posts/${id}/revision`, {
      kind: 'community', title: '改', summary: 's', body: 'b', baseVersion: 1,
    });
    const submissionId = (await submitted.json() as { submissionId: string }).submissionId;
    await server.app.request(`/api/admin/posts/${submissionId}/review`, {
      method: 'POST', headers: bearer, body: JSON.stringify({ status: 'approved' }),
    });
    const mine = await revisionOf(alice, id);
    expect(mine.revision).toBeNull();
  });

  it('文章被管理员改判未通过时，待审修改一并作废', async () => {
    const alice = await account('alice');
    const id = await published(alice);
    await alice.call('PUT', `/api/posts/${id}/revision`, {
      kind: 'community', title: '改', summary: 's', body: 'b', baseVersion: 1,
    });
    await server.app.request(`/api/admin/posts/${id}/review`, {
      method: 'POST', headers: bearer, body: JSON.stringify({ status: 'rejected', reason: '内容不合格' }),
    });
    const mine = await revisionOf(alice, id);
    expect(mine.revision?.status).toBe('rejected');
    expect(mine.revision?.reviewReason).toContain('作废');
  });

  it('审核台的「待审投稿」里不出现编辑稿（它在「待审文章」里带新版本标记）', async () => {
    const alice = await account('alice');
    const id = await published(alice);
    const submitted = await alice.call('PUT', `/api/posts/${id}/revision`, {
      kind: 'community', title: '改', summary: '初版摘要', body: '初版正文', baseVersion: 1,
    });
    const submissionId = (await submitted.json() as { submissionId: string }).submissionId;

    const queue = await (await server.app.request('/api/admin/submissions?status=pending', { headers: bearer })).json() as
      { items: Array<{ id: string }> };
    expect(queue.items.map(item => item.id)).not.toContain(submissionId);

    const posts = await (await server.app.request('/api/admin/posts?status=pending', { headers: bearer })).json() as
      { items: Array<{ id: string; editOf?: string | null; changedFields?: string[] }> };
    const edit = posts.items.find(item => item.id === submissionId)!;
    expect(edit.editOf).toBe(id);
    expect(edit.changedFields).toEqual(['title']);
  });

  it('同一时刻的两次编辑不会把顺序写乱（版本号单调）', async () => {
    const alice = await account('alice');
    const id = await published(alice);
    // clock 不动：两次提交与审核都发生在同一毫秒。
    for (const title of ['第二版', '第三版']) {
      const submitted = await alice.call('PUT', `/api/posts/${id}/revision`, {
        kind: 'community', title, summary: 's', body: 'b',
        baseVersion: (await postOf(id)).contentVersion ?? 1,
      });
      expect(submitted.status).toBe(200);
      const submissionId = (await submitted.json() as { submissionId: string }).submissionId;
      await server.app.request(`/api/admin/posts/${submissionId}/review`, {
        method: 'POST', headers: bearer, body: JSON.stringify({ status: 'approved' }),
      });
    }
    expect((await postOf(id)).contentVersion).toBe(3);
  });
});
