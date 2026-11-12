import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.ts';
import { createSession, hashPassword, INITIAL_TOKENS } from '../src/auth.ts';
import { createApp, openStore } from '../src/node-app.ts';

const START = '2026-11-08T04:00:00.000Z';
const DAY_MS = 86_400_000;
const json = { 'content-type': 'application/json' };
const ADMIN = 'invite-test-admin-0123456789abcdef';
let clock: Date;
let server: ReturnType<typeof createApp>;
let passwordHash: string;

beforeAll(async () => { passwordHash = await hashPassword('invite-tests-correct-horse'); });
beforeEach(() => {
  clock = new Date(START);
  // 环境变量那套保留兼容，这里清空以确认走的是库里的码。
  vi.stubEnv('INVITE_CODES', '');
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  server = createApp({ dbPath: ':memory:', now: () => clock });
});
afterEach(() => {
  server.db.close();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

/** 新号：注册不满 7 天、没有通过投稿，只能靠邀请码。 */
function freshAccount(handle: string) {
  const store = openStore(server.db);
  server.db.prepare('INSERT INTO accounts (handle, usernameKey, passwordHash, createdAt) VALUES (?, ?, ?, ?)')
    .run(handle, handle.toLowerCase(), passwordHash, new Date(clock.getTime() - DAY_MS).toISOString());
  store.put('user', handle, { handle, nickname: handle, avatar: '', bio: '', tokens: INITIAL_TOKENS });
  return 'session=' + createSession(store, handle, clock);
}

const admin = () => buildApp(openStore(server.db), () => clock, { syncToken: ADMIN });

async function issueCode(body: Record<string, unknown> = {}) {
  const response = await admin().request('/api/admin/invite-codes', {
    method: 'POST', headers: { ...json, authorization: 'Bearer ' + ADMIN }, body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() as { code?: string; inviteCode?: { id: string; maxUses: number | null; usedCount: number } } };
}

async function issueToken(cookie: string, inviteCode?: string) {
  const response = await server.app.request('/api/account/agent-tokens', {
    method: 'POST', headers: { ...json, cookie },
    body: JSON.stringify({ label: 'cli', ...(inviteCode === undefined ? {} : { inviteCode }) }),
  });
  return { status: response.status, body: await response.json() as { error?: { code: string; message: string } } };
}

describe('邀请码管理', () => {
  it('创建后返回明文，列表里只有前缀', async () => {
    const created = await issueCode({ note: '给运营', maxUses: 2 });
    expect(created.status).toBe(200);
    expect(created.body.code).toMatch(/^zdi_/);
    const listed = await admin().request('/api/admin/invite-codes', { headers: { authorization: 'Bearer ' + ADMIN } });
    const body = await listed.json() as { items: { codePrefix: string; note: string; maxUses: number }[] };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]!.note).toBe('给运营');
    expect(body.items[0]!.maxUses).toBe(2);
    // 明文不该出现在列表里。
    expect(JSON.stringify(body)).not.toContain(created.body.code!);
  });

  it('没有管理密钥时拒绝', async () => {
    // 这个实例没配 syncToken，管理接口整体关闭，返回 403 而不是 401。
    const response = await server.app.request('/api/admin/invite-codes', {
      method: 'POST', headers: json, body: JSON.stringify({}),
    });
    expect(response.status).toBe(403);
  });

  it('次数与有效期参数会被校验', async () => {
    expect((await issueCode({ maxUses: 0 })).status).toBe(400);
    expect((await issueCode({ maxUses: 1.5 })).status).toBe(400);
    expect((await issueCode({ expiresAt: '不是时间' })).status).toBe(400);
    expect((await issueCode({ expiresAt: '2020-01-01T00:00:00.000Z' })).status).toBe(400);
  });
});

describe('用邀请码满足准入', () => {
  it('有效邀请码能签发凭证', async () => {
    const { body } = await issueCode({ maxUses: 1 });
    const cookie = freshAccount('Newbie');
    expect((await issueToken(cookie)).status).toBe(403);
    expect((await issueToken(cookie, body.code!)).status).toBe(200);
  });

  it('次数用完后拒绝，且报错说明是用完而不是无效', async () => {
    const { body } = await issueCode({ maxUses: 1 });
    expect((await issueToken(freshAccount('First'), body.code!)).status).toBe(200);
    const second = await issueToken(freshAccount('Second'), body.code!);
    expect(second.status).toBe(403);
    expect(second.body.error!.message).toContain('次数已用完');
  });

  it('同一账号重复用同一个码不会把次数耗光', async () => {
    const { body } = await issueCode({ maxUses: 2 });
    const cookie = freshAccount('Repeater');
    expect((await issueToken(cookie, body.code!)).status).toBe(200);
    // 再签一次（吊销后重签的场景）：码已核销过，仍应放行且不再扣次数。
    expect((await issueToken(cookie, body.code!)).status).toBe(200);
    const listed = await admin().request('/api/admin/invite-codes', { headers: { authorization: 'Bearer ' + ADMIN } });
    const items = (await listed.json() as { items: { usedCount: number }[] }).items;
    expect(items[0]!.usedCount).toBe(1);
  });

  it('吊销后拒绝', async () => {
    const { body } = await issueCode({ maxUses: 5 });
    await admin().request('/api/admin/invite-codes/' + body.inviteCode!.id + '/revoke', {
      method: 'POST', headers: { ...json, authorization: 'Bearer ' + ADMIN }, body: '{}',
    });
    const result = await issueToken(freshAccount('AfterRevoke'), body.code!);
    expect(result.status).toBe(403);
    expect(result.body.error!.message).toContain('吊销');
  });

  it('过期后拒绝', async () => {
    const { body } = await issueCode({ expiresAt: new Date(clock.getTime() + DAY_MS).toISOString() });
    clock = new Date(clock.getTime() + 2 * DAY_MS);
    const result = await issueToken(freshAccount('AfterExpiry'), body.code!);
    expect(result.status).toBe(403);
    expect(result.body.error!.message).toContain('过期');
  });

  it('不存在的码报无效', async () => {
    const result = await issueToken(freshAccount('Bogus'), 'zdi_not-a-real-code');
    expect(result.status).toBe(403);
    expect(result.body.error!.message).toContain('无效');
  });

  it('签发失败不消耗次数', async () => {
    const { body } = await issueCode({ maxUses: 1 });
    const cookie = freshAccount('Quota');
    // 先把 5 个活跃凭证占满，让签发在核销之前失败。
    for (let index = 0; index < 5; index += 1) expect((await issueToken(cookie, body.code!)).status).toBe(200);
    const blocked = await issueToken(cookie, body.code!);
    expect(blocked.status).toBe(409);
    const listed = await admin().request('/api/admin/invite-codes', { headers: { authorization: 'Bearer ' + ADMIN } });
    const items = (await listed.json() as { items: { usedCount: number }[] }).items;
    // 同一账号只核销一次，所以这里仍是 1。
    expect(items[0]!.usedCount).toBe(1);
  });
});
