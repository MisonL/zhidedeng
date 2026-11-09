import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, stat, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  EXIT, catalog, configPath, inferKind, login, matchModel, normalizeModelName, parseArgs,
  readConfig, resolveToken, run, status, submitBatch, submitFile, submitOne, validate,
  validatePayload, whoami, writeConfig, ZdError,
} from '../zd.ts';

let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'zd-test-'));
  process.env.ZD_CONFIG_HOME = home;
  process.env.ZD_API_BASE = 'https://api.test';
  delete process.env.ZD_TOKEN;
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
  delete process.env.ZD_CONFIG_HOME;
  delete process.env.ZD_API_BASE;
  delete process.env.ZD_TOKEN;
});

const TOKEN = 'zd_' + 'a'.repeat(40);
const station = { name: '测试站', description: '描述', url: 'https://a.com/', rechargeThreshold: null, paymentMethods: [], offers: [] };
const post = { title: '标题', summary: '摘要', body: '正文', authorName: '昵称' };

/** 构造一个按路径与状态码返回的假 fetch。 */
function fakeFetch(routes: Record<string, { status?: number; body?: unknown }>) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const path = url.replace('https://api.test', '');
    const key = Object.keys(routes).find(candidate => path === candidate || path.startsWith(candidate + '?'));
    const route = key ? routes[key]! : { status: 404, body: { error: { message: '没有这条路由' } } };
    return new Response(JSON.stringify(route.body ?? {}), { status: route.status ?? 200 });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const statusBody = {
  handle: 'Alice', pendingCount: 1,
  quotas: {
    token: { limit: 10, remaining: 9, retryAfter: 0 },
    account: { limit: 20, remaining: 19, retryAfter: 0 },
    ip: { limit: 20, remaining: 19, retryAfter: 0 },
    pending: { limit: 5, remaining: 4 },
    globalPending: { limit: 200, remaining: 199 },
    hostnames: [],
  },
  submissions: [{ id: 's1', kind: 'station', status: 'pending', createdAt: '2026-01-01T00:00:00Z', reason: null }],
};

describe('参数解析', () => {
  it('把 --flag value 和位置参数分开', () => {
    expect(parseArgs(['match', 'Claude Sonnet', '--limit', '5'])).toEqual({
      command: 'match', positional: ['Claude Sonnet'], flags: { limit: '5' },
    });
  });

  it('末尾没有值的 --flag 视为布尔真', () => {
    expect(parseArgs(['submit', '--batch']).flags).toEqual({ batch: true });
  });

  it('空参数只得到空命令', () => {
    expect(parseArgs([])).toEqual({ command: '', positional: [], flags: {} });
  });
});

describe('退出码', () => {
  it('未知命令返回用法错误', async () => {
    expect(await run(['nonsense'])).toBe(EXIT.usage);
  });

  it('缺少参数返回用法错误', async () => {
    expect(await run(['validate'])).toBe(EXIT.usage);
    expect(await run(['submit'])).toBe(EXIT.usage);
    expect(await run(['match'])).toBe(EXIT.usage);
  });

  it('help 返回成功', async () => {
    expect(await run(['help'])).toBe(EXIT.ok);
  });

  it('--limit 非正整数返回用法错误', async () => {
    process.env.ZD_TOKEN = TOKEN;
    expect(await run(['status', '--limit', '0'])).toBe(EXIT.usage);
    expect(await run(['status', '--limit', 'abc'])).toBe(EXIT.usage);
  });
});

describe('凭证存储', () => {
  it('写入后能读回，且文件权限是 0600', async () => {
    await writeConfig({ apiBase: 'https://api.test', token: TOKEN });
    expect(await readConfig()).toEqual({ apiBase: 'https://api.test', token: TOKEN });
    if (process.platform !== 'win32') {
      expect((await stat(configPath())).mode & 0o777).toBe(0o600);
      expect((await stat(join(home, 'zd'))).mode & 0o777).toBe(0o700);
    }
  });

  it('配置文件不存在时返回 null 而不是抛错', async () => {
    expect(await readConfig()).toBeNull();
  });

  it('配置文件损坏时返回 null', async () => {
    await mkdir(join(home, 'zd'), { recursive: true });
    await writeFile(configPath(), '{not json');
    expect(await readConfig()).toBeNull();
  });

  it('没有凭证时抛出未登录错误', async () => {
    await expect(resolveToken()).rejects.toThrow(ZdError);
    await expect(resolveToken()).rejects.toMatchObject({ code: EXIT.unauthorized });
  });

  it('ZD_TOKEN 优先于配置文件', async () => {
    await writeConfig({ apiBase: 'https://api.test', token: TOKEN });
    process.env.ZD_TOKEN = 'zd_fromenv';
    expect(await resolveToken()).toBe('zd_fromenv');
  });
});

describe('login', () => {
  it('凭证有效时保存并返回 handle', async () => {
    const { impl } = fakeFetch({ '/api/agent/status': { body: statusBody } });
    const result = await login(TOKEN, { fetchImpl: impl });
    expect(result.handle).toBe('Alice');
    expect(await readConfig()).toMatchObject({ token: TOKEN });
  });

  it('凭证格式不对时不发请求也不写文件', async () => {
    const { impl, calls } = fakeFetch({});
    await expect(login('nope', { fetchImpl: impl })).rejects.toMatchObject({ code: EXIT.validation });
    expect(calls).toHaveLength(0);
    expect(await readConfig()).toBeNull();
  });

  it('服务端拒绝时不写文件', async () => {
    const { impl } = fakeFetch({ '/api/agent/status': { status: 401, body: { error: { message: '无效' } } } });
    await expect(login(TOKEN, { fetchImpl: impl })).rejects.toMatchObject({ code: EXIT.unauthorized });
    expect(await readConfig()).toBeNull();
  });
});

describe('请求与错误映射', () => {
  it('401 映射为未登录', async () => {
    const { impl } = fakeFetch({ '/api/agent/status': { status: 401, body: { error: { message: '凭证已吊销' } } } });
    await expect(whoami({ token: TOKEN, fetchImpl: impl })).rejects.toMatchObject({ code: EXIT.unauthorized, message: '凭证已吊销' });
  });

  it('429 映射为服务端拒绝并带出消息', async () => {
    const { impl } = fakeFetch({ '/api/agent/status': { status: 429, body: { error: { message: '单账号每小时最多 20 条' } } } });
    await expect(status(undefined, { token: TOKEN, fetchImpl: impl })).rejects.toMatchObject({
      code: EXIT.rejected, message: '单账号每小时最多 20 条',
    });
  });

  it('网络异常映射为网络错误', async () => {
    const impl = (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;
    await expect(status(undefined, { token: TOKEN, fetchImpl: impl })).rejects.toMatchObject({ code: EXIT.network });
  });

  it('非 JSON 响应映射为网络错误', async () => {
    const impl = (async () => new Response('<html>502</html>', { status: 502 })) as unknown as typeof fetch;
    await expect(status(undefined, { token: TOKEN, fetchImpl: impl })).rejects.toMatchObject({ code: EXIT.network });
  });

  it('whoami 带上 API 地址和完整配额', async () => {
    const { impl } = fakeFetch({ '/api/agent/status': { body: statusBody } });
    const result = await whoami({ token: TOKEN, fetchImpl: impl });
    expect(result).toMatchObject({ handle: 'Alice', apiBase: 'https://api.test', pendingCount: 1 });
    expect(result.quotas.token.remaining).toBe(9);
  });

  it('请求使用 Bearer 头和 JSON content-type', async () => {
    const { impl, calls } = fakeFetch({ '/api/agent/stations': { body: { submission: { id: 'x', status: 'pending' }, deduplicated: false } } });
    await submitOne(station, { token: TOKEN, fetchImpl: impl });
    const headers = calls[0]!.init!.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(headers['content-type']).toBe('application/json');
  });
});

describe('catalog', () => {
  it('按服务端真实形状取列表：顶层 items，没有外层包裹', async () => {
    // 服务端 paginate() 直接返回 {items,total,page,pageSize}。
    // 之前这里的 mock 写成 {data:{items}} 是错的，恰好掩盖了 catalog 恒返回空的问题。
    const { impl } = fakeFetch({
      '/api/vendors': { body: { items: [{ slug: 'anthropic' }], total: 1, page: 1, pageSize: 20 } },
      '/api/models': { body: { items: [{ slug: 'claude', name: 'Claude', vendor: 'anthropic' }], total: 1, page: 1, pageSize: 20 } },
      '/api/stations': { body: { items: [{ slug: 'sub-a-com', name: 'A', url: 'https://a.com/' }], total: 1, page: 1, pageSize: 20 } },
    });
    const result = await catalog({ fetchImpl: impl });
    expect(result.vendors).toHaveLength(1);
    expect(result.models[0]).toMatchObject({ slug: 'claude' });
    expect(result.stations[0]).toMatchObject({ slug: 'sub-a-com' });
  });

  it('也接受裸数组响应', async () => {
    const { impl } = fakeFetch({
      '/api/vendors': { body: [{ slug: 'anthropic' }] },
      '/api/models': { body: [] },
      '/api/stations': { body: { items: [], total: 0, page: 1, pageSize: 20 } },
    });
    expect((await catalog({ fetchImpl: impl })).vendors).toHaveLength(1);
  });
});

describe('match 模糊匹配', () => {
  const models = [
    { slug: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5', vendor: 'anthropic' },
    { slug: 'claude-opus-4-1', name: 'Claude Opus 4.1', vendor: 'anthropic' },
    { slug: 'gpt-5', name: 'GPT-5', vendor: 'openai' },
  ];

  it('归一化忽略大小写、空格、连字符、点号', () => {
    expect(normalizeModelName('Claude Sonnet 4.5')).toBe(normalizeModelName('claude-sonnet-4-5'));
  });

  it('精确 slug 命中', () => {
    expect(matchModel('claude-sonnet-4-5', models).matches).toHaveLength(1);
  });

  it('名字归一化后命中', () => {
    expect(matchModel('Claude Sonnet 4.5', models).matches[0]!.slug).toBe('claude-sonnet-4-5');
  });

  it('部分匹配返回多个让 Agent 选', () => {
    const result = matchModel('claude', models);
    expect(result.matches.length).toBeGreaterThan(1);
    expect(result.suggestion).toBeNull();
  });

  it('无命中时给出建议而不是编造 slug', () => {
    const result = matchModel('gemini-3', models);
    expect(result.matches).toHaveLength(0);
    expect(result.suggestion).toContain('没有匹配');
  });
});

describe('validate', () => {
  it('合法站点通过', () => {
    expect(validatePayload(station)).toEqual({ kind: 'station', issues: [] });
  });

  it('合法评价通过', () => {
    expect(validatePayload(post)).toEqual({ kind: 'post', issues: [] });
  });

  it('缺 url 又不缺 title 时按评价判断', () => {
    expect(inferKind(post)).toBe('post');
    expect(inferKind(station)).toBe('station');
  });

  it('无法判断种类', () => {
    expect(inferKind({ foo: 1 })).toBeNull();
    expect(inferKind(null)).toBeNull();
    expect(validatePayload({ foo: 1 }).issues[0]!.message).toContain('无法判断种类');
  });

  it('倍率越界被拒绝', () => {
    const bad = { ...station, offers: [{ modelSlug: 'claude-sonnet-4-5', rate: 99 }] };
    expect(validatePayload(bad).issues[0]!.field).toBe('offers.0.rate');
  });

  it('重复报价被拒绝', () => {
    const bad = { ...station, offers: [{ modelSlug: 'gpt-5', rate: 1 }, { modelSlug: 'gpt-5', rate: 2 }] };
    expect(validatePayload(bad).issues.some(issue => issue.message.includes('重复'))).toBe(true);
  });

  it('带查询串的网址被拒绝', () => {
    expect(validatePayload({ ...station, url: 'https://a.com/?x=1' }).issues[0]!.field).toBe('url');
  });

  it('超长名称被拒绝', () => {
    expect(validatePayload({ ...station, name: '字'.repeat(61) }).issues[0]!.field).toBe('name');
  });

  it('文件不存在返回用法错误', async () => {
    await expect(validate(join(home, 'nope.json'))).rejects.toMatchObject({ code: EXIT.usage });
  });

  it('非法 JSON 返回校验错误', async () => {
    const path = join(home, 'bad.json');
    await writeFile(path, '{oops');
    await expect(validate(path)).rejects.toMatchObject({ code: EXIT.validation });
  });

  it('合法文件返回 valid 和 kind', async () => {
    const path = join(home, 'ok.json');
    await writeFile(path, JSON.stringify(station));
    expect(await validate(path)).toMatchObject({ valid: true, kind: 'station' });
  });
});

describe('submit', () => {
  it('本地校验失败时不发请求', async () => {
    const { impl, calls } = fakeFetch({});
    await expect(submitOne({ ...station, name: '' }, { token: TOKEN, fetchImpl: impl })).rejects.toMatchObject({ code: EXIT.validation });
    expect(calls).toHaveLength(0);
  });

  it('站点提交到 stations 路由', async () => {
    const { impl, calls } = fakeFetch({ '/api/agent/stations': { body: { submission: { id: 'n1', status: 'pending' }, deduplicated: false } } });
    const result = await submitOne(station, { token: TOKEN, fetchImpl: impl });
    expect(result.submission.id).toBe('n1');
    expect(calls[0]!.url).toContain('/api/agent/stations');
  });

  it('评价提交到 posts 路由', async () => {
    const { impl, calls } = fakeFetch({ '/api/agent/posts': { body: { submission: { id: 'n2', status: 'pending' }, deduplicated: false } } });
    await submitOne(post, { token: TOKEN, fetchImpl: impl });
    expect(calls[0]!.url).toContain('/api/agent/posts');
  });

  it('服务端 409 映射为拒绝', async () => {
    const { impl } = fakeFetch({ '/api/agent/stations': { status: 409, body: { error: { message: '单账号待审投稿已达 5 条' } } } });
    await expect(submitOne(station, { token: TOKEN, fetchImpl: impl })).rejects.toMatchObject({ code: EXIT.rejected });
  });

  it('文件提交', async () => {
    const path = join(home, 's.json');
    await writeFile(path, JSON.stringify(station));
    const { impl } = fakeFetch({ '/api/agent/stations': { body: { submission: { id: 'f1', status: 'pending' }, deduplicated: true } } });
    expect(await submitFile(path, { token: TOKEN, fetchImpl: impl })).toMatchObject({ deduplicated: true });
  });

  it('批量提交：单个失败不影响其余', async () => {
    const dir = join(home, 'batch');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'a.json'), JSON.stringify(station));
    await writeFile(join(dir, 'b.json'), JSON.stringify({ ...station, name: '' }));
    await writeFile(join(dir, 'c.json'), JSON.stringify({ ...station, name: '第二个' }));
    const { impl } = fakeFetch({ '/api/agent/stations': { body: { submission: { id: 'ok', status: 'pending' }, deduplicated: false } } });
    const result = await submitBatch(dir, { token: TOKEN, fetchImpl: impl });
    expect(result.total).toBe(3);
    expect(result.submitted).toHaveLength(2);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]!.file).toBe('b.json');
    expect(result.failed[0]!.code).toBe(EXIT.validation);
  });

  it('批量目录为空返回用法错误', async () => {
    const dir = join(home, 'empty');
    await mkdir(dir, { recursive: true });
    await expect(submitBatch(dir, { token: TOKEN })).rejects.toMatchObject({ code: EXIT.usage });
  });
});

describe('status', () => {
  it('带 limit 拼查询串', async () => {
    const { impl, calls } = fakeFetch({ '/api/agent/status': { body: statusBody } });
    await status(5, { token: TOKEN, fetchImpl: impl });
    expect(calls[0]!.url).toContain('limit=5');
  });

  it('不带 limit 不拼查询串', async () => {
    const { impl, calls } = fakeFetch({ '/api/agent/status': { body: statusBody } });
    await status(undefined, { token: TOKEN, fetchImpl: impl });
    expect(calls[0]!.url).not.toContain('limit=');
  });

  it('返回 reason 供 Agent 自我纠正', async () => {
    const rejected = { ...statusBody, submissions: [{ id: 'r1', kind: 'station', status: 'rejected', createdAt: '2026-01-01T00:00:00Z', reason: '缺少描述' }] };
    const { impl } = fakeFetch({ '/api/agent/status': { body: rejected } });
    expect((await status(undefined, { token: TOKEN, fetchImpl: impl })).submissions[0]!.reason).toBe('缺少描述');
  });
});

describe('run 的端到端输出', () => {
  it('login 成功后把凭证写入配置文件', async () => {
    const { impl } = fakeFetch({ '/api/agent/status': { body: statusBody } });
    const original = globalThis.fetch;
    globalThis.fetch = impl;
    try {
      expect(await run(['login', '--key', TOKEN])).toBe(EXIT.ok);
    } finally {
      globalThis.fetch = original;
    }
    expect(await readConfig()).toMatchObject({ token: TOKEN });
  });

  it('未登录时 whoami 返回 5', async () => {
    expect(await run(['whoami'])).toBe(EXIT.unauthorized);
  });

  it('validate 校验失败返回 3', async () => {
    const path = join(home, 'bad-station.json');
    await writeFile(path, JSON.stringify({ ...station, url: 'ftp://a.com/' }));
    expect(await run(['validate', path])).toBe(EXIT.validation);
  });

  it('validate 通过返回 0', async () => {
    const path = join(home, 'good.json');
    await writeFile(path, JSON.stringify(post));
    expect(await run(['validate', path])).toBe(EXIT.ok);
  });
});

describe('凭证不外泄', () => {
  it('写入的配置里只有明文凭证本身，不含其他派生信息', async () => {
    await writeConfig({ apiBase: 'https://api.test', token: TOKEN });
    const raw = await readFile(configPath(), 'utf8');
    expect(JSON.parse(raw)).toEqual({ apiBase: 'https://api.test', token: TOKEN });
  });
});
