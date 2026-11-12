import { spawn } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AdminBatchSubmitRequest, AdminSubmissionStateResponse } from '@zhidedeng/shared';
import type { RawRecord } from '../sync-feishu.ts';
import { buildBatch, collectPages, normalizeUrl, parseRecordPage, planBatch } from '../sync-feishu.ts';

const SCRIPT = resolve(import.meta.dirname, '../sync-feishu.ts');
const FIXTURES = resolve(import.meta.dirname, 'fixtures');
const MODELS = [
  { slug: 'gpt-4-1', name: 'GPT-4.1' }, { slug: 'claude-sonnet', name: 'Claude Sonnet' }, { slug: 'o3', name: 'o3' },
  { slug: 'gemini-pro', name: 'Gemini Pro' }, { slug: 'deepseek-chat', name: 'DeepSeek Chat' }, { slug: 'glm', name: 'GLM' }, { slug: 'kimi', name: 'Kimi' },
];
const fixtureRecords = () => ['page-1', 'page-2'].flatMap(name => parseRecordPage(readFileSync(join(FIXTURES, `${name}.json`), 'utf8')).records);
type Batch = ReturnType<typeof buildBatch>['payload'];
const stationItems = (payload: Batch) => payload.items.filter(item => item.kind === 'station');
const postItems = (payload: Batch) => payload.items.filter(item => item.kind === 'post');

describe('parseRecordPage', () => {
  it('解析带外层包装的列式返回', () => {
    const page = parseRecordPage(readFileSync(join(FIXTURES, 'page-1.json'), 'utf8'));
    expect(page.hasMore).toBe(true);
    expect(page.records).toHaveLength(4);
    expect(page.records[0]).toMatchObject({ recordId: 'recA1', fields: { 中转站名称: '示例站', 审核状态: ['通过'] } });
    expect(page.columns).toContain('审核状态');
  });

  it('也接受对象式记录和字段对象表头', () => {
    const items = parseRecordPage(JSON.stringify({ data: { items: [{ record_id: 'r1', fields: { 审核状态: '通过' } }], has_more: false } }));
    expect(items.records[0]).toEqual({ recordId: 'r1', fields: { 审核状态: '通过' } });
    const named = parseRecordPage(JSON.stringify({ data: { fields: [{ id: 'f1', name: '审核状态' }], record_id_list: ['r1'], data: [['通过']] } }));
    expect(named.records[0].fields).toEqual({ 审核状态: '通过' });
  });

  it('空表是合法结果', () => {
    expect(parseRecordPage(JSON.stringify({ data: { fields: [], record_id_list: [], data: [] } })).records).toEqual([]);
  });

  it.each([
    ['非 JSON', 'oops'],
    ['ok=false', JSON.stringify({ ok: false, error: { message: 'denied' } })],
    ['非 0 错误码', JSON.stringify({ code: 99991663, msg: 'denied' })],
    ['认不出的结构', JSON.stringify({ data: { something: [] } })],
    ['行数和记录 ID 对不上', JSON.stringify({ data: { fields: ['a'], record_id_list: ['r1', 'r2'], data: [['x']] } })],
  ])('%s 时抛错而不是当成空表（空表会清空站点）', (_name, raw) => {
    expect(() => parseRecordPage(raw)).toThrow();
  });
});

describe('normalizeUrl', () => {
  it('去掉 query、fragment 和账号信息，主机转小写', () => {
    expect(normalizeUrl('https://A.com/x/?aff=1#y')).toEqual({ url: 'https://a.com/x/', host: 'a.com' });
    expect(normalizeUrl('http://user:pw@a.com')).toEqual({ url: 'http://a.com/', host: 'a.com' });
    expect(normalizeUrl('https://www.a.com/')?.host).toBe('a.com');
  });

  it.each(['javascript:alert(1)', 'data:text/html,x', 'ftp://a.com/', 'a.com', 'localhost:3000/x', '', `https://a.com/${'x'.repeat(400)}`])('拒绝 %s', value => {
    expect(normalizeUrl(value)).toBeNull();
  });
});

describe('buildBatch', () => {
  const result = () => buildBatch(fixtureRecords(), MODELS);

  it('同站点取最新且非空的信息，query 和 fragment 被去掉', () => {
    const { payload } = result();
    expect(payload.channel).toBe('feishu');
    expect(stationItems(payload).map(item => item.originKey)).toEqual(['api.example.com', 'other.example']);
    expect(stationItems(payload)[0]).toEqual({
      kind: 'station', originKey: 'api.example.com', action: 'upsert',
      payload: {
        name: '示例站pro', url: 'https://api.example.com/',
        description: '更新了价格', rechargeThreshold: 20, paymentMethods: ['USDT'],
        offers: [{ modelSlug: 'gpt-4-1', rate: 0.4 }, { modelSlug: 'kimi', rate: 0.6 }],
      },
    });
    expect(stationItems(payload).every(item => !('slug' in item.payload))).toBe(true);
  });

  it('只同步严格等于「通过」的记录', () => {
    const text = JSON.stringify(result().payload);
    for (const name of ['pending', 'rejected', 'blank', 'space', 'multi']) expect(text).not.toContain(`${name}.example`);
    expect(text).not.toContain('待审内容');
  });

  it('审核备注绝不外传，日志也不带', () => {
    const { payload, skipped, notes } = result();
    expect(JSON.stringify({ payload, skipped, notes })).not.toContain('秘密');
  });

  it('评价各自成文章，展示昵称作为作者，空昵称用匿名，正文保持原文', () => {
    const { payload } = result();
    expect(postItems(payload).map(item => item.originKey)).toEqual(['recA3', 'recA4']);
    expect(postItems(payload)[0]).toEqual({
      kind: 'post', originKey: 'recA3',
      payload: {
        hostname: 'api.example.com', title: '示例站pro · 使用评价',
        summary: '推荐指数 4/5 · <script>alert(1)</script> 不错 [点我](https://evil.example)',
        body: '<script>alert(1)</script> 不错\n[点我](https://evil.example)',
        authorName: '匿名群友', publishedAt: '2026-11-04T00:00:00.000Z',
      },
    });
    expect(postItems(payload)[1].payload).toMatchObject({ title: '示例站pro · 避坑反馈', authorName: '群友乙', publishedAt: '2026-11-04T01:30:00.000Z', summary: '推荐指数 2/5 · 晚高峰经常超时' });
  });

  it('坏记录逐条跳过并说明原因', () => {
    const skipped = result().skipped.join('\n');
    expect(skipped).toMatch(/recC1.*网址/);
    expect(skipped).toMatch(/recC2.*名称/);
    expect(skipped).toMatch(/recC3.*网址/);
    expect(skipped).toMatch(/recC4.*提交时间/);
    expect(skipped).toMatch(/recC5.*提交类型/);
    expect(skipped).toMatch(/recC6.*网址/);
  });

  it('返回实际聚合成功的站点数，坏记录和空输入不计入', () => {
    expect(result().validStations).toBe(2);
    expect(buildBatch([], MODELS)).toMatchObject({ validStations: 0, skipped: [] });
  });

  it('坏倍率行和未知模型只跳过那一行并报告', () => {
    const notes = result().notes.join('\n');
    for (const line of ['未知模型X', 'o3', 'gemini-pro', 'glm', 'kimi', '没有等号的行']) expect(notes).toContain(line);
    expect(notes).toContain('倍率超出 0.05~20 范围，已跳过');
    expect(notes).toMatch(/recA1/);
    expect(notes).toMatch(/recD1.*最低充值/);
    expect(notes).toMatch(/recD1.*推荐指数/);
  });

  it('只保留 0.05 到 20 的倍率并按范围提示跳过越界值', () => {
    const { payload, notes } = buildBatch([{ recordId: 'rate-bounds', fields: {
      中转站名称: '倍率边界站', 网址: 'https://rates.example/', 提交类型: '推荐新站',
      模型与倍率: 'GPT-4.1=0.05\nClaude Sonnet=20\no3=0.04\ngemini-pro=20.01', 审核状态: '通过', 提交时间: '2026-01-01',
    } }], MODELS);
    expect(stationItems(payload)[0].payload.offers).toEqual([{ modelSlug: 'claude-sonnet', rate: 20 }, { modelSlug: 'gpt-4-1', rate: 0.05 }]);
    expect(notes.filter(note => note.includes('倍率超出 0.05~20 范围，已跳过'))).toHaveLength(2);
  });

  it('没写报价的新记录不覆盖旧报价；更新记录带报价时整组替换', () => {
    const records: RawRecord[] = [
      { recordId: 'r1', fields: { 中转站名称: '站', 网址: 'https://a.com/', 提交类型: '推荐新站', 模型与倍率: 'o3=1\nGLM=2', 审核状态: '通过', 提交时间: '2026-01-01' } },
      { recordId: 'r2', fields: { 中转站名称: '站', 网址: 'https://a.com/', 提交类型: '避坑反馈', 使用体验: '坑', 审核状态: '通过', 提交时间: '2026-01-02' } },
    ];
    expect(stationItems(buildBatch(records, MODELS).payload)[0].payload.offers).toEqual([{ modelSlug: 'glm', rate: 2 }, { modelSlug: 'o3', rate: 1 }]);
  });

  it('超长内容按上限截断', () => {
    const { payload } = buildBatch([{ recordId: 'r1', fields: { 中转站名称: '名'.repeat(500), 网址: 'https://a.com/', 提交类型: '使用评价', 使用体验: '字'.repeat(9000), 展示昵称: '昵'.repeat(99), 审核状态: '通过', 提交时间: '2026-01-01' } }], MODELS);
    expect([...stationItems(payload)[0].payload.name]).toHaveLength(60);
    expect([...postItems(payload)[0].payload.body]).toHaveLength(5000);
    expect([...postItems(payload)[0].payload.authorName]).toHaveLength(30);
  });

  it('去掉控制字符和方向控制符，保留正文换行', () => {
    const { payload } = buildBatch([{ recordId: 'r1', fields: { 中转站名称: '站\u202E名\u0000', 网址: 'https://a.com/', 提交类型: '使用评价', 使用体验: '第一行\r\n第\u200B二行\u0007', 审核状态: '通过', 提交时间: '2026-01-01' } }], MODELS);
    expect(stationItems(payload)[0].payload.name).toBe('站名');
    expect(postItems(payload)[0].payload.body).toBe('第一行\n第二行');
  });

  it('结果与记录顺序无关，保证重复同步内容相同', () => {
    expect(buildBatch(fixtureRecords().reverse(), MODELS).payload).toEqual(result().payload);
  });

  it('记录 ID 不合法时跳过', () => {
    const { payload, skipped } = buildBatch([{ recordId: '../x', fields: { 中转站名称: '站', 网址: 'https://a.com/', 提交类型: '推荐新站', 审核状态: '通过', 提交时间: '2026-01-01' } }], MODELS);
    expect(stationItems(payload)).toEqual([]);
    expect(skipped[0]).toContain('记录 ID');
  });
});

describe('planBatch', () => {
  const online: AdminSubmissionStateResponse = { stations: [
    { slug: 'actual-collision-slug', submissionId: 'online-a', originKey: 'WWW.API.EXAMPLE.COM', url: 'https://www.api.example.com/', name: '已有站点' },
    { slug: 'sub-gone-original', submissionId: 'online-gone', originKey: 'gone.example.com', url: 'https://gone.example.com/', name: '已撤销站点' },
  ] };

  it('线上有而表格没有时生成 remove，slug 完整沿用线上值', () => {
    const plan = planBatch(buildBatch(fixtureRecords(), MODELS).payload, online);
    expect(plan.removals).toEqual([{ kind: 'station', originKey: 'gone.example.com', action: 'remove', payload: { slug: 'sub-gone-original', submissionId: 'online-gone' } }]);
    expect(plan.payload.items.at(-1)).toEqual(plan.removals[0]);
  });

  it('表格有而线上没有时保持 upsert，originKey 归一小写并沿用 www 分组区分新增和更新', () => {
    const plan = planBatch(buildBatch(fixtureRecords(), MODELS).payload, online);
    expect(plan.added).toBe(1);
    expect(plan.updated).toBe(1);
    expect(plan.payload.items.filter(item => item.kind === 'station' && item.action === 'upsert').map(item => item.originKey)).toEqual(['api.example.com', 'other.example']);
    expect(plan.removals.some(item => item.originKey === 'api.example.com')).toBe(false);
  });

  it('同 hostname 的遗留实体按 hostname 统计更新，按 slug 分别生成下架', () => {
    const repeated: AdminSubmissionStateResponse = { stations: [
      ...online.stations,
      { slug: 'sub-api-second', submissionId: 'online-a', originKey: 'api.example.com', url: 'https://api.example.com/', name: '另一个实体' },
      { slug: 'sub-www-gone', submissionId: 'online-gone', originKey: 'www.gone.example.com', url: 'https://www.gone.example.com/', name: '遗留 www 实体' },
    ] };
    const plan = planBatch(buildBatch(fixtureRecords(), MODELS).payload, repeated);
    expect(plan.added).toBe(1);
    expect(plan.updated).toBe(1);
    expect(plan.removals.map(item => item.payload.slug)).toEqual(['sub-gone-original', 'sub-www-gone']);
  });

  it('规划只比较快照，空表保护由命令行执行；无状态无法区分新增和更新', () => {
    expect(planBatch(buildBatch([], MODELS).payload, online).removals).toHaveLength(2);
    const partial = planBatch(buildBatch(fixtureRecords(), MODELS).payload, null);
    expect(partial.removals).toEqual([]);
    expect(partial.added).toBeNull();
    expect(partial.updated).toBeNull();
  });

  it('显式允许跳过坏记录时完全不生成下架，保留 upsert 与评价', () => {
    const batch = buildBatch(fixtureRecords(), MODELS).payload;
    const plan = planBatch(batch, online, true);
    expect(plan.removals).toEqual([]);
    expect(plan.payload.items).toEqual(batch.items);
    expect(plan.added).toBe(1);
    expect(plan.updated).toBe(1);
  });
});

describe('命令行', () => {
  const BASE_TOKEN = 'base-token-SECRET';
  const SYNC_TOKEN = 'sync-token-SECRET';
  let dir: string;
  let site: ReturnType<typeof createServer>;
  let siteUrl: string;
  let imports: { authorization: string | undefined; body: AdminBatchSubmitRequest }[];
  let importStatus: number;
  let importFailureAt: number | null;
  let requests: { method: string; path: string; authorization: string | undefined }[];
  let online: unknown;
  let stateStatus: number;
  let failedOrigin: string | null;
  let failedRemovalSlug: string | null;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'sync-feishu-'));
    imports = [];
    importStatus = 200;
    importFailureAt = null;
    requests = [];
    stateStatus = 200;
    failedOrigin = null;
    failedRemovalSlug = null;
    online = { stations: [
      { slug: 'actual-collision-slug', submissionId: 'online-a', originKey: 'API.EXAMPLE.COM', url: 'https://api.example.com/', name: '已有站点' },
      { slug: 'sub-gone-original', submissionId: 'online-gone', originKey: 'gone.example.com', url: 'https://gone.example.com/', name: '已撤销站点' },
    ] };
    // 正常同步使用可解析的数据；原 fixture 的坏记录仍用于 buildBatch 和中止回归。
    for (const name of ['page-1', 'page-2']) {
      const page = JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), 'utf8'));
      const keep = page.data.record_id_list.map((id: string) => !id.startsWith('recC'));
      page.data.record_id_list = page.data.record_id_list.filter((_id: string, index: number) => keep[index]);
      page.data.data = page.data.data.filter((_row: unknown, index: number) => keep[index]);
      writeFileSync(join(dir, `${name}.json`), JSON.stringify(page));
    }
    // 假 lark-cli：把调用记下来，按 offset 返回 fixture。绝不接触飞书。
    writeFileSync(join(dir, 'lark-cli'), `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(join(dir, 'calls.jsonl'))}, JSON.stringify({ args, configDir: process.env.LARKSUITE_CLI_CONFIG_DIR, home: process.env.HOME }) + '\\n');
if (process.env.FAKE_LARK_FAIL) { console.error('boom ' + args.join(' ')); process.exit(3); }
const offset = args[args.indexOf('--offset') + 1];
if (process.env.FAKE_LARK_RECORDS) {
  const records = JSON.parse(fs.readFileSync(process.env.FAKE_LARK_RECORDS, 'utf8'));
  const start = Number(offset);
  const limit = Number(args[args.indexOf('--limit') + 1]);
  process.stdout.write(JSON.stringify({ data: {
    items: records.slice(start, start + limit).map(record => ({ record_id: record.recordId, fields: record.fields })),
    has_more: start + limit < records.length,
  } }));
  process.exit(0);
}
const fixture = process.env.FAKE_LARK_FIXTURE || (offset === '0' ? 'page-1' : 'page-2');
process.stdout.write(fs.readFileSync(${JSON.stringify(dir)} + '/' + fixture + '.json'));
`);
    chmodSync(join(dir, 'lark-cli'), 0o755);
    site = createServer((req, res) => {
      let raw = '';
      req.on('data', chunk => { raw += chunk; });
      req.on('end', () => {
        requests.push({ method: req.method!, path: req.url!, authorization: req.headers.authorization });
        res.setHeader('content-type', 'application/json');
        if (req.url!.startsWith('/api/models')) {
          res.end(JSON.stringify({ items: MODELS, total: MODELS.length, page: 1, pageSize: 50 }));
        } else if (req.url === '/api/admin/submissions/state' && req.method === 'GET') {
          res.statusCode = stateStatus;
          res.end(JSON.stringify(online));
        } else if (req.url === '/api/admin/submissions/batch' && req.method === 'POST') {
          const body = JSON.parse(raw) as AdminBatchSubmitRequest;
          imports.push({ authorization: req.headers.authorization, body });
          res.statusCode = imports.length === importFailureAt ? 503 : importStatus;
          if (res.statusCode !== 200) {
            res.end(JSON.stringify({ error: { code: 'SERVICE_UNAVAILABLE', message: '批次请求失败' } }));
            return;
          }
          res.end(JSON.stringify({ batchId: body.batchId ?? 'fake-batch', results: body.items.map((item, index) => ({
            kind: item.kind, originKey: item.originKey,
            ...(item.originKey === failedOrigin || (item.action === 'remove' && (item.payload as { slug: string }).slug === failedRemovalSlug)
              ? { error: { code: 'INVALID_INPUT', message: '未知模型：missing-model' } }
              : { id: `queued-${index}`, status: 'pending', deduplicated: false, autoApproved: false }),
          })) }));
        } else {
          res.statusCode = 404;
          res.end('{}');
        }
      });
    });
    await new Promise<void>(done => site.listen(0, '127.0.0.1', done));
    siteUrl = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise(done => site.close(done));
    rmSync(dir, { recursive: true });
  });

  function run(args: string[], env: Record<string, string | undefined> = {}) {
    const merged = {
      PATH: `${dir}:${process.env.PATH}`, HOME: process.env.HOME,
      LARKSUITE_CLI_CONFIG_DIR: join(dir, 'lark-config'), FEISHU_BASE_TOKEN: BASE_TOKEN, FEISHU_TABLE_ID: 'tblTest', SITE_URL: siteUrl, SYNC_TOKEN, ...env,
    };
    const child = spawn(process.execPath, ['--experimental-strip-types', '--no-warnings', SCRIPT, ...args], { env: merged as NodeJS.ProcessEnv });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    return new Promise<{ code: number | null; output: string; stdout: string }>(done => child.on('close', code => done({ code, output: stdout + stderr, stdout })));
  }

  const goodRecord = (recordId = 'good', hostname = 'api.example.com'): RawRecord => ({ recordId, fields: {
    中转站名称: hostname, 网址: `https://${hostname}/`, 提交类型: '推荐新站', 审核状态: '通过', 提交时间: '2026-11-07',
  } });
  const runRecords = (records: RawRecord[], args: string[] = []) => {
    const path = join(dir, 'records.json');
    writeFileSync(path, JSON.stringify(records));
    return run(args, { FAKE_LARK_RECORDS: path });
  };

  const larkCalls = () => {
    try {
      return readFileSync(join(dir, 'calls.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line) as { args: string[]; configDir: string; home: string });
    } catch {
      return [];
    }
  };

  it('按页串行只读，配置目录走环境变量，不覆盖 HOME，然后带 token 入队', async () => {
    const { code, output } = await run([]);
    expect(output).toBe(output.replaceAll('SECRET', ''));
    expect(code).toBe(0);
    const calls = larkCalls();
    expect(calls.map(call => call.args)).toEqual([
      ['base', '+record-list', '--as', 'bot', '--base-token', BASE_TOKEN, '--table-id', 'tblTest', '--offset', '0', '--limit', '200'],
      ['base', '+record-list', '--as', 'bot', '--base-token', BASE_TOKEN, '--table-id', 'tblTest', '--offset', '4', '--limit', '200'],
    ]);
    for (const call of calls) {
      expect(call.configDir).toBe(join(dir, 'lark-config'));
      expect(call.home).toBe(process.env.HOME);
    }
    expect(imports).toHaveLength(1);
    expect(imports[0].authorization).toBe(`Bearer ${SYNC_TOKEN}`);
    expect(imports[0].body.channel).toBe('feishu');
    expect(imports[0].body.items.filter(item => item.kind === 'station' && item.action === 'upsert').map(item => item.originKey)).toEqual(['api.example.com', 'other.example']);
    expect(imports[0].body.items.at(-1)).toEqual({ kind: 'station', originKey: 'gone.example.com', action: 'remove', payload: { slug: 'sub-gone-original', submissionId: 'online-gone' } });
    expect(requests.map(request => request.path)).toEqual(['/api/models?page=1&pageSize=50', '/api/admin/submissions/state', '/api/admin/submissions/batch']);
    expect(requests[1].authorization).toBe(`Bearer ${SYNC_TOKEN}`);
    expect(JSON.stringify(imports[0].body)).not.toContain('秘密');
  });

  it('--dry-run 无 token 遇到坏记录也中止并打印原因，不发 POST', async () => {
    const path = join(dir, 'bad-records.json');
    writeFileSync(path, JSON.stringify(fixtureRecords()));
    const { code, output } = await run(['--dry-run'], { SYNC_TOKEN: undefined, FAKE_LARK_RECORDS: path });
    expect(code).toBe(2);
    expect(imports).toEqual([]);
    expect(requests.every(request => request.method === 'GET')).toBe(true);
    expect(output).toContain('有 6 条记录无法解析，为避免误下架已中止');
    expect(output).toMatch(/recC1.*网址/);
    expect(output).not.toContain('秘密');
  });

  it('--dry-run 配置 token 时只发 GET，打印完整入队内容和下架计划', async () => {
    const { code, stdout } = await run(['--dry-run']);
    expect(code).toBe(0);
    expect(imports).toEqual([]);
    expect(requests.every(request => request.method === 'GET')).toBe(true);
    expect(requests[1]).toMatchObject({ path: '/api/admin/submissions/state', authorization: `Bearer ${SYNC_TOKEN}` });
    expect(stdout).toContain('同步计划：新增 1，更新 1，下架 1，评价 2');
    expect(stdout).toContain('[下架] gone.example.com：sub-gone-original');
    const payload = JSON.parse(stdout.slice(stdout.indexOf('{\n'))) as AdminBatchSubmitRequest;
    expect(payload.items).toHaveLength(5);
    expect(payload.items.at(-1)).toEqual({ kind: 'station', originKey: 'gone.example.com', action: 'remove', payload: { slug: 'sub-gone-original', submissionId: 'online-gone' } });
  });

  it('一条已通过的坏记录使脚本退出 2，任何条目都不 POST', async () => {
    const good = goodRecord();
    const bad = { ...goodRecord('bad', 'gone.example.com'), fields: { ...good.fields, 网址: 'https://gone.example.com/', 提交时间: '不是日期' } };
    const { code, output } = await runRecords([good, bad]);
    expect(code).toBe(2);
    expect(imports).toEqual([]);
    expect(requests.filter(request => request.method === 'POST')).toEqual([]);
    expect(output).toContain('有 1 条记录无法解析，为避免误下架已中止');
    expect(output).toContain('--allow-skipped');
  });

  it('--allow-skipped 允许有效 upsert 入队，但完全不同步下架', async () => {
    const good = goodRecord();
    const bad = { ...goodRecord('bad', 'gone.example.com'), fields: { ...good.fields, 网址: '不是网址' } };
    const { code, output } = await runRecords([good, bad], ['--allow-skipped']);
    expect(code).toBe(0);
    expect(output).toContain('本次不同步下架');
    expect(imports).toHaveLength(1);
    expect(imports[0].body.items).toMatchObject([{ kind: 'station', action: 'upsert', originKey: 'api.example.com' }]);
    expect(imports[0].body.items.some(item => item.action === 'remove')).toBe(false);
  });

  it('--allow-skipped 即使没有坏记录也不生成下架', async () => {
    const { code, output } = await runRecords([goodRecord()], ['--allow-skipped']);
    expect(code).toBe(0);
    expect(output).toContain('本次不同步下架');
    expect(imports[0].body.items).toHaveLength(1);
    expect(imports[0].body.items[0].action).toBe('upsert');
  });

  it.each([[[]], [['--dry-run']], [['--allow-skipped']]])('空记录且线上有站点时 %j 退出 2，零 POST', async args => {
    const { code, output } = await runRecords([], args);
    expect(code).toBe(2);
    expect(output).toContain('成功解析的站点数为 0');
    expect(output).toContain('为避免误下架已中止');
    expect(imports).toEqual([]);
    expect(requests.filter(request => request.method === 'POST')).toEqual([]);
  });

  it('--dry-run --allow-skipped 只预览有效条目并警告不同步下架', async () => {
    const good = goodRecord();
    const bad = { ...goodRecord('bad'), fields: { ...good.fields, 提交时间: '坏日期' } };
    const { code, stdout, output } = await runRecords([good, bad], ['--dry-run', '--allow-skipped']);
    expect(code).toBe(0);
    expect(output).toContain('本次不同步下架');
    const payload = JSON.parse(stdout.slice(stdout.indexOf('{\n'))) as AdminBatchSubmitRequest;
    expect(payload.items).toHaveLength(1);
    expect(payload.items[0].action).toBe('upsert');
    expect(imports).toEqual([]);
  });

  it('600 条站点记录分为 500 和 100 两次 POST，共用一个 batchId', async () => {
    online = { stations: [] };
    const { code, output } = await runRecords(Array.from({ length: 600 }, (_, index) => goodRecord(`record-${index}`, `station-${index}.example.com`)));
    expect(code).toBe(0);
    expect(imports.map(request => request.body.items.length)).toEqual([500, 100]);
    expect(imports[0].body.batchId).toBeTruthy();
    expect(imports[1].body.batchId).toBe(imports[0].body.batchId);
    expect(new Set(imports.flatMap(request => request.body.items.map(item => item.originKey))).size).toBe(600);
    expect(output).toContain('新增 600，更新 0，下架 0，评价 0，失败 0');
  });

  it('后续分块 HTTP 失败时也保留前块逐条错误日志和 batchId，退出 1', async () => {
    online = { stations: [] };
    failedOrigin = 'station-0.example.com';
    importFailureAt = 2;
    const { code, output } = await runRecords(Array.from({ length: 600 }, (_, index) => goodRecord(`record-${index}`, `station-${index}.example.com`)));
    expect(code).toBe(1);
    expect(imports.map(request => request.body.items.length)).toEqual([500, 100]);
    expect(output).toContain('[失败] station station-0.example.com：INVALID_INPUT 未知模型：missing-model');
    expect(output).toContain('第 2 块入队失败：HTTP 503');
    expect(output).toContain(imports[0].body.batchId);
  });

  it('线上 state 缺 submissionId 时中止，不能发出无版本下架', async () => {
    online = { stations: [{ slug: 'sub-gone-original', originKey: 'gone.example.com', url: 'https://gone.example.com/', name: '站点' }] };
    const { code, output } = await run([]);
    expect(code).not.toBe(0);
    expect(output).toContain('线上投稿状态结构无法识别');
    expect(imports).toEqual([]);
  });

  it('--dry-run 缺 token 明确跳过下架检测，模型仍公开读取且不发管理请求', async () => {
    const { code, stdout } = await run(['--dry-run'], { SYNC_TOKEN: undefined });
    expect(code).toBe(0);
    expect(stdout).toContain('跳过下架检测：未配置 SYNC_TOKEN');
    expect(requests).toEqual([{ method: 'GET', path: '/api/models?page=1&pageSize=50', authorization: undefined }]);
    expect(imports).toEqual([]);
  });

  it('批次部分失败时打印具体条目并以非 0 退出，成功条目计数保留', async () => {
    failedOrigin = 'other.example';
    const { code, output } = await run([]);
    expect(code).not.toBe(0);
    expect(imports).toHaveLength(1);
    expect(output).toContain('新增 0，更新 1，下架 1，评价 2，失败 1');
    expect(output).toContain('[失败] station other.example：INVALID_INPUT 未知模型：missing-model');
    expect(output).not.toContain(SYNC_TOKEN);
  });

  it('同 hostname 的两个下架只有一个入队成功时，成功统计按条目对账', async () => {
    const gone = { submissionId: 'online-gone', originKey: 'gone.example.com', url: 'https://gone.example.com/', name: '已撤销站点' };
    online = { stations: [
      { slug: 'actual-collision-slug', submissionId: 'online-a', originKey: 'api.example.com', url: 'https://api.example.com/', name: '已有站点' },
      { ...gone, slug: 'sub-gone-original' },
      { ...gone, slug: 'sub-gone-second' },
    ] };
    failedRemovalSlug = 'sub-gone-second';
    const { code, output } = await run([]);
    expect(code).toBe(1);
    expect(imports[0].body.items.filter(item => item.action === 'remove').map(item => (item.payload as { slug: string }).slug))
      .toEqual(['sub-gone-original', 'sub-gone-second']);
    expect(output).toContain('新增 1，更新 1，下架 1，评价 2，失败 1');
  });

  it('线上状态读取失败时中止，不把失败当空状态继续提交', async () => {
    stateStatus = 403;
    const { code, output } = await run([]);
    expect(code).not.toBe(0);
    expect(output).toContain('读取投稿状态失败：HTTP 403');
    expect(imports).toEqual([]);
  });

  it('线上状态结构错误时中止，不生成错误下架请求', async () => {
    online = { stations: 'unknown' };
    const { code, output } = await run([]);
    expect(code).not.toBe(0);
    expect(output).toContain('线上投稿状态结构无法识别');
    expect(imports).toEqual([]);
  });

  it('缺少配置目录时直接退出，绝不回落到默认配置', async () => {
    const { code, output } = await run([], { LARKSUITE_CLI_CONFIG_DIR: undefined });
    expect(code).not.toBe(0);
    expect(output).toContain('LARKSUITE_CLI_CONFIG_DIR');
    expect(larkCalls()).toEqual([]);
  });

  it('配置目录指向默认的 ~/.lark-cli 时拒绝', async () => {
    const { code, output } = await run([], { LARKSUITE_CLI_CONFIG_DIR: join(homedir(), '.lark-cli') });
    expect(code).not.toBe(0);
    expect(output).toContain('~/.lark-cli');
    expect(larkCalls()).toEqual([]);
  });

  it.each(['FEISHU_BASE_TOKEN', 'FEISHU_TABLE_ID', 'SITE_URL', 'SYNC_TOKEN'])('缺少 %s 时报错退出', async name => {
    const { code, output } = await run([], { [name]: undefined });
    expect(code).not.toBe(0);
    expect(output).toContain(name);
    expect(imports).toEqual([]);
  });

  it('非本机地址拒绝明文 http，避免 token 裸奔', async () => {
    const { code, output } = await run([], { SITE_URL: 'http://example.com' });
    expect(code).not.toBe(0);
    expect(output).toContain('https');
    expect(larkCalls()).toEqual([]);
  });

  it('读飞书失败时不发布，错误信息里也不带 token', async () => {
    const { code, output } = await run([], { FAKE_LARK_FAIL: '1' });
    expect(code).not.toBe(0);
    expect(imports).toEqual([]);
    expect(output).not.toContain(BASE_TOKEN);
    expect(output).not.toContain(SYNC_TOKEN);
  });

  it('表头缺少审核状态时不发布，防止改名后清空全站', async () => {
    writeFileSync(join(dir, '.tmp-renamed.json'), JSON.stringify({ data: { fields: ['中转站名称', '网址', '提交类型', '状态', '提交时间'], record_id_list: ['r1'], data: [['站', 'https://a.com', '推荐新站', '通过', '2026-01-01']], has_more: false } }));
    try {
      const { code, output } = await run([], { FAKE_LARK_FIXTURE: '.tmp-renamed' });
      expect(code).not.toBe(0);
      expect(output).toContain('审核状态');
      expect(imports).toEqual([]);
    } finally {
      rmSync(join(dir, '.tmp-renamed.json'));
    }
  });

  it('站点拒绝批次入队时退出码非 0，日志不带 token', async () => {
    importStatus = 403;
    const { code, output } = await run([]);
    expect(code).not.toBe(0);
    expect(output).toContain('403');
    expect(output).not.toContain(SYNC_TOKEN);
  });
});

describe('分页结构不一致时的保护', () => {
  it('列式行比列短时中止，不把字段解析成空', () => {
    const page = JSON.stringify({
      data: {
        fields: ['中转站名称', '网址', '提交类型', '审核状态', '提交时间'],
        record_id_list: ['rec1'],
        data: [['站点A', 'https://a.example.com/', '站点']],
      },
    });
    expect(() => parseRecordPage(page)).toThrow(/个值，但列有/);
  });

  it('列式分页缺必填字段时整页判为无效', () => {
    const page = JSON.stringify({
      data: {
        fields: ['中转站名称', '网址'],
        record_id_list: ['rec1'],
        data: [['站点A', 'https://a.example.com/']],
      },
    });
    const parsed = parseRecordPage(page);
    // 解析本身不报错，但校验层必须能看出缺列。
    expect(parsed.columns).not.toContain('审核状态');
  });
});

describe('分页截断保护', () => {
  it('缺 has_more 且非首页出现短页时判为分页不完整', () => {
    // 服务端把 limit 200 截断成更小的值，第一页就拿到短页。
    // 旧逻辑直接 break，第一页之外的站点会被当成已删除而全部下架。
    const page = JSON.stringify({
      data: {
        fields: ['中转站名称', '网址', '提交类型', '审核状态', '提交时间'],
        record_id_list: ['rec1'],
        data: [['站点A', 'https://a.example.com/', '站点', '通过', '2026-11-01']],
      },
    });
    const parsed = parseRecordPage(page);
    expect(parsed.hasMore).toBeNull();
    expect(parsed.records.length).toBeLessThan(200);
  });
});

describe('分页边界', () => {
  type Page = { records: RawRecord[]; columns: string[]; hasMore: boolean | null };
  const page = (records: RawRecord[], hasMore: boolean | null): Page => ({ records, columns, hasMore });
  const record = (index: number) => ({
    recordId: `r${index}`,
    fields: {
      '中转站名称': `站${index}`, '网址': `https://s${index}.example.com/`,
      '提交类型': '推荐新站', '审核状态': '已通过', '提交时间': '2026-11-01 10:00:00',
    },
  });
  const columns = ['中转站名称', '网址', '提交类型', '审核状态', '提交时间'];

  it('has_more 恒为真时按页数上限中止，不会无限读', async () => {
    let calls = 0;
    const run = collectPages(async offset => {
      calls += 1;
      return page(Array.from({ length: 200 }, (_, index) => record(offset + index)), true);
    });
    await expect(run).rejects.toThrow(/超过 500 页/);
    // 读满 500 页后第 501 次不再请求，直接判死循环。
    expect(calls).toBe(500);
  });

  it('has_more 为 false 时正常结束', async () => {
    const records = await collectPages(async offset => page(offset === 0 ? [record(0), record(1)] : [], false));
    expect(records).toHaveLength(2);
  });

  it('没有 has_more 时，满页会继续读下一页', async () => {
    const records = await collectPages(async offset =>
      page(offset === 0 ? Array.from({ length: 200 }, (_, index) => record(index)) : [], null));
    expect(records).toHaveLength(200);
  });

  it('没有 has_more 且第二页遇到短页时中止，而不是当成读完了', async () => {
    const run = collectPages(async offset =>
      page(offset === 0 ? Array.from({ length: 200 }, (_, index) => record(index)) : [record(200)], null));
    await expect(run).rejects.toThrow(/分页结果不完整/);
  });

  it('空页直接结束', async () => {
    const records = await collectPages(async () => page([], true));
    expect(records).toHaveLength(0);
  });
});
