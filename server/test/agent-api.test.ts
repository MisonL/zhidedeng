import { createHash } from 'node:crypto';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { API_ROUTES, MAX_RATE, MIN_RATE } from '@zhidedeng/shared';
import type { AgentSubmitResponse, CreateAgentPostRequest, CreateAgentStationRequest, GetAgentStatusResponse } from '@zhidedeng/shared';
import { agentHandle } from '../src/agent-auth.ts';
import { createAgentToken, revokeAgentToken } from '../src/agent-tokens.ts';
import { createSession, hashPassword, INITIAL_TOKENS } from '../src/auth.ts';
import type { Store } from '../src/database.ts';
import { setAccountDisabled } from '../src/moderation.ts';
import { createApp, openStore } from '../src/node-app.ts';
import { Service } from '../src/service.ts';
import { enqueueSubmission, reviewSubmission, setAutoApprove } from '../src/submissions.ts';

const START = '2026-11-09T01:00:00.000Z';
const HOUR_MS = 3_600_000;
const IP = '198.51.100.10';
const json = { 'content-type': 'application/json' };
type Credential = ReturnType<typeof createAgentToken>;
let clock: Date;
let server: ReturnType<typeof createApp>;
let store: Store;
let passwordHash: string;

beforeAll(async () => { passwordHash = await hashPassword('agent-api-test-correct-horse'); });
beforeEach(() => {
  clock = new Date(START);
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  server = createApp({ dbPath: ':memory:', now: () => clock });
  store = openStore(server.db);
});
afterEach(() => { server.db.close(); vi.restoreAllMocks(); });

function account(handle = 'Alice') {
  if (!server.db.prepare('SELECT 1 FROM accounts WHERE handle = ?').get(handle)) {
    server.db.prepare('INSERT INTO accounts (handle, usernameKey, passwordHash, createdAt) VALUES (?, ?, ?, ?)')
      .run(handle, handle.toLowerCase(), passwordHash, new Date(clock.getTime() - 8 * 86_400_000).toISOString());
    store.put('user', handle, { handle, nickname: handle, avatar: '', bio: '', tokens: INITIAL_TOKENS });
  }
  return handle;
}

function credential(handle = 'Alice'): Credential {
  return createAgentToken(store, { handle: account(handle), label: '接口测试', now: clock });
}

function station(index = 0, patch: Partial<CreateAgentStationRequest> = {}): CreateAgentStationRequest {
  return {
    name: '待审核的测试站', description: '这是未经平台核实的投稿', url: `https://station-${index}.example.com/`,
    rechargeThreshold: null, paymentMethods: [], offers: [{ modelSlug: 'gpt-4-1', rate: 0.6 }], ...patch,
  };
}
function post(patch: Partial<CreateAgentPostRequest> = {}): CreateAgentPostRequest {
  return { title: '使用评价', summary: '评价摘要', body: '纯文本正文', authorName: '投稿者', ...patch };
}

function request(path: string, method: 'GET' | 'POST', token?: string, body?: unknown, ip = IP, extra: Record<string, string> = {}) {
  return server.app.request(path, {
    method, headers: { ...json, ...(token === undefined ? {} : { authorization: `Bearer ${token}` }), ...extra },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }, { incoming: { socket: { remoteAddress: ip } } });
}
const submitStation = (key: Credential, body: unknown = station(), ip = IP, extra: Record<string, string> = {}) =>
  request(API_ROUTES.createAgentStation.path, 'POST', key.token, body, ip, extra);
const submitPost = (key: Credential, body: unknown = post(), ip = IP) => request(API_ROUTES.createAgentPost.path, 'POST', key.token, body, ip);
async function submitted(response: Response): Promise<AgentSubmitResponse> {
  const result = await response.json();
  expect({ status: response.status, error: result.error }).toEqual({ status: 200, error: undefined });
  return result as AgentSubmitResponse;
}
async function status(key: Credential, query = '', ip = IP): Promise<GetAgentStatusResponse> {
  const response = await request(API_ROUTES.getAgentStatus.path + query, 'GET', key.token, undefined, ip);
  expect(response.status).toBe(200);
  return await response.json() as GetAgentStatusResponse;
}
async function error(response: Response, httpStatus: number, code: string, field?: string) {
  expect(response.status).toBe(httpStatus);
  const result = await response.json() as { error: { code: string; message: string; retryAfter?: number } };
  expect(result.error.code).toBe(code);
  if (field) expect(result.error.message).toContain(field);
  return result;
}
const pendingCount = () => Number(server.db.prepare("SELECT count(*) AS count FROM submissions WHERE status = 'pending'").get()!.count);
const approve = (id: string) => reviewSubmission(store, clock, id, { status: 'approved' });
const reject = (id: string, reason?: string) => reviewSubmission(store, clock, id, { status: 'rejected', reason });
function seedPending(count: number, offset = 0, actorHandle = 'Other') {
  for (let index = offset; index < offset + count; index++) {
    enqueueSubmission(store, { kind: 'station', channel: 'feishu', originKey: `seed-${index}.example.com`,
      payload: station(index, { url: `https://seed-${index}.example.com/` }), actorHandle, ip: IP, now: clock });
  }
}

describe('Bearer 凭证校验', () => {
  const endpoints = [
    ['stations', API_ROUTES.createAgentStation.path, 'POST', station()],
    ['posts', API_ROUTES.createAgentPost.path, 'POST', post()],
    ['status', API_ROUTES.getAgentStatus.path, 'GET', undefined],
  ] as const;
  for (const [name, path, method, body] of endpoints) {
    it.each(['缺失', '错误', '已吊销', '账号禁用', '账号不存在', '仅有会话'])('%s 凭证调用 ' + name + ' 统一返回 401', async scenario => {
      const key = credential();
      let token: string | undefined = key.token;
      const extra: Record<string, string> = {};
      if (scenario === '缺失') token = undefined;
      if (scenario === '错误') token += '_wrong';
      if (scenario === '已吊销') revokeAgentToken(store, 'Alice', key.id, clock);
      if (scenario === '账号禁用') setAccountDisabled(store, 'Alice', true, clock);
      if (scenario === '账号不存在') server.db.prepare('DELETE FROM accounts WHERE handle = ?').run('Alice');
      if (scenario === '仅有会话') {
        token = undefined;
        extra.cookie = 'session=' + createSession(store, 'Alice', clock);
      }
      const response = await request(path, method, token, body, IP, extra);
      expect(await error(response, 401, 'UNAUTHENTICATED')).toEqual({
        error: { code: 'UNAUTHENTICATED', message: 'Agent 凭证无效，请重新签发或检查 Authorization 头' },
      });
      expect(server.db.prepare('SELECT lastUsedAt, useCount FROM agent_tokens WHERE id = ?').get(key.id))
        .toEqual({ lastUsedAt: null, useCount: 0 });
      expect(pendingCount()).toBe(0);
    });
  }

  it.each(['zd_wrong', 'Basic wrong', 'Bearer', 'Bearer wrong extra'])('拒绝错误 Authorization 格式 %j', async authorization => {
    await error(await request(API_ROUTES.getAgentStatus.path, 'GET', undefined, undefined, IP, { authorization }), 401, 'UNAUTHENTICATED');
  });

  it('agentHandle 使用注入时间更新使用元数据，吊销后不再增加', () => {
    const key = credential();
    expect(agentHandle(store, `Bearer ${key.token}`, clock)).toBe('Alice');
    clock = new Date(clock.getTime() + 1234);
    expect(agentHandle(store, `bearer ${key.token}`, clock)).toBe('Alice');
    expect(server.db.prepare('SELECT lastUsedAt, useCount FROM agent_tokens WHERE id = ?').get(key.id))
      .toEqual({ lastUsedAt: clock.toISOString(), useCount: 2 });
    revokeAgentToken(store, 'Alice', key.id, clock);
    expect(() => agentHandle(store, `Bearer ${key.token}`, clock)).toThrow(expect.objectContaining({ status: 401, code: 'UNAUTHENTICATED' }));
    expect(server.db.prepare('SELECT useCount FROM agent_tokens WHERE id = ?').get(key.id)!.useCount).toBe(2);
  });

  it('禁用会吊销凭证，恢复账号后旧凭证也不再生效', async () => {
    const key = credential();
    await status(key);
    setAccountDisabled(store, 'Alice', true, clock);
    await error(await submitStation(key), 401, 'UNAUTHENTICATED');
    // 恢复账号只解除禁用，不复活已吊销的凭证：必须重新签发。
    setAccountDisabled(store, 'Alice', false, clock);
    await error(await submitStation(key), 401, 'UNAUTHENTICATED');
    expect(server.db.prepare('SELECT revokedAt FROM agent_tokens WHERE id = ?').get(key.id)!.revokedAt).toBe(clock.toISOString());
  });

  it.each(['吊销', '禁用'])('读取正文期间%s也不能继续入队', async action => {
    const key = credential();
    // HonoRequest.json 实际调用 raw.text，再 JSON.parse，不能拦截 Request.json。
    const originalText = Request.prototype.text;
    const read = vi.spyOn(Request.prototype, 'text').mockImplementationOnce(async function (this: Request) {
      const body = await originalText.call(this);
      expect(server.db.prepare('SELECT useCount FROM agent_tokens WHERE id = ?').get(key.id)!.useCount).toBe(1);
      if (action === '吊销') revokeAgentToken(store, 'Alice', key.id, clock);
      else setAccountDisabled(store, 'Alice', true, clock);
      return body;
    });
    await error(await submitStation(key), 401, 'UNAUTHENTICATED');
    expect(read).toHaveBeenCalledOnce();
    read.mockRestore();
    expect(pendingCount()).toBe(0);
  });

  it.each(['吊销', '禁用'])('已存在同内容 pending 时，正文读取期间%s，幂等重放也必须拒绝', async action => {
    // 幂等重放命中已有记录会提前返回、不执行 beforeInsert，所以入口那一道
    // 鉴权必须单独有效。这里在正文读取期间吊销，确保只有入口校验能拦住。
    const key = credential();
    const first = await submitted(await submitStation(key));
    expect(pendingCount()).toBe(1);
    const originalText = Request.prototype.text;
    const read = vi.spyOn(Request.prototype, 'text').mockImplementationOnce(async function (this: Request) {
      const body = await originalText.call(this);
      if (action === '吊销') revokeAgentToken(store, 'Alice', key.id, clock);
      else setAccountDisabled(store, 'Alice', true, clock);
      return body;
    });
    await error(await submitStation(key), 401, 'UNAUTHENTICATED');
    read.mockRestore();
    expect(pendingCount()).toBe(1);
    expect(server.db.prepare('SELECT status FROM submissions WHERE id = ?').get(first.submission.id)?.status).toBe('pending');
  });
});

describe('提交和审核', () => {
  it('站点进入 agent pending 队列，身份来自凭证，审核后缺失指标保持 null', async () => {
    const key = credential();
    const before = store.all('station');
    const result = await submitted(await submitStation(key));
    expect(result).toMatchObject({ deduplicated: false, autoApproved: false, submission: {
      kind: 'station', channel: 'agent', actorHandle: 'Alice', batchId: null, action: 'upsert', originKey: 'station-0.example.com',
      status: 'pending', createdAt: START, reason: null, reviewedAt: null, payload: station(),
    } });
    expect(store.all('station')).toEqual(before);
    expect(server.db.prepare('SELECT ip FROM submissions WHERE id = ?').get(result.submission.id)!.ip).toBe(IP);
    approve(result.submission.id);
    expect(new Service(store, () => clock, null).getStation('sub-station-0-example-com')).toMatchObject({
      source: 'agent', rechargeThreshold: null, uptime: null, firstTokenLatencyMs: null, foundedAt: null, status: null, score: null,
    });
  });

  it('审核物化时强制清空实测指标，即使 payload 被绕过校验塞进了值', async () => {
    // 禁字段校验是第一道防线，物化时的显式 null 是第二道。
    // 这里直接写库模拟「绕过校验的脏数据」，确认第二道防线独立有效。
    const key = credential();
    const dirty = { ...station(0), uptime: 99.9, firstTokenLatencyMs: 500, foundedAt: '2020-01-01', status: 'running' };
    openStore(server.db).db.prepare(`INSERT INTO submissions
      (id, kind, channel, originKey, batchId, action, autoApproved, payload, payloadHash, actorHandle, ip, status, createdAt)
      VALUES ('dirty-1', 'station', 'agent', 'station-0.example.com', NULL, 'upsert', 0, ?, 'h-dirty', 'Alice', ?, 'pending', ?)`)
      .run(JSON.stringify(dirty), IP, clock.toISOString());
    approve('dirty-1');
    expect(new Service(store, () => clock, null).getStation('sub-station-0-example-com')).toMatchObject({
      source: 'agent', uptime: null, firstTokenLatencyMs: null, foundedAt: null, status: null, score: null,
    });
    expect(key.token).toBeTruthy();
  });

  it('评价复用投稿 schema，保留正文，审核后作者绑定凭证账号', async () => {
    const key = credential();
    const stationResult = await submitted(await submitStation(key));
    approve(stationResult.submission.id);
    const payload = post({ hostname: 'STATION-0.EXAMPLE.COM:443', body: '  正文首尾空白\n保持原样  ' });
    const result = await submitted(await submitPost(key, payload));
    expect(result.submission).toMatchObject({ kind: 'post', channel: 'agent', actorHandle: 'Alice', status: 'pending',
      payload: { ...payload, hostname: 'station-0.example.com', authorHandle: 'Alice' } });
    expect(store.get('post', `sub-${result.submission.id}`)).toBeUndefined();
    approve(result.submission.id);
    expect(store.get('post', `sub-${result.submission.id}`)).toMatchObject({
      source: 'agent', authorHandle: 'Alice', authorNickname: '投稿者', stationSlug: 'sub-station-0-example-com', body: payload.body,
    });
  });

  it('管理员开启自动通过后，Agent 两种提交仍必须人工审核', async () => {
    const key = credential();
    setAutoApprove(store, true, clock);
    const results = [await submitted(await submitStation(key)), await submitted(await submitPost(key))];
    for (const result of results) {
      expect(result.autoApproved).toBe(false);
      expect(result.submission.status).toBe('pending');
      expect(server.db.prepare('SELECT autoApproved FROM submissions WHERE id = ?').get(result.submission.id)!.autoApproved).toBe(0);
    }
    expect(pendingCount()).toBe(2);
  });

  it('未知模型和重复报价在入队前拒绝', async () => {
    const key = credential();
    await error(await submitStation(key, station(0, { offers: [{ modelSlug: 'unknown-model', rate: 0.6 }] })), 400, 'INVALID_INPUT', 'unknown-model');
    await error(await submitStation(key, station(0, { offers: [station().offers[0], station().offers[0]] })), 400, 'INVALID_INPUT', '重复');
    expect(pendingCount()).toBe(0);
  });
});

describe('六个配额维度', () => {
  it('单 token 每小时最多 10 条，独立于账号和 IP，窗口边界按秒向上取整', async () => {
    const key = credential();
    for (let index = 0; index < 10; index++) approve((await submitted(await submitStation(key, station(index)))).submission.id);
    const limited = await submitStation(key, station(10));
    await error(limited, 429, 'RATE_LIMITED', '单 token');
    expect(limited.headers.get('retry-after')).toBe('3600');
    const quotas = (await status(key)).quotas;
    expect(quotas.token).toEqual({ limit: 10, remaining: 0, retryAfter: 3600 });
    expect(quotas.account.remaining).toBe(10);
    expect(quotas.ip.remaining).toBe(10);
    clock = new Date(Date.parse(START) + HOUR_MS - 1);
    const almost = await submitStation(key, station(10));
    await error(almost, 429, 'RATE_LIMITED', '单 token');
    expect(almost.headers.get('retry-after')).toBe('1');
    clock = new Date(Date.parse(START) + HOUR_MS);
    await submitted(await submitStation(key, station(10)));
    expect((await status(key)).quotas.token.remaining).toBe(9);
  });

  it('单账号跨 token 和 IP 合计每小时 20 条', async () => {
    const keys = [credential(), credential(), credential()];
    for (let index = 0; index < 20; index++) {
      approve((await submitted(await submitStation(keys[index % 3], station(index), `198.51.100.${index % 3 + 1}`))).submission.id);
    }
    const limited = await submitStation(keys[2], station(20), '203.0.113.99');
    const result = await error(limited, 429, 'RATE_LIMITED', '单账号');
    expect(result.error.message).not.toContain('单 token');
    expect(result.error.message).not.toContain('单 IP');
    expect(limited.headers.get('retry-after')).toBe('3600');
    expect((await status(keys[2])).quotas.account.remaining).toBe(0);
  });

  it('单 IP 跨账号合计每小时 20 条，直连者不能伪造 X-Forwarded-For 绕过', async () => {
    const keys = [credential('Alice'), credential('Bobby'), credential('Carol')];
    for (let index = 0; index < 20; index++) {
      approve((await submitted(await submitStation(keys[index % 3], station(index), IP, { 'x-forwarded-for': `203.0.113.${index}` }))).submission.id);
    }
    const limited = await submitStation(keys[2], station(20), IP, { 'x-forwarded-for': '203.0.113.99' });
    const result = await error(limited, 429, 'RATE_LIMITED', '单 IP');
    expect(result.error.message).not.toContain('单 token');
    expect(result.error.message).not.toContain('单账号');
    expect(limited.headers.get('retry-after')).toBe('3600');
    expect((await status(keys[2])).quotas.ip.remaining).toBe(0);
  });

  it('IPv6 同一 /64 共用 IP 配额，本机反代使用可信转发地址', async () => {
    const keys = [credential('Alice'), credential('Bobby'), credential('Carol')];
    for (let index = 0; index < 20; index++) {
      approve((await submitted(await submitStation(keys[index % 3], station(index), '127.0.0.1',
        { 'x-forwarded-for': `1.2.3.4, 2001:db8:42:1::${index + 1}` }))).submission.id);
    }
    const limited = await submitStation(keys[2], station(20), '127.0.0.1', { 'x-forwarded-for': '2001:db8:42:1::99' });
    await error(limited, 429, 'RATE_LIMITED', '单 IP');
    expect(server.db.prepare('SELECT DISTINCT ip FROM submissions').all()).toEqual([{ ip: '2001:db8:42:1::/64' }]);
  });

  it('单账号站点与评价共用 5 条 pending，审核后释放', async () => {
    const key = credential();
    const first = await submitted(await submitStation(key));
    for (let index = 0; index < 4; index++) await submitted(await submitPost(key, post({ title: '评价 ' + index })));
    await error(await submitStation(key, station(6)), 409, 'TOO_MANY_PENDING', '单账号');
    expect((await status(key)).quotas.pending).toEqual({ limit: 5, remaining: 0 });
    reject(first.submission.id);
    await submitted(await submitStation(key, station(6)));
    expect(pendingCount()).toBe(5);
  });

  it('单 hostname 跨账号及两种内容共用 2 条 pending', async () => {
    const firstKey = credential();
    const secondKey = credential('Bobby');
    const first = await submitted(await submitStation(firstKey));
    await submitted(await submitPost(secondKey, post({ hostname: 'STATION-0.EXAMPLE.COM.' })));
    await error(await submitStation(secondKey, station(0, { name: '另一个版本' })), 409, 'TOO_MANY_PENDING', 'hostname');
    expect((await status(firstKey)).quotas.hostnames).toEqual([{ hostname: 'station-0.example.com', pendingCount: 2, limit: 2, remaining: 0 }]);
    reject(first.submission.id);
    await submitted(await submitStation(secondKey, station(0, { name: '另一个版本' })));
    expect(pendingCount()).toBe(2);
  });

  it('hostname 限额计入其他渠道 pending，端口和尾点不能绕过', async () => {
    const key = credential();
    for (let index = 0; index < 2; index++) enqueueSubmission(store, {
      kind: 'station', channel: 'feishu', originKey: 'station-0.example.com', payload: station(0, { name: '已有版本 ' + index }), ip: IP, now: clock,
    });
    await error(await submitStation(key, station(0, { url: 'https://STATION-0.EXAMPLE.COM.:8443/' })), 409, 'TOO_MANY_PENDING', 'hostname');
    expect(pendingCount()).toBe(2);
  });

  it('其他渠道留下的 originKey 大小写或尾点变体，同样计入 hostname 限额', async () => {
    // enqueueSubmission 会规范化 originKey，所以直接写库模拟历史遗留的未规范化数据。
    // 计数必须自己再做一次 lower/rtrim，否则大小写变体就能绕过单 hostname 上限。
    const key = credential();
    const raw = (id: string) => server.db.prepare(`INSERT INTO submissions
      (id, kind, channel, originKey, batchId, action, autoApproved, payload, payloadHash, actorHandle, ip, status, createdAt)
      VALUES (?, 'station', 'feishu', 'Station-0.Example.COM.', NULL, 'upsert', 0, ?, ?, NULL, ?, 'pending', ?)`)
      .run(id, JSON.stringify(station(0, { name: '历史版本 ' + id })), 'hash-' + id, IP, clock.toISOString());
    raw('legacy-1');
    raw('legacy-2');
    await error(await submitStation(key, station(0)), 409, 'TOO_MANY_PENDING', 'hostname');
    expect(pendingCount()).toBe(2);
  });

  it('待审数超过 hostname 上限时，余量显示 0 而不是负数', async () => {
    const key = credential();
    const first = await submitted(await submitStation(key));
    await submitted(await submitPost(key, post({ hostname: 'station-0.example.com' })));
    // 模拟历史上限更宽或规则收紧后遗留的超额数据：手工再插一条同 hostname 的 pending。
    enqueueSubmission(store, {
      kind: 'post', channel: 'agent', actorHandle: 'Alice', originKey: 'agent:Alice:overflow',
      payload: post({ title: '溢出条目', hostname: 'station-0.example.com' }), ip: IP, now: clock,
    });
    const quota = (await status(key)).quotas.hostnames;
    expect(quota).toEqual([{ hostname: 'station-0.example.com', pendingCount: 3, limit: 2, remaining: 0 }]);
    expect(first.submission.id).toBeTruthy();
  });

  it('全局 pending 达到 200 条熔断，计入其他渠道，审核后恢复', async () => {
    const key = credential();
    seedPending(200);
    await error(await submitStation(key), 409, 'TOO_MANY_PENDING', '全局');
    expect((await status(key)).quotas.globalPending).toEqual({ limit: 200, remaining: 0 });
    const id = server.db.prepare('SELECT id FROM submissions ORDER BY rowid LIMIT 1').get()!.id as string;
    reject(id);
    await submitted(await submitStation(key));
    expect(pendingCount()).toBe(200);
  });

  it('并发请求不能越过单账号 pending 上限', async () => {
    const key = credential();
    const responses = await Promise.all(Array.from({ length: 6 }, (_, index) => submitStation(key, station(index))));
    expect(responses.map(response => response.status).sort()).toEqual([200, 200, 200, 200, 200, 409]);
    expect(pendingCount()).toBe(5);
    expect((await status(key)).quotas.token.remaining).toBe(5);
  });

  it('并发请求不能越过全局 pending 上限', async () => {
    const keys = [credential(), credential('Bobby')];
    seedPending(199);
    const responses = await Promise.all(keys.map((key, index) => submitStation(key, station(index))));
    expect(responses.map(response => response.status).sort()).toEqual([200, 409]);
    expect(pendingCount()).toBe(200);
  });

  it('入队写入失败会退还三个速率维度的预占', async () => {
    const key = credential();
    server.db.exec("CREATE TRIGGER fail_agent_insert BEFORE INSERT ON submissions BEGIN SELECT RAISE(ABORT, '测试入队失败'); END");
    await error(await submitStation(key), 500, 'INTERNAL_ERROR');
    expect(pendingCount()).toBe(0);
    const quotas = (await status(key)).quotas;
    expect([quotas.token.remaining, quotas.account.remaining, quotas.ip.remaining]).toEqual([10, 20, 20]);
    server.db.exec('DROP TRIGGER fail_agent_insert');
    await submitted(await submitStation(key));
    expect((await status(key)).quotas.token.remaining).toBe(9);
  });

  it('无效内容和查询状态不消耗投稿速率额度', async () => {
    const key = credential();
    for (let index = 0; index < 12; index++) {
      await error(await submitStation(key, { ...station(), uptime: null }), 400, 'FORBIDDEN_FIELD', 'uptime');
      await status(key);
    }
    const quotas = (await status(key)).quotas;
    expect([quotas.token.remaining, quotas.account.remaining, quotas.ip.remaining]).toEqual([10, 20, 20]);
    expect(server.db.prepare('SELECT useCount FROM agent_tokens WHERE id = ?').get(key.id)!.useCount).toBe(25);
  });
});

describe('内容完整性与 URL 边界', () => {
  const fields = ['uptime', 'firstTokenLatencyMs', 'foundedAt', 'status', 'score', 'lowestRate', 'apiKey', 'api_key', 'token', 'password', 'secret', 'authorHandle', 'accessToken', 'refresh_token', 'clientSecret', 'privateKey', 'authorization', 'credentials'];
  for (const kind of ['station', 'post'] as const) {
    it.each(fields)(kind + ' 明确拒绝字段 %s，包括 null', async field => {
      const key = credential();
      const response = kind === 'station' ? await submitStation(key, { ...station(), [field]: null }) : await submitPost(key, { ...post(), [field]: null });
      await error(response, 400, 'FORBIDDEN_FIELD', field);
      expect(pendingCount()).toBe(0);
    });
  }

  it.each([
    ['offers.0.secret', { ...station(), offers: [{ ...station().offers[0], secret: 'sensitive' }] }],
    ['offers.0.accessToken', { ...station(), offers: [{ ...station().offers[0], accessToken: 'sensitive' }] }],
    ['offers.0.clientSecret', { ...station(), offers: [{ ...station().offers[0], clientSecret: 'sensitive' }] }],
    ['metadata.uptime', { ...station(), metadata: { uptime: 99 } }],
    ['apiKey', { ...station(), apiKey: 'sensitive' }],
    ['FIRST_TOKEN_LATENCY_MS', { ...station(), FIRST_TOKEN_LATENCY_MS: 1 }],
  ])('在未知字段被剥离前拒绝嵌套或变体 %s', async (field, payload) => {
    await error(await submitStation(credential(), payload), 400, 'FORBIDDEN_FIELD', field as string);
    expect(pendingCount()).toBe(0);
  });

  it.each(['channel', 'actorHandle', 'batchId', 'action', 'source'])('拒绝客户端指定元数据 %s', async field => {
    await error(await submitStation(credential(), { ...station(), [field]: 'forged' }), 400, 'INVALID_INPUT', field);
  });

  it('URL 去掉 query、fragment、用户名密码，保留协议、规范化主机、端口和路径', async () => {
    const result = await submitted(await submitStation(credential(), station(0, { url: 'https://user:pass@EXAMPLE.COM.:8443/v1?token=sensitive#private' })));
    expect(result.submission.originKey).toBe('example.com');
    expect((result.submission.payload as CreateAgentStationRequest).url).toBe('https://example.com:8443/v1');
    const row = server.db.prepare('SELECT payload FROM submissions WHERE id = ?').get(result.submission.id)!;
    expect(String(row.payload)).not.toContain('sensitive');
    expect(String(row.payload)).not.toContain('user:pass');
  });

  it.each([
    '127.0.0.1', '127.255.255.255', '127.1', '2130706433', '0x7f000001', '0177.0.0.1',
    '10.0.0.1', '10.255.255.255', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.0.1', '0.0.0.0',
    '[::1]', '[::]', '[fc00::1]', '[fdff::1]', '[fe80::1]', '[fec0::1]', '[::ffff:127.0.0.1]', '[::ffff:10.0.0.1]', '[::ffff:192.168.1.1]',
    'localhost', 'LOCALHOST.', 'sub.localhost', 'localhost.localdomain', 'host.local', 'host.internal.',
    'internal.corp.example',
  ])('拒绝内网、回环或本地 URL hostname %s', async hostname => {
    await error(await submitStation(credential(), station(0, { url: `http://${hostname}/` })), 400, 'INVALID_INPUT', 'url');
    expect(pendingCount()).toBe(0);
  });

  it.each(['localhost', '127.1', '[::1]', 'host.internal'])('评价关联 hostname 也拒绝本地地址 %s', async hostname => {
    await error(await submitPost(credential(), post({ hostname })), 400, 'INVALID_INPUT', 'hostname');
  });

  it.each(['https://8.8.8.8/', 'https://[2001:4860:4860::8888]/', 'https://[::ffff:8.8.8.8]/', 'http://172.15.255.255/', 'http://172.32.0.1/'])('接受公网地址 %s', async url => {
    await submitted(await submitStation(credential(), station(0, { url })));
  });

  it('IDN 域名规范化成 punycode 后正常入队，不因 Unicode 字符被误判为内网', async () => {
    const result = await submitted(await submitStation(credential(), station(0, { url: 'https://例え.jp/' })));
    const row = openStore(server.db).db.prepare('SELECT originKey FROM submissions WHERE id = ?').get(result.submission.id);
    expect(row?.originKey).toBe('xn--r8jz45g.jp');
  });

  it.each(['ftp://example.com/', 'javascript:alert(1)', 'data:text/plain,test', '/relative', 'not-a-url'])('拒绝非 http/https 或无效 URL %s', async url => {
    await error(await submitStation(credential(), station(0, { url })), 400, 'INVALID_INPUT', 'url');
  });

  it.each(['example.com/path', 'user:pass@example.com', 'example.com?query=1'])('hostname 不能夹带路径或账号 %s', async hostname => {
    await error(await submitPost(credential(), post({ hostname })), 400, 'INVALID_INPUT', 'hostname');
  });

  it('评价 hostname 在 IDN 规范化后也必须满足长度上限', async () => {
    const hostname = Array<string>(4).fill('中'.repeat(60)).join('.') + '.com';
    expect(hostname.length).toBeLessThanOrEqual(253);
    expect(new URL(`https://${hostname}/`).hostname.length).toBeGreaterThan(253);
    await error(await submitPost(credential(), post({ hostname })), 400, 'INVALID_INPUT', 'hostname');
    expect(pendingCount()).toBe(0);
  });

  it('站点 URL 和评价 hostname 的 IDN 规范化一致，审核后能关联', async () => {
    const key = credential();
    const stationResult = await submitted(await submitStation(key, station(0, { url: 'https://例子.jp/' })));
    approve(stationResult.submission.id);
    const postResult = await submitted(await submitPost(key, post({ hostname: '例子.JP.' })));
    approve(postResult.submission.id);
    const published = store.get('post', `sub-${postResult.submission.id}`)!;
    expect(store.get('station', published.stationSlug!)?.url).toBe('https://xn--fsqu00a.jp/');
  });

  it.each([
    ['name', station(0, { name: '字'.repeat(61) })],
    ['description', station(0, { description: '字'.repeat(301) })],
  ])('拒绝超长站点字段 %s', async (field, payload) => {
    await error(await submitStation(credential(), payload), 400, 'INVALID_INPUT', field as string);
    expect(pendingCount()).toBe(0);
  });

  it.each([
    ['title', post({ title: '字'.repeat(101) })], ['summary', post({ summary: '字'.repeat(201) })],
    ['body', post({ body: '字'.repeat(5001) })], ['authorName', post({ authorName: '字'.repeat(31) })],
  ])('拒绝超长评价字段 %s', async (field, payload) => {
    await error(await submitPost(credential(), payload), 400, 'INVALID_INPUT', field as string);
    expect(pendingCount()).toBe(0);
  });

  it('接受包含长度上限的内容', async () => {
    const key = credential();
    await submitted(await submitStation(key, station(0, { name: '字'.repeat(60), description: '字'.repeat(300) })));
    await submitted(await submitPost(key, post({ title: '字'.repeat(100), summary: '字'.repeat(200), body: '字'.repeat(5000), authorName: '字'.repeat(30) })));
  });

  it.each([MIN_RATE, MAX_RATE])('接受共享倍率边界 %s', async rate => {
    await submitted(await submitStation(credential(), station(0, { offers: [{ modelSlug: 'gpt-4-1', rate }] })));
  });

  it.each([MIN_RATE - 0.001, MAX_RATE + 0.001, 0, -1])('拒绝共享范围外的倍率 %s', async rate => {
    await error(await submitStation(credential(), station(0, { offers: [{ modelSlug: 'gpt-4-1', rate }] })), 400, 'INVALID_INPUT', 'rate');
  });
});

describe('幂等和状态', () => {
  it('同账号跨 token 重试、JSON 字段重排和 URL 清理后只有一条 pending，不重复扣额度', async () => {
    const firstKey = credential();
    const secondKey = credential();
    const first = await submitted(await submitStation(firstKey));
    clock = new Date(clock.getTime() + 1000);
    const reordered = Object.fromEntries(Object.entries(station(0, { url: 'https://STATION-0.EXAMPLE.COM/?retry=1#fragment' })).reverse());
    const repeated = await submitted(await submitStation(secondKey, reordered));
    expect(repeated).toEqual({ ...first, deduplicated: true });
    expect(pendingCount()).toBe(1);
    const quotas = (await status(secondKey)).quotas;
    expect([quotas.token.remaining, quotas.account.remaining, quotas.ip.remaining]).toEqual([10, 19, 19]);
    expect(server.db.prepare('SELECT batchId FROM submissions').all()).toEqual([{ batchId: null }]);
  });

  it('没有自报发布时间的评价重试不把注入时间混入 payloadHash', async () => {
    const key = credential();
    const first = await submitted(await submitPost(key));
    clock = new Date(clock.getTime() + 1000);
    const repeated = await submitted(await submitPost(key, Object.fromEntries(Object.entries(post()).reverse())));
    expect(repeated.submission.id).toBe(first.submission.id);
    expect(repeated.deduplicated).toBe(true);
    expect(pendingCount()).toBe(1);
  });

  it('评价可选字段省略或显式 null 的重试复用同一记录', async () => {
    const key = credential();
    const first = await submitted(await submitPost(key));
    const repeated = await submitted(await submitPost(key, post({ hostname: null, publishedAt: null })));
    expect(repeated.submission.id).toBe(first.submission.id);
    expect(repeated.deduplicated).toBe(true);
    expect(pendingCount()).toBe(1);
    expect((await status(key)).quotas.token.remaining).toBe(9);
  });

  it('不同账号同内容各自入队，不能借用别人的 id 或 actorHandle', async () => {
    const first = await submitted(await submitStation(credential()));
    const secondKey = credential('Bobby');
    const second = await submitted(await submitStation(secondKey));
    expect(second.deduplicated).toBe(false);
    expect(second.submission.id).not.toBe(first.submission.id);
    expect(second.submission.actorHandle).toBe('Bobby');
    expect((await status(secondKey)).submissions.map(item => item.id)).toEqual([second.submission.id]);
    expect(pendingCount()).toBe(2);
  });

  it('不能借用其他渠道的同内容 pending', async () => {
    const key = credential();
    const existing = enqueueSubmission(store, { kind: 'station', channel: 'web', originKey: 'station-0.example.com',
      payload: station(), actorHandle: 'Alice', ip: IP, now: clock });
    const result = await submitted(await submitStation(key));
    expect(result.submission.id).not.toBe(existing.submission.id);
    expect(result.submission.channel).toBe('agent');
    expect(pendingCount()).toBe(2);
  });

  it('并发同内容提交只插入和计费一次', async () => {
    const key = credential();
    const results = await Promise.all((await Promise.all(Array.from({ length: 12 }, () => submitStation(key)))).map(submitted));
    expect(new Set(results.map(result => result.submission.id)).size).toBe(1);
    expect(results.filter(result => !result.deduplicated)).toHaveLength(1);
    expect(pendingCount()).toBe(1);
    expect((await status(key)).quotas.token.remaining).toBe(9);
  });

  it('账号 pending 配额已满时，原提交重试仍返回原记录', async () => {
    const key = credential();
    const first = await submitted(await submitStation(key));
    for (let index = 1; index < 5; index++) await submitted(await submitStation(key, station(index)));
    const repeated = await submitted(await submitStation(key));
    expect(repeated.submission.id).toBe(first.submission.id);
    expect(repeated.deduplicated).toBe(true);
    expect(pendingCount()).toBe(5);
    expect((await status(key)).quotas.token.remaining).toBe(5);
  });

  it('token 速率配额已满时，原 pending 重试仍返回原记录', async () => {
    const key = credential();
    const first = await submitted(await submitStation(key));
    for (let index = 1; index < 10; index++) approve((await submitted(await submitStation(key, station(index)))).submission.id);
    expect((await status(key)).quotas.token.remaining).toBe(0);
    const repeated = await submitted(await submitStation(key));
    expect(repeated.submission.id).toBe(first.submission.id);
    expect(repeated.deduplicated).toBe(true);
    expect(pendingCount()).toBe(1);
  });

  it('全局熔断时，原 pending 重试仍返回原记录', async () => {
    const key = credential();
    const first = await submitted(await submitStation(key));
    seedPending(199);
    const repeated = await submitted(await submitStation(key));
    expect(repeated.submission.id).toBe(first.submission.id);
    expect(repeated.deduplicated).toBe(true);
    expect(pendingCount()).toBe(200);
  });

  it('已拒绝的内容再次提交生成新 pending，保留原审核意见', async () => {
    const key = credential();
    const first = await submitted(await submitStation(key));
    reject(first.submission.id, '请补充报价来源');
    const next = await submitted(await submitStation(key));
    expect(next.submission.id).not.toBe(first.submission.id);
    expect((await status(key)).submissions).toEqual([
      { id: next.submission.id, kind: 'station', status: 'pending', createdAt: START, reason: null },
      { id: first.submission.id, kind: 'station', status: 'rejected', createdAt: START, reason: '请补充报价来源' },
    ]);
  });

  it('status 返回六个配额、本人最近 N 条状态和审核意见，不泄露内容或凭证', async () => {
    const key = credential();
    const first = await submitted(await submitStation(key));
    clock = new Date(clock.getTime() + 1000);
    const next = await submitted(await submitStation(key, station(0, { name: '新版本' })));
    approve(next.submission.id);
    clock = new Date(clock.getTime() + 1000);
    const review = await submitted(await submitPost(key));
    reject(review.submission.id, '需要更多使用细节');
    await submitted(await submitStation(credential('Bobby'), station(99)));
    const response = await request(API_ROUTES.getAgentStatus.path + '?limit=2', 'GET', key.token);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const result = await response.json() as GetAgentStatusResponse;
    expect(result).toEqual({
      handle: 'Alice', pendingCount: 0,
      quotas: {
        token: { limit: 10, remaining: 7, retryAfter: 0 }, account: { limit: 20, remaining: 17, retryAfter: 0 },
        ip: { limit: 20, remaining: 16, retryAfter: 0 }, pending: { limit: 5, remaining: 5 },
        globalPending: { limit: 200, remaining: 199 }, hostnames: [],
      },
      submissions: [
        { id: review.submission.id, kind: 'post', status: 'rejected', createdAt: clock.toISOString(), reason: '需要更多使用细节' },
        { id: next.submission.id, kind: 'station', status: 'approved', createdAt: next.submission.createdAt, reason: null },
      ],
    });
    const all = await status(key);
    expect(all.submissions[2]).toMatchObject({ id: first.submission.id, status: 'superseded' });
    expect(JSON.stringify(all)).not.toContain(key.token);
    expect(JSON.stringify(all)).not.toContain(createHash('sha256').update(key.token).digest('hex'));
    expect(JSON.stringify(all)).not.toContain('payload');
  });

  it('status 的默认条数是 20，最大 50，历史超额数据的余量不为负数', async () => {
    const key = credential();
    seedPending(55, 0, 'Alice');
    const defaultResult = await status(key);
    expect(defaultResult.submissions).toHaveLength(20);
    expect(defaultResult.pendingCount).toBe(55);
    expect(defaultResult.quotas.pending.remaining).toBe(0);
    expect((await status(key, '?limit=50')).submissions).toHaveLength(50);
  });

  it.each(['?limit=0', '?limit=51', '?limit=1.5', '?limit=bad', '?handle=Bobby'])('status 拒绝无效或越权筛选参数 %s', async query => {
    const key = credential();
    await error(await request(API_ROUTES.getAgentStatus.path + query, 'GET', key.token), 400, 'INVALID_INPUT');
  });
});

describe('私网地址黑名单的转换前缀', () => {
  it.each([
    ['NAT64 指向回环', 'http://[64:ff9b::7f00:1]/'],
    ['NAT64 指向云元数据', 'http://[64:ff9b::a9fe:a9fe]/'],
    ['NAT64 指向私网', 'http://[64:ff9b::c0a8:101]/'],
    ['6to4 指向回环', 'http://[2002:7f00:1::]/'],
    ['IPv4 映射回环', 'http://[::ffff:127.0.0.1]/'],
    ['运营商级 NAT', 'http://100.64.0.1/'],
    ['基准测试网段', 'http://198.18.0.1/'],
    ['文档保留段', 'http://192.0.2.1/'],
    ['组播', 'http://224.0.0.1/'],
    ['保留段', 'http://240.0.0.1/'],
  ])('%s 被拒绝', async (_name, url) => {
    const key = credential();
    // 这些字面形态经网关后会落到内网或云元数据，必须和直接写内网地址同等对待。
    await error(await submitStation(key, station(0, { url })), 400, 'INVALID_INPUT');
  });

  it('正常公网地址仍然接受', async () => {
    const key = credential();
    await submitted(await submitStation(key, station(0, { url: 'https://public.example.org/' })));
  });
});
