import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSession, hashPassword, INITIAL_TOKENS } from '../src/auth.ts';
import { buildApp } from '../src/app.ts';
import type { PostRecord } from '../src/database.ts';
import { createApp, openStore } from '../src/node-app.ts';

const PATH = '/api/account/agent-tokens';
const START = '2026-11-08T04:00:00.000Z';
const DAY_MS = 86_400_000;
const json = { 'content-type': 'application/json' };
let clock: Date;
let server: ReturnType<typeof createApp>;
let passwordHash: string;

beforeAll(async () => { passwordHash = await hashPassword('agent-tests-correct-horse'); });
beforeEach(() => {
  clock = new Date(START);
  vi.stubEnv('INVITE_CODES', ' invite-first , ,invite-second, ');
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  server = createApp({ dbPath: ':memory:', now: () => clock });
});
afterEach(() => {
  server.db.close();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function account(handle = 'Alice', createdAt = new Date(clock.getTime() - 8 * DAY_MS).toISOString()) {
  const store = openStore(server.db);
  server.db.prepare('INSERT INTO accounts (handle, usernameKey, passwordHash, createdAt) VALUES (?, ?, ?, ?)')
    .run(handle, handle.toLowerCase(), passwordHash, createdAt);
  store.put('user', handle, { handle, nickname: handle, avatar: '', bio: '', tokens: INITIAL_TOKENS });
  return 'session=' + createSession(store, handle, clock);
}

function post(patch: Partial<PostRecord> = {}) {
  const record: PostRecord = {
    id: 'eligibility-post', kind: 'guide', title: '准入投稿', summary: '测试摘要', body: '测试正文',
    authorHandle: 'Alice', stationSlug: null, modelSlug: null, cover: null,
    publishedAt: START, status: 'approved', ...patch,
  };
  openStore(server.db).put('post', record.id, record);
}

function issue(cookie: string, body: unknown = { label: '测试 Agent' }) {
  return server.app.request(PATH, { method: 'POST', headers: { ...json, cookie }, body: JSON.stringify(body) });
}
function list(cookie: string, query = '') {
  return server.app.request(PATH + query, { headers: { cookie } });
}
function revoke(cookie: string, id: string) {
  return server.app.request(PATH + '/' + encodeURIComponent(id), { method: 'DELETE', headers: { ...json, cookie } });
}
async function issued(cookie: string, body: unknown = { label: '测试 Agent' }) {
  const response = await issue(cookie, body);
  expect(response.status).toBe(200);
  return await response.json() as { id: string; token: string; tokenPrefix: string; label: string; createdAt: string };
}
const count = () => Number(server.db.prepare('SELECT count(*) AS count FROM agent_tokens').get()!.count);

describe('Agent 凭证签发与秘密边界', () => {
  it('返回 32 字节随机凭证，只保存 SHA-256 和展示前缀，哈希可反查', async () => {
    const result = await issued(account(), { label: '  本地 Agent  ' });
    expect(result.token).toMatch(/^zd_[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(result.token.slice(3), 'base64url')).toHaveLength(32);
    expect(result).toEqual({
      id: expect.any(String), token: expect.any(String), tokenPrefix: result.token.slice(0, 8) + '\u2026',
      label: '本地 Agent', createdAt: START,
    });
    const hash = createHash('sha256').update(result.token).digest('hex');
    const row = server.db.prepare('SELECT * FROM agent_tokens WHERE tokenHash = ?').get(hash)!;
    expect(row).toMatchObject({
      id: result.id, handle: 'Alice', tokenHash: hash, tokenPrefix: result.tokenPrefix,
      lastUsedAt: null, revokedAt: null, useCount: 0,
    });
    expect(row.tokenHash).not.toBe(result.token);
    expect(row).not.toHaveProperty('token');
    expect(JSON.stringify(row)).not.toContain(result.token);
  });

  it('相同标签重复签发仍使用独立的随机凭证和 id', async () => {
    const cookie = account();
    const first = await issued(cookie);
    const second = await issued(cookie);
    expect(second.id).not.toBe(first.id);
    expect(second.token).not.toBe(first.token);
    expect(count()).toBe(2);
  });

  it('列表只返回本人的公开元数据，永远不返回明文或哈希', async () => {
    const alice = account();
    const first = await issued(alice, { label: '第一个' });
    clock = new Date(clock.getTime() + 1000);
    const second = await issued(alice, { label: '第二个' });
    await issued(account('Bobby'), { label: '其他账号' });
    server.db.prepare('UPDATE agent_tokens SET lastUsedAt = ?, useCount = ? WHERE id = ?').run(START, 7, first.id);
    const response = await list(alice, '?handle=Bobby');
    expect(response.status).toBe(200);
    const items = await response.json() as Record<string, unknown>[];
    expect(items).toEqual([
      { id: second.id, label: '第二个', tokenPrefix: second.tokenPrefix, createdAt: clock.toISOString(), lastUsedAt: null, useCount: 0, revokedAt: null, status: 'active' },
      { id: first.id, label: '第一个', tokenPrefix: first.tokenPrefix, createdAt: START, lastUsedAt: START, useCount: 7, revokedAt: null, status: 'active' },
    ]);
    for (const item of items) {
      expect(item).not.toHaveProperty('token');
      expect(item).not.toHaveProperty('tokenHash');
      expect(item).not.toHaveProperty('handle');
    }
    expect(JSON.stringify(items)).not.toContain(first.token);
  });

  it('尚未满足签发准入的账号也能列出自己的空列表', async () => {
    const response = await list(account('Alice', START));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([]);
  });
});

describe('三选一准入', () => {
  it.each([
    ['刚好七天', 7 * DAY_MS, 200],
    ['还差一毫秒', 7 * DAY_MS - 1, 403],
    ['已经八天', 8 * DAY_MS, 200],
    ['刚注册', 0, 403],
    ['未来时间', -DAY_MS, 403],
  ])('注册时长：%s', async (_name, elapsed, status) => {
    const response = await issue(account('Alice', new Date(clock.getTime() - elapsed).toISOString()));
    expect(response.status).toBe(status);
    if (status === 403) {
      const body = await response.json();
      expect(body).toMatchObject({ error: { code: 'ELIGIBILITY_REQUIRED' } });
      expect(body.error.message).toContain('7 天');
      expect(body.error.message).toContain('投稿');
      expect(body.error.message).toContain('邀请码');
      expect(count()).toBe(0);
    }
  });

  it.each(['', 'not-a-date'])('无有效注册时间 %j 不能走时长准入', async createdAt => {
    const response = await issue(account('Alice', createdAt));
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: 'ELIGIBILITY_REQUIRED' } });
  });

  it.each([
    ['省略 source 的站内投稿', { status: 'approved' }, 200],
    ['显式用户来源', { source: 'user', status: 'approved' }, 200],
    // agent 和飞书通道的 authorHandle 取自 payload，可以被冒用，不能用来准入。
    ['Agent 通道投稿', { source: 'agent', status: 'approved' }, 403],
    ['飞书同步投稿', { source: 'submission', status: 'approved' }, 403],
    ['演示文章', { source: 'demo', status: 'approved' }, 403],
    ['待审核', { status: 'pending' }, 403],
    ['已拒绝', { status: 'rejected' }, 403],
    ['别人的文章', { authorHandle: 'Bobby', status: 'approved' }, 403],
  ] as const)('投稿准入：%s', async (_name, patch, status) => {
    const cookie = account('Alice', START);
    post(patch);
    const response = await issue(cookie);
    expect(response.status).toBe(status);
    if (status === 403) expect(await response.json()).toMatchObject({ error: { code: 'ELIGIBILITY_REQUIRED' } });
  });

  it('真实站内投稿先 pending，管理员审核通过后立即满足准入', async () => {
    const cookie = account('Alice', START);
    const created = await server.app.request('/api/posts', {
      method: 'POST', headers: { ...json, cookie }, body: JSON.stringify({ kind: 'guide', title: '真实投稿链路', summary: '摘要', body: '正文' }),
    });
    expect(created.status).toBe(200);
    const submitted = await created.json() as { id: string };
    // 站内投稿现在先进队列，审核通过才物化到 entities。
    expect(openStore(server.db).get('post', submitted.id)).toBeUndefined();
    expect((await issue(cookie)).status).toBe(403);
    const adminToken = 'agent-test-admin-0123456789abcdef';
    const app = buildApp(openStore(server.db), () => clock, { syncToken: adminToken });
    const reviewed = await app.request('/api/admin/posts/' + submitted.id + '/review', {
      method: 'POST', headers: { ...json, authorization: 'Bearer ' + adminToken }, body: JSON.stringify({ status: 'approved' }),
    });
    expect(reviewed.status).toBe(200);
    expect((await issue(cookie)).status).toBe(200);
  });

  it('agent 通道代写投稿不能用来满足准入', async () => {
    // 0 天新号，本来必须被拒。
    const cookie = account('Mallory', START);
    expect((await issue(cookie)).status).toBe(403);
    // 通过 agent 通道挂一篇 authorHandle 写成 Mallory 的投稿并审核通过。
    const adminToken = 'agent-test-admin-0123456789abcdef';
    const admin = buildApp(openStore(server.db), () => clock, { syncToken: adminToken });
    const queued = await admin.request('/api/admin/submissions', {
      method: 'POST', headers: { ...json, authorization: 'Bearer ' + adminToken },
      body: JSON.stringify({ kind: 'post', channel: 'agent', originKey: 'forged-1',
        payload: { title: '伪造评价', summary: '摘要', body: '正文', authorName: 'Mallory', authorHandle: 'Mallory' } }),
    });
    expect(queued.status).toBe(200);
    const submission = await queued.json() as { submission: { id: string } };
    const reviewed = await admin.request('/api/admin/submissions/' + submission.submission.id + '/review', {
      method: 'POST', headers: { ...json, authorization: 'Bearer ' + adminToken }, body: JSON.stringify({ status: 'approved' }),
    });
    expect(reviewed.status).toBe(200);
    // 投稿确实落地并记在 Mallory 名下，但它是 agent 来源。
    expect(openStore(server.db).all('post').find(p => p.authorHandle === 'Mallory')).toMatchObject({ source: 'agent' });
    // 准入仍然必须拒绝。
    expect((await issue(cookie)).status).toBe(403);
  });

  it.each(['invite-first', 'invite-second', '  invite-second  '])('环境变量逗号分隔的邀请码 %j 可单独准入', async inviteCode => {
    expect((await issue(account('Alice', START), { label: '受邀 Agent', inviteCode })).status).toBe(200);
  });

  it.each([undefined, 'unknown-code', 'INVITE-FIRST'])('缺失或无效邀请码 %j 不满足准入', async inviteCode => {
    const response = await issue(account('Alice', START), { label: 'Agent', inviteCode });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: 'ELIGIBILITY_REQUIRED' } });
    expect(count()).toBe(0);
  });

  it('未配置邀请码时不接受任意邀请码', async () => {
    vi.stubEnv('INVITE_CODES', ' , , ');
    server.db.close();
    server = createApp({ dbPath: ':memory:', now: () => clock });
    expect((await issue(account('Alice', START), { label: 'Agent', inviteCode: 'invite-first' })).status).toBe(403);
  });

  it('三项条件互为替代，注册满七天不会因错误邀请码被拒绝', async () => {
    expect((await issue(account(), { label: 'Agent', inviteCode: 'wrong-code' })).status).toBe(200);
  });
});

describe('账号上限与吊销', () => {
  it('最多五个活跃凭证，第六个返回 409 TOKEN_LIMIT', async () => {
    const cookie = account();
    for (let index = 0; index < 5; index++) await issued(cookie);
    const response = await issue(cookie);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: 'TOKEN_LIMIT' } });
    expect(count()).toBe(5);
  });

  it('并发签发不能绕过上限，其他账号有独立名额', async () => {
    const cookie = account();
    const responses = await Promise.all(Array.from({ length: 8 }, () => issue(cookie)));
    expect(responses.filter(response => response.status === 200)).toHaveLength(5);
    expect(responses.filter(response => response.status === 409)).toHaveLength(3);
    expect((await issue(account('Bobby'))).status).toBe(200);
    expect(count()).toBe(6);
  });

  it('吊销保留记录，使用注入时间，列表标记 revoked 并释放活跃名额', async () => {
    const cookie = account();
    const first = await issued(cookie);
    for (let index = 0; index < 4; index++) await issued(cookie);
    clock = new Date(clock.getTime() + 60_000);
    const response = await revoke(cookie, first.id);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id: first.id, revokedAt: clock.toISOString() });
    expect(server.db.prepare('SELECT * FROM agent_tokens WHERE id = ?').get(first.id)).toMatchObject({ revokedAt: clock.toISOString(), useCount: 0 });
    const items = await (await list(cookie)).json() as { id: string; status: string; revokedAt: string | null }[];
    expect(items.find(item => item.id === first.id)).toMatchObject({ status: 'revoked', revokedAt: clock.toISOString() });
    expect((await issue(cookie)).status).toBe(200);
    expect(count()).toBe(6);
  });

  it('重复吊销幂等，保留首次时间并只记录一次吊销审计', async () => {
    const cookie = account();
    const result = await issued(cookie);
    await revoke(cookie, result.id);
    clock = new Date(clock.getTime() + DAY_MS);
    const repeated = await revoke(cookie, result.id);
    expect(repeated.status).toBe(200);
    expect(await repeated.json()).toEqual({ id: result.id, revokedAt: START });
    const events = vi.mocked(console.info).mock.calls.map(([value]) => JSON.parse(value as string));
    expect(events.filter(event => event.action === 'agent_token.revoked')).toHaveLength(1);
  });

  it('不能吊销别人的凭证，不存在的 id 与他人的 id 均返回 404', async () => {
    const result = await issued(account());
    const bobby = account('Bobby');
    for (const id of [result.id, 'missing-id', "' OR 1=1 --"]) {
      const response = await revoke(bobby, id);
      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
    }
    expect(server.db.prepare('SELECT revokedAt FROM agent_tokens WHERE id = ?').get(result.id)?.revokedAt).toBeNull();
  });

  it('准入条件之后不再满足，仍允许本人列出和吊销现有凭证', async () => {
    const cookie = account('Alice', START);
    post();
    const result = await issued(cookie);
    post({ status: 'rejected' });
    expect((await issue(cookie)).status).toBe(403);
    expect((await list(cookie)).status).toBe(200);
    expect((await revoke(cookie, result.id)).status).toBe(200);
  });
});

describe('会话鉴权与请求边界', () => {
  it.each(['无会话', '伪造会话', '会话过期', '账号禁用', 'Agent 明文代替会话'])('%s 时三个接口均返回 401', async reason => {
    const valid = account();
    const token = await issued(valid);
    let cookie = valid;
    if (reason === '无会话') cookie = '';
    if (reason === '伪造会话') cookie = 'session=' + 'a'.repeat(43);
    if (reason === '会话过期') clock = new Date(clock.getTime() + 30 * DAY_MS);
    if (reason === '账号禁用') server.db.prepare('UPDATE accounts SET disabledAt = ? WHERE handle = ?').run(START, 'Alice');
    if (reason === 'Agent 明文代替会话') cookie = 'session=' + token.token;
    for (const response of [await issue(cookie), await list(cookie), await revoke(cookie, token.id)]) {
      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({ error: { code: 'UNAUTHENTICATED' } });
    }
    expect(count()).toBe(1);
    expect(server.db.prepare('SELECT revokedAt FROM agent_tokens WHERE id = ?').get(token.id)?.revokedAt).toBeNull();
  });

  it('管理员 Bearer 不能代替账户会话', async () => {
    const response = await server.app.request(PATH, { method: 'POST', headers: { ...json, authorization: 'Bearer admin-only' }, body: JSON.stringify({ label: 'Agent' }) });
    expect(response.status).toBe(401);
  });

  it.each([
    {}, { label: '' }, { label: '   ' }, { label: 123 }, { label: 'x'.repeat(101) },
    { label: 'Agent', inviteCode: 123 }, { label: 'Agent', handle: 'Bobby' }, { label: 'Agent', tokenHash: 'custom' },
  ])('拒绝无效签发请求 %j', async body => {
    const response = await issue(account(), body);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: 'INVALID_INPUT' } });
    expect(count()).toBe(0);
  });

  it('无效 JSON 返回 400，写接口保持 application/json 防 CSRF', async () => {
    const cookie = account();
    const invalid = await server.app.request(PATH, { method: 'POST', headers: { ...json, cookie }, body: '{' });
    expect(invalid.status).toBe(400);
    for (const method of ['POST', 'DELETE']) {
      const response = await server.app.request(method === 'POST' ? PATH : PATH + '/missing', {
        method, headers: { cookie, 'content-type': 'text/plain' }, body: '{}',
      });
      expect(response.status).toBe(415);
    }
    expect(count()).toBe(0);
  });
});

describe('审计与事务', () => {
  it('签发和吊销记录账号、id 和注入时间，不记录明文、哈希、标签或邀请码', async () => {
    const cookie = account('Alice', START);
    const result = await issued(cookie, { label: '私有标签', inviteCode: 'invite-first' });
    clock = new Date(clock.getTime() + 1000);
    await revoke(cookie, result.id);
    const calls = vi.mocked(console.info).mock.calls;
    expect(calls.map(([value]) => JSON.parse(value as string))).toEqual([
      { action: 'agent_token.issued', handle: 'Alice', tokenId: result.id, at: START },
      { action: 'agent_token.revoked', handle: 'Alice', tokenId: result.id, at: clock.toISOString() },
    ]);
    const logged = JSON.stringify(calls);
    expect(logged).not.toContain(result.token);
    expect(logged).not.toContain(createHash('sha256').update(result.token).digest('hex'));
    expect(logged).not.toContain('私有标签');
    expect(logged).not.toContain('invite-first');
  });

  it('签发写入失败返回显式 500，事务回滚且没有成功审计', async () => {
    const cookie = account();
    server.db.exec("CREATE TRIGGER fail_agent_issue BEFORE INSERT ON agent_tokens BEGIN SELECT RAISE(ABORT, 'issue failed'); END;");
    const response = await issue(cookie);
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ error: { code: 'INTERNAL_ERROR' } });
    expect(count()).toBe(0);
    expect(console.info).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalled();
    server.db.exec('DROP TRIGGER fail_agent_issue');
    expect((await issue(cookie)).status).toBe(200);
  });

  it('吊销写入失败保留 active 状态且不记录成功吊销', async () => {
    const cookie = account();
    const result = await issued(cookie);
    vi.mocked(console.info).mockClear();
    server.db.exec("CREATE TRIGGER fail_agent_revoke BEFORE UPDATE OF revokedAt ON agent_tokens BEGIN SELECT RAISE(ABORT, 'revoke failed'); END;");
    const response = await revoke(cookie, result.id);
    expect(response.status).toBe(500);
    expect(server.db.prepare('SELECT revokedAt FROM agent_tokens WHERE id = ?').get(result.id)?.revokedAt).toBeNull();
    expect(console.info).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalled();
  });
});

describe('旧库启动兼容', () => {
  it('只缺 agent_tokens 表的已有库启动会补表和索引，业务数据及凭证重启后保留', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'zhidedeng-agent-tokens-'));
    const dbPath = join(directory, 'app.db');
    let existing = createApp({ dbPath, now: () => clock });
    try {
      existing.db.prepare('INSERT INTO accounts (handle, usernameKey, passwordHash, createdAt) VALUES (?, ?, ?, ?)')
        .run('Legacy', 'legacy', passwordHash, '2026-10-01T00:00:00.000Z');
      openStore(existing.db).put('user', 'Legacy', { handle: 'Legacy', nickname: '老用户', avatar: '', bio: '', tokens: INITIAL_TOKENS });
      const cookie = 'session=' + createSession(openStore(existing.db), 'Legacy', clock);
      const entities = existing.db.prepare('SELECT * FROM entities ORDER BY kind, id').all();
      const accounts = existing.db.prepare('SELECT * FROM accounts').all();
      const sessions = existing.db.prepare('SELECT * FROM sessions').all();
      existing.db.exec('DROP TABLE IF EXISTS agent_tokens');
      expect(existing.db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'agent_tokens'").get()).toBeUndefined();
      const oldTables = existing.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all();
      existing.db.close();
      existing = createApp({ dbPath, now: () => clock });
      expect(existing.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'agent_tokens'").get()).toBeDefined();
      expect(existing.db.prepare('PRAGMA index_info(agent_tokens_handle)').all().map(row => row.name)).toEqual(['handle']);
      expect(existing.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name <> 'agent_tokens' ORDER BY name").all()).toEqual(oldTables);
      expect(existing.db.prepare('SELECT * FROM entities ORDER BY kind, id').all()).toEqual(entities);
      expect(existing.db.prepare('SELECT * FROM accounts').all()).toEqual(accounts);
      expect(existing.db.prepare('SELECT * FROM sessions').all()).toEqual(sessions);
      const response = await existing.app.request(PATH, { method: 'POST', headers: { ...json, cookie }, body: JSON.stringify({ label: '重启保留' }) });
      expect(response.status).toBe(200);
      const token = await response.json() as { id: string; tokenPrefix: string };
      existing.db.close();
      existing = createApp({ dbPath, now: () => clock });
      const listed = await existing.app.request(PATH, { headers: { cookie } });
      expect(listed.status).toBe(200);
      expect(await listed.json()).toEqual([{
        id: token.id, label: '重启保留', tokenPrefix: token.tokenPrefix, createdAt: START,
        lastUsedAt: null, revokedAt: null, useCount: 0, status: 'active',
      }]);
    } finally {
      existing.db.close();
      rmSync(directory, { recursive: true });
    }
  });
});
