import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  EXIT, catalog, configPath, inferKind, login, matchModel, normalizeModelName, parseArgs,
  readConfig, resolveToken, run, status, submitBatch, submitFile, submitOne, validate,
  scrubSecret, validatePayload, whoami, writeConfig, ZdError,
} from '../zdd.ts';

let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'zdd-test-'));
  process.env.ZDD_CONFIG_HOME = home;
  process.env.ZDD_API_BASE = 'https://api.test';
  delete process.env.ZDD_TOKEN;
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
  delete process.env.ZDD_CONFIG_HOME;
  delete process.env.ZDD_API_BASE;
  delete process.env.ZDD_TOKEN;
});

// 与服务端签发格式一致：zd_ + 32 字节 base64url，固定 43 个字符。
const TOKEN = 'zd_' + 'a'.repeat(43);
const station = { name: '测试站', description: '描述', url: 'https://a.com/', rechargeThreshold: null, paymentMethods: [], offers: [] };
const post = { title: '标题', summary: '摘要', body: '正文', authorName: '昵称' };

/** 构造一个按路径与状态码返回的假 fetch。 */
function fakeFetch(routes: Record<string, { status?: number; body?: unknown }>) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    // 按路径匹配，不依赖主机名——地址优先级的用例会换主机。
    const path = new URL(url).pathname + new URL(url).search;
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

  it('--flag=value 形式正确解析', () => {
    expect(parseArgs(['status', '--limit=5']).flags).toEqual({ limit: '5' });
  });

  it('-- 之后的参数一律当位置参数', () => {
    expect(parseArgs(['match', '--', '--weird-name']).positional).toEqual(['--weird-name']);
    expect(parseArgs(['match', '--', '--weird-name']).flags).toEqual({});
  });

  it('值本身以 -- 开头时用 = 形式传递', () => {
    expect(parseArgs(['match', '--q=--abc']).flags).toEqual({ q: '--abc' });
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
    process.env.ZDD_TOKEN = TOKEN;
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
      expect((await stat(join(home, 'zdd'))).mode & 0o777).toBe(0o700);
    }
  });

  it('配置文件不存在时返回 null 而不是抛错', async () => {
    expect(await readConfig()).toBeNull();
  });

  it('配置文件损坏时返回 null', async () => {
    await mkdir(join(home, 'zdd'), { recursive: true });
    await writeFile(configPath(), '{not json');
    expect(await readConfig()).toBeNull();
  });

  it('没有凭证时抛出未登录错误', async () => {
    await expect(resolveToken()).rejects.toThrow(ZdError);
    await expect(resolveToken()).rejects.toMatchObject({ code: EXIT.unauthorized });
  });

  it('ZDD_TOKEN 优先于配置文件', async () => {
    await writeConfig({ apiBase: 'https://api.test', token: TOKEN });
    process.env.ZDD_TOKEN = 'zd_fromenv';
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

describe('地址优先级', () => {
  const statusOk = { '/api/agent/status': { body: statusBody } };

  it('没有环境变量时用配置里记住的地址', async () => {
    delete process.env.ZDD_API_BASE;
    await writeConfig({ apiBase: 'https://saved.invalid', token: TOKEN });
    const { impl, calls } = fakeFetch(statusOk);
    await whoami({ fetchImpl: impl });
    expect(calls[0]!.url).toContain('https://saved.invalid');
  });

  it('重新登录不会把配置地址改回线上默认', async () => {
    // 曾经验证走 resolveBase()、落盘走 apiBase()，结果在自定义地址上重新
    // 登录一次，地址被改写成线上默认，下一次请求带着凭证打到生产站点。
    delete process.env.ZDD_API_BASE;
    await writeConfig({ apiBase: 'https://saved.invalid', token: TOKEN });
    const { impl, calls } = fakeFetch(statusOk);
    await login(TOKEN, { fetchImpl: impl });
    expect(calls[0]!.url).toContain('https://saved.invalid');
    expect(await readConfig()).toMatchObject({ apiBase: 'https://saved.invalid' });
  });

  it('环境变量优先于配置', async () => {
    delete process.env.ZDD_API_BASE;
    await writeConfig({ apiBase: 'https://saved.invalid', token: TOKEN });
    const { impl, calls } = fakeFetch(statusOk);
    await whoami({ fetchImpl: impl });
    expect(calls[0]!.url).toContain('https://saved.invalid');
    process.env.ZDD_API_BASE = 'https://env.invalid';
    const second = fakeFetch(statusOk);
    await whoami({ fetchImpl: second.impl });
    expect(second.calls[0]!.url).toContain('https://env.invalid');
  });
});

describe('凭证脱敏', () => {
  it('长业务文本不会被误抹', () => {
    // 早期用「zd_ 后至少 16 个字符」判断，会把这类正常标识抹成 zd_***。
    expect(scrubSecret('zd_model_identifier_2026')).toBe('zd_model_identifier_2026');
    expect(scrubSecret('zd_' + 'x'.repeat(44))).toBe('zd_' + 'x'.repeat(44));
  });

  it('批量结果走 emit 时脱敏，错误消息里的凭证不会进 stdout', async () => {
    // 批量走的是成功路径，早先只在外层 catch 里脱敏，明文照样打出去。
    const secret = 'zd_' + 'B'.repeat(43);
    expect(JSON.stringify(scrubSecret({ failed: [{ message: `凭据 ${secret} 无效` }] })))
      .not.toContain(secret);
  });

  it('对象键名里的凭证也被抹掉', () => {
    const secret = 'zd_' + 'D'.repeat(43);
    expect(JSON.stringify(scrubSecret({ [secret]: 'x' }))).not.toContain(secret);
  });

  it('错误消息里的凭证被抹掉', () => {
    expect(scrubSecret(`令牌 ${TOKEN} 无效`)).toBe('令牌 zd_*** 无效');
  });

  it('嵌套结构里的凭证也被抹掉', () => {
    expect(JSON.stringify(scrubSecret({ error: { message: `bad ${TOKEN}` } })))
      .not.toContain(TOKEN);
  });

  it('普通消息不受影响', () => {
    expect(scrubSecret('单账号待审投稿已达 5 条')).toBe('单账号待审投稿已达 5 条');
  });

  it('服务端错误响应里带凭证时，输出中不含明文', async () => {
    const { impl } = fakeFetch({ '/api/agent/status': { status: 400, body: { error: { message: `bad token ${TOKEN}` } } } });
    await expect(status(undefined, { token: TOKEN, fetchImpl: impl })).rejects.toBeInstanceOf(ZdError);
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

describe('catalog 分页', () => {
  it('翻页取完全部模型，不只第一页', async () => {
    const pages = [
      { items: Array.from({ length: 50 }, (_, i) => ({ slug: `m${i}`, name: `M${i}`, vendor: 'v' })), total: 60, page: 1, pageSize: 50 },
      { items: Array.from({ length: 10 }, (_, i) => ({ slug: `m${50 + i}`, name: `M${50 + i}`, vendor: 'v' })), total: 60, page: 2, pageSize: 50 },
    ];
    let call = 0;
    const impl = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/api/vendors')) return new Response(JSON.stringify({ items: [], total: 0 }), { status: 200 });
      if (url.includes('/api/models')) return new Response(JSON.stringify(pages[call++] ?? pages[1]), { status: 200 });
      return new Response(JSON.stringify({ items: [], total: 0 }), { status: 200 });
    }) as unknown as typeof fetch;
    const result = await catalog({ fetchImpl: impl });
    expect(result.models).toHaveLength(60);
  });
});

describe('错误分类', () => {
  it('JSON 格式的 503 也归为可重试，而不是让 Agent 去改数据', async () => {
    const { impl } = fakeFetch({ '/api/agent/status': { status: 503, body: { error: { message: '数据库繁忙' } } } });
    await expect(status(undefined, { token: TOKEN, fetchImpl: impl })).rejects.toMatchObject({ code: EXIT.network });
  });

  it('HTML 403 归为未登录（CDN 拦请求的典型形态）', async () => {
    const impl = (async () => new Response('<html>forbidden</html>', { status: 403 })) as unknown as typeof fetch;
    await expect(status(undefined, { token: TOKEN, fetchImpl: impl })).rejects.toMatchObject({ code: EXIT.unauthorized });
  });

  it('成功状态但正文不是 JSON 时归为可重试', async () => {
    const impl = (async () => new Response('<html>ok</html>', { status: 200 })) as unknown as typeof fetch;
    await expect(status(undefined, { token: TOKEN, fetchImpl: impl })).rejects.toMatchObject({ code: EXIT.network });
  });
});

describe('参数校验', () => {
  it('--limit 缺值报用法错误，不静默用默认值', async () => {
    process.env.ZDD_TOKEN = TOKEN;
    expect(await run(['status', '--limit'])).toBe(EXIT.usage);
  });

  it('--limit 超过服务端上限 50 报用法错误', async () => {
    process.env.ZDD_TOKEN = TOKEN;
    expect(await run(['status', '--limit', '51'])).toBe(EXIT.usage);
    expect(await run(['status', '--limit', '50'])).not.toBe(EXIT.usage);
  });

  it('未知命令不回显输入，避免把误传的凭证打到终端', async () => {
    const secret = 'zd_' + 'b'.repeat(40);
    expect(await run([secret])).toBe(EXIT.usage);
  });
});

describe('配置文件原子写入', () => {
  it('覆盖已存在的宽权限文件后，权限收紧为 600 且内容是新凭证', async () => {
    await mkdir(join(home, 'zdd'), { recursive: true });
    await writeFile(configPath(), JSON.stringify({ apiBase: 'x', token: 'zd_old' }), { mode: 0o666 });
    await chmod(configPath(), 0o666);
    await writeConfig({ apiBase: 'https://api.test', token: TOKEN });
    expect(await readConfig()).toMatchObject({ token: TOKEN });
    if (process.platform !== 'win32') {
      expect((await stat(configPath())).mode & 0o777).toBe(0o600);
    }
  });

  it('写入后目录里不留临时文件', async () => {
    await writeConfig({ apiBase: 'https://api.test', token: TOKEN });
    const entries = await readdir(join(home, 'zdd'));
    expect(entries.filter(name => name.endsWith('.tmp'))).toHaveLength(0);
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

describe('与服务端一致的严格校验', () => {
  it('多出未声明的字段时本地就拒绝，不等到服务端', () => {
    expect(validatePayload({ ...station, extraField: 1 }).issues[0]!.message).toContain('多余字段');
  });

  it('实测指标类字段本地就拒绝', () => {
    for (const field of ['uptime', 'firstTokenLatencyMs', 'foundedAt', 'status', 'score']) {
      const result = validatePayload({ ...station, [field]: 1 });
      expect(result.issues[0]!.field).toBe(field);
      expect(result.issues[0]!.message).toContain('不允许');
    }
  });

  it('禁字段的变体写法也拒绝：大小写、下划线、连字符', () => {
    for (const key of ['Uptime', 'first_token_latency_ms', 'API-KEY']) {
      expect(validatePayload({ ...station, [key]: 1 }).issues.length).toBeGreaterThan(0);
    }
  });

  it('嵌套里的禁字段也拒绝', () => {
    const result = validatePayload({ ...station, metadata: { uptime: 99 } });
    expect(result.issues[0]!.field).toBe('metadata.uptime');
  });

  it('评价不接受 authorHandle，作者由凭证决定', () => {
    expect(validatePayload({ ...post, authorHandle: 'someone' }).issues.length).toBeGreaterThan(0);
  });

  it('站点和评价混在一起时本地拒绝', () => {
    expect(validatePayload({ ...station, ...post }).issues.length).toBeGreaterThan(0);
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

describe('启动壳的错误路径', () => {
  it('依赖缺失时输出结构化 JSON 而不是静默退出', async () => {
    // Agent 只能看退出码和 stdout。空输出会让它以为参数写错了，
    // 于是反复改参数，而真正该做的是 pnpm install。
    const root = join(import.meta.dirname, '..', '..');
    const script = await readFile(join(root, 'scripts', 'zdd'), 'utf8');
    expect(script).toContain('ERR_MODULE_NOT_FOUND');
    expect(script).toContain('pnpm install');
    // 结构化结果走 stdout，不是 stderr。
    expect(script).toMatch(/printf '%s\\n' '\{"ok":false/);
    // 探测必须在 scripts/ 目录内进行，否则解析不到 scripts 的依赖。
    expect(script).toContain('cd "$target"');
  });
});

describe('模型投稿', () => {
  const model = { slug: 'claude-sonnet-4-5', vendor: 'anthropic', name: 'Claude Sonnet 4.5', description: '一句话说明' };

  it('同时有 slug 和 vendor 时按模型判断', () => {
    expect(inferKind(model)).toBe('model');
  });

  it('只有 slug 不算模型，避免和别的形状混淆', () => {
    expect(inferKind({ slug: 'only-slug' })).toBeNull();
  });

  it('url 优先于 slug/vendor', () => {
    expect(inferKind({ ...model, url: 'https://x.example.com/' })).toBe('station');
  });

  it('合法模型通过本地校验', () => {
    expect(validatePayload(model)).toEqual({ kind: 'model', issues: [] });
  });

  it('slug 大写会被规范成小写而不是报错', () => {
    // 前端表单本来就转小写；服务端也转，避免「UI 能过、直接调接口被拒」。
    expect(validatePayload({ ...model, slug: 'Claude-Sonnet' })).toEqual({ kind: 'model', issues: [] });
  });

  it('slug 含非法字符才报错，且说明规则', () => {
    const issues = validatePayload({ ...model, slug: 'a b' }).issues;
    expect(issues).toHaveLength(1);
    expect(issues[0]!.field).toBe('slug');
    expect(issues[0]!.message).toContain('小写字母、数字和连字符');
  });

  it('模型带了 title 被当成评价时，明确点出来', () => {
    // 推断顺序是 url → title → slug+vendor，所以模型带了 title 会先被判成评价。
    // 光靠「缺少 summary/body」这种报错，用户不知道发生了什么。
    const { kind, issues } = validatePayload({ ...model, title: '误加' });
    expect(kind).toBe('post');
    expect(issues.at(-1)!.message).toContain('这条看起来是模型');
  });

  it('模型提交到 /api/agent/models', async () => {
    const { impl, calls } = fakeFetch({ '/api/agent/models': { body: { submission: { id: 'm1', status: 'pending' }, deduplicated: false } } });
    const result = await submitOne(model, { token: TOKEN, fetchImpl: impl });
    expect(result.submission.id).toBe('m1');
    expect(calls[0]!.url).toContain('/api/agent/models');
  });
});
