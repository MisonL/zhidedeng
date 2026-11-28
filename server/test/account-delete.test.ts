import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/node-app.ts';

const PASSWORD = 'correct-horse-battery';
const json = { 'content-type': 'application/json' };
const TOKEN = 'admin-token-for-tests-0123456789abcdef';
const bearer = { ...json, authorization: `Bearer ${TOKEN}` };

let clock: Date;
let server: ReturnType<typeof createApp>;
beforeEach(() => {
  clock = new Date('2026-11-08T03:00:00Z');
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
    cookie,
    call: (method: string, path: string, body?: unknown) => server.app.request(path, {
      method, headers: { ...json, cookie }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    del: (body: unknown) => server.app.request('/api/me/delete', {
      method: 'POST', headers: { ...json, cookie }, body: JSON.stringify(body),
    }),
  };
}
type Caller = Awaited<ReturnType<typeof account>>;
const ok = { password: PASSWORD, confirm: '注销' };

describe('注销账号', () => {
  it('注销后旧会话立刻失效，登录也进不去', async () => {
    const alice = await account('alice');
    const response = await alice.del(ok);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true });
    // 响应要顺手清 cookie，否则浏览器会带着一个无效会话反复 401。
    expect(response.headers.get('set-cookie')).toContain('session=');

    // 关键：拿**旧 cookie** 重放，而不是只用 logout 判断「会话失效」。
    expect((await alice.call('GET', '/api/me')).status).toBe(401);
    // 两层防线各自都要有断言，否则删掉任一层都测不出来（另一层还挡着）：
    // 1) 会话行真的被删了（不是只靠读的时候过滤）；
    // 2) 就算有人手工把 sessions 行塞回来，读取端也认 accounts.deletedAt。
    expect(server.db.prepare('SELECT count(*) AS c FROM sessions WHERE handle = ?').get('alice')).toEqual({ c: 0 });
    // 过期时间必须真的在未来：会话校验是 `expiresAt > now`，塞等于现在的值
    // 会因「已过期」而 401，这条断言就又成了假绿。
    const future = new Date(clock.getTime() + 86_400_000).toISOString();
    // 必须塞**哈希后**的 token：会话表存的是 sha256，塞原串永远查不到。
    const token = alice.cookie.replace('session=', '');
    server.db.prepare('INSERT INTO sessions (tokenHash, handle, expiresAt) VALUES (?, ?, ?)')
      .run(createHash('sha256').update(token).digest('hex'), 'alice', future);
    expect((await alice.call('GET', '/api/me')).status).toBe(401);
    const login = await server.app.request('/api/auth/login', {
      method: 'POST', headers: json, body: JSON.stringify({ username: 'alice', password: PASSWORD }),
    });
    expect(login.status).toBe(401);
  });

  it('口令或确认短语不对时不注销', async () => {
    const alice = await account('alice');
    expect((await alice.del({ ...ok, password: 'wrong-password-here' })).status).toBe(400);
    expect((await alice.del({ ...ok, confirm: '删除' })).status).toBe(400);
    expect((await alice.call('GET', '/api/me')).status).toBe(200);
  });

  it('用户名永久占用：同名（含大小写变体）重注册被拒', async () => {
    const alice = await account('alice');
    await alice.del(ok);
    for (const username of ['alice', 'ALICE', 'Alice']) {
      const again = await server.app.request('/api/auth/register', {
        method: 'POST', headers: json, body: JSON.stringify({ username, password: PASSWORD, nickname: 'x' }),
      });
      expect(again.status).toBe(409);
    }
  });

  it('文章保留、署名降级成占位名、作者主页 404', async () => {
    const alice = await account('alice');
    const created = await alice.call('POST', '/api/posts', { kind: 'community', title: '留下的文章', summary: 's', body: 'b' });
    const id = (await created.json() as { id: string }).id;
    await server.app.request(`/api/admin/posts/${id}/review`, {
      method: 'POST', headers: bearer, body: JSON.stringify({ status: 'approved' }),
    });

    await alice.del(ok);

    const post = await server.app.request(`/api/posts/${id}`);
    expect(post.status).toBe(200);
    const body = await post.json() as { title: string; author: { nickname: string } };
    expect(body.title).toBe('留下的文章');
    expect(body.author.nickname).toContain('已注销用户');
    expect((await server.app.request('/api/users/alice')).status).toBe(404);
  });

  it('评论保留楼层与回复，父评论不会变成墓碑', async () => {
    const alice = await account('alice');
    const bob = await account('bob');
    const created = await alice.call('POST', '/api/posts', { kind: 'community', title: '带评论', summary: 's', body: 'b' });
    const postId = (await created.json() as { id: string }).id;
    await server.app.request(`/api/admin/posts/${postId}/review`, {
      method: 'POST', headers: bearer, body: JSON.stringify({ status: 'approved' }),
    });
    const parent = await alice.call('POST', '/api/comments', { targetType: 'post', targetId: postId, content: '楼主的评论' });
    const parentId = (await parent.json() as { id: string }).id;
    await bob.call('POST', '/api/comments', { targetType: 'post', targetId: postId, content: '回复', parentId });

    await alice.del(ok);

    const comments = await (await bob.call('GET', `/api/comments?targetType=post&targetId=${postId}`)).json() as {
      items: Array<{ content: string; author: { nickname: string }; replies?: Array<{ content: string }> }>;
    };
    expect(comments.items).toHaveLength(1);
    expect(comments.items[0].content).toBe('楼主的评论');
    expect(comments.items[0].author.nickname).toContain('已注销用户');
    expect(comments.items[0].replies?.[0].content).toBe('回复');
  });

  it('投票与收藏被清掉，计数随之下降', async () => {
    const alice = await account('alice');
    const bob = await account('bob');
    const created = await bob.call('POST', '/api/posts', { kind: 'community', title: '被投票的', summary: 's', body: 'b' });
    const id = (await created.json() as { id: string }).id;
    await server.app.request(`/api/admin/posts/${id}/review`, {
      method: 'POST', headers: bearer, body: JSON.stringify({ status: 'approved' }),
    });
    await alice.call('PUT', '/api/votes', { targetType: 'post', targetId: id, value: 'up' });
    await alice.call('PUT', '/api/favorites', { targetType: 'post', targetId: id, favorited: true });
    expect((await (await bob.call('GET', `/api/posts/${id}`)).json() as { votes: { total: number } }).votes.total).toBe(1);

    await alice.del(ok);
    expect((await (await bob.call('GET', `/api/posts/${id}`)).json() as { votes: { total: number } }).votes.total).toBe(0);
  });

  it('待审投稿落 rejected，不再占待审配额', async () => {
    const alice = await account('alice');
    await alice.call('POST', '/api/posts', { kind: 'community', title: '没审完的稿', summary: 's', body: 'b' });
    const before = await (await server.app.request('/api/admin/submissions?status=pending', { headers: bearer })).json() as
      { total: number };
    expect(before.total).toBe(1);
    await alice.del(ok);
    const after = await (await server.app.request('/api/admin/submissions?status=pending', { headers: bearer })).json() as
      { total: number };
    expect(after.total).toBe(0);
  });

  it('Agent 凭证立刻吊销', async () => {
    const alice = await account('alice');
    // 准入：满 7 天或有已通过投稿。直接改账号创建时间最省事。
    server.db.prepare('UPDATE accounts SET createdAt = ? WHERE handle = ?').run('2026-10-01T00:00:00.000Z', 'alice');
    const issued = await alice.call('POST', '/api/account/agent-tokens', { label: '我的脚本' });
    expect(issued.status).toBe(200);
    const token = (await issued.json() as { token: string }).token;
    const status = () => server.app.request('/api/agent/status', { headers: { authorization: `Bearer ${token}` } });
    expect((await status()).status).toBe(200);

    await alice.del(ok);
    expect((await status()).status).toBe(401);
    // 同样两层：凭证行被标了 revokedAt，而且读取端认 deletedAt。
    const revoked = server.db.prepare('SELECT revokedAt FROM agent_tokens WHERE handle = ?').get('alice') as { revokedAt: string | null };
    expect(revoked.revokedAt).not.toBeNull();
    server.db.prepare('UPDATE agent_tokens SET revokedAt = NULL WHERE handle = ?').run('alice');
    expect((await status()).status).toBe(401);
  });

  it('重复注销：旧 cookie 已经无效，只会 401，时间不变', async () => {
    const alice = await account('alice');
    await alice.del(ok);
    const first = server.db.prepare('SELECT deletedAt FROM accounts WHERE handle = ?').get('alice') as { deletedAt: string };
    const again = await alice.del(ok);
    expect(again.status).toBe(401);
    const second = server.db.prepare('SELECT deletedAt FROM accounts WHERE handle = ?').get('alice') as { deletedAt: string };
    expect(second.deletedAt).toBe(first.deletedAt);
  });

  it('未登录调注销是 401', async () => {
    const response = await server.app.request('/api/me/delete', {
      method: 'POST', headers: json, body: JSON.stringify(ok),
    });
    expect(response.status).toBe(401);
  });

  it('管理员能看到已注销账号并恢复，恢复后能登录', async () => {
    const alice = await account('alice');
    const created = await alice.call('POST', '/api/posts', { kind: 'community', title: '留下的', summary: 's', body: 'b' });
    const id = (await created.json() as { id: string }).id;
    await server.app.request(`/api/admin/posts/${id}/review`, {
      method: 'POST', headers: bearer, body: JSON.stringify({ status: 'approved' }),
    });
    await alice.del(ok);

    const list = await (await server.app.request('/api/admin/accounts/deleted', { headers: bearer })).json() as
      { items: Array<{ handle: string; postCount: number }> };
    expect(list.items.map(item => item.handle)).toEqual(['alice']);
    expect(list.items[0].postCount).toBe(1);

    const restored = await server.app.request('/api/admin/accounts/alice/restore', { method: 'POST', headers: bearer });
    expect(restored.status).toBe(200);
    const login = await server.app.request('/api/auth/login', {
      method: 'POST', headers: json, body: JSON.stringify({ username: 'alice', password: PASSWORD }),
    });
    expect(login.status).toBe(200);
    // 昵称回落为 handle：旧昵称在注销时已经删了，凭空造一个只会让人以为没注销过。
    expect((await login.json() as { nickname: string }).nickname).toBe('alice');
    // 文章署名跟着恢复。
    expect(((await (await server.app.request(`/api/posts/${id}`)).json()) as { author: { nickname: string } }).author.nickname).toBe('alice');
  });

  it('恢复一个没注销的账号是 409', async () => {
    await account('alice');
    const response = await server.app.request('/api/admin/accounts/alice/restore', { method: 'POST', headers: bearer });
    expect(response.status).toBe(409);
  });

  it('演示账号与不存在会话互不影响：另一个用户照常可用', async () => {
    const alice = await account('alice');
    const bob = await account('bob');
    await alice.del(ok);
    expect((await bob.call('GET', '/api/me')).status).toBe(200);
    // 注销只清自己的会话。
    expect(server.db.prepare('SELECT count(*) AS c FROM sessions WHERE handle = ?').get('bob')).toEqual({ c: 1 });
  });
});
